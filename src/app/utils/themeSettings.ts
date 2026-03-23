export type ThemePresetId = "dark" | "light" | "liquid-glass";
export type ThemeId = ThemePresetId | "custom";

export type ThemeSettings = {
  selectedThemeId: ThemeId;
  customThemeName: string;
  customBaseThemeId: ThemePresetId;
  customVariablesText: string;
};

export type ThemeOption = {
  id: ThemeId;
  label: string;
  description: string;
};

const THEME_SETTINGS_STORAGE_KEY = "unigit.theme-settings";

export const themeOptions: ThemeOption[] = [
  {
    id: "dark",
    label: "Dark",
    description: "The current UniGit dark look with blue-cyan accents.",
  },
  {
    id: "light",
    label: "Light",
    description: "A brighter neutral theme with stronger daylight contrast.",
  },
  {
    id: "liquid-glass",
    label: "Liquid Glass",
    description: "A translucent Apple-inspired glass treatment with bright, frosted surfaces.",
  },
  {
    id: "custom",
    label: "Custom",
    description: "Apply your own CSS variable overrides on top of a built-in base theme.",
  },
];

export const presetThemeOptions = themeOptions.filter((option): option is ThemeOption & { id: ThemePresetId } => option.id !== "custom");

export const defaultThemeSettings: ThemeSettings = {
  selectedThemeId: "dark",
  customThemeName: "My theme",
  customBaseThemeId: "dark",
  customVariablesText: "{\n  \"--accent\": \"#79a4ff\",\n  \"--accent-2\": \"#48d3c5\"\n}",
};

export const loadThemeSettings = (): ThemeSettings => {
  if (typeof window === "undefined") {
    return defaultThemeSettings;
  }

  try {
    const raw = window.localStorage.getItem(THEME_SETTINGS_STORAGE_KEY);

    if (!raw) {
      return defaultThemeSettings;
    }

    const parsed = JSON.parse(raw) as Partial<ThemeSettings>;
    const selectedThemeId = parsed.selectedThemeId === "light"
      || parsed.selectedThemeId === "liquid-glass"
      || parsed.selectedThemeId === "custom"
      ? parsed.selectedThemeId
      : "dark";
    const customBaseThemeId = parsed.customBaseThemeId === "light"
      || parsed.customBaseThemeId === "liquid-glass"
      ? parsed.customBaseThemeId
      : "dark";

    return {
      selectedThemeId,
      customThemeName: typeof parsed.customThemeName === "string" && parsed.customThemeName.trim()
        ? parsed.customThemeName
        : defaultThemeSettings.customThemeName,
      customBaseThemeId,
      customVariablesText: typeof parsed.customVariablesText === "string"
        ? parsed.customVariablesText
        : defaultThemeSettings.customVariablesText,
    };
  } catch {
    return defaultThemeSettings;
  }
};

export const persistThemeSettings = (settings: ThemeSettings) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(THEME_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

export const resolveThemePresetId = (settings: ThemeSettings): ThemePresetId => {
  return settings.selectedThemeId === "custom" ? settings.customBaseThemeId : settings.selectedThemeId;
};

export const parseCustomThemeVariables = (settings: ThemeSettings): Record<string, string> => {
  if (settings.selectedThemeId !== "custom") {
    return {};
  }

  const trimmed = settings.customVariablesText.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => key.startsWith("--") && (typeof value === "string" || typeof value === "number"))
        .map(([key, value]) => [key, String(value)]),
    );
  } catch {
    return {};
  }
};

export const getThemeSettingsValidationError = (settings: ThemeSettings) => {
  if (settings.selectedThemeId !== "custom") {
    return null;
  }

  const trimmed = settings.customVariablesText.trim();
  if (!trimmed) {
    return "Add a JSON object of CSS variable overrides, or switch back to a built-in theme.";
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return "Custom theme overrides must be a JSON object of CSS variables.";
    }

    const invalidEntry = Object.entries(parsed).find(([key, value]) => !key.startsWith("--") || (typeof value !== "string" && typeof value !== "number"));
    if (invalidEntry) {
      return "Custom theme overrides must use CSS variable names like --accent and string or numeric values.";
    }

    return null;
  } catch {
    return "Custom theme overrides must be valid JSON.";
  }
};