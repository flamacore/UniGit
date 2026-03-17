export type AiProvider = "none" | "ollama" | "openai" | "claude";

export type AiSettings = {
  provider: AiProvider;
  ollamaEndpoint: string;
  ollamaModel: string;
  openAiApiKey: string;
  claudeApiKey: string;
  requestTimeoutSeconds: number;
};

const AI_SETTINGS_STORAGE_KEY = "unigit.ai-settings";

export const defaultAiSettings: AiSettings = {
  provider: "none",
  ollamaEndpoint: "http://127.0.0.1:11434",
  ollamaModel: "llama3.1",
  openAiApiKey: "",
  claudeApiKey: "",
  requestTimeoutSeconds: 30,
};

const normalizeTimeoutSeconds = (value: unknown) => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultAiSettings.requestTimeoutSeconds;
  }

  return Math.min(300, Math.max(5, Math.round(numericValue)));
};

export const loadAiSettings = (): AiSettings => {
  if (typeof window === "undefined") {
    return defaultAiSettings;
  }

  try {
    const raw = window.localStorage.getItem(AI_SETTINGS_STORAGE_KEY);

    if (!raw) {
      return defaultAiSettings;
    }

    const parsed = JSON.parse(raw) as Partial<AiSettings>;

    return {
      provider: parsed.provider === "ollama" || parsed.provider === "openai" || parsed.provider === "claude" ? parsed.provider : "none",
      ollamaEndpoint: typeof parsed.ollamaEndpoint === "string" && parsed.ollamaEndpoint.trim() ? parsed.ollamaEndpoint : defaultAiSettings.ollamaEndpoint,
      ollamaModel: typeof parsed.ollamaModel === "string" && parsed.ollamaModel.trim() ? parsed.ollamaModel : defaultAiSettings.ollamaModel,
      openAiApiKey: typeof parsed.openAiApiKey === "string" ? parsed.openAiApiKey : "",
      claudeApiKey: typeof parsed.claudeApiKey === "string" ? parsed.claudeApiKey : "",
      requestTimeoutSeconds: normalizeTimeoutSeconds(parsed.requestTimeoutSeconds),
    };
  } catch {
    return defaultAiSettings;
  }
};

export const persistAiSettings = (settings: AiSettings) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};

export const getAiSettingsValidationError = (settings: AiSettings) => {
  switch (settings.provider) {
    case "none":
      return "Configure AI commit messages in Settings first.";
    case "ollama":
      if (!settings.ollamaEndpoint.trim()) {
        return "Set the Ollama endpoint in Settings first.";
      }
      if (!settings.ollamaModel.trim()) {
        return "Set the Ollama model in Settings first.";
      }
      return null;
    case "openai":
      return settings.openAiApiKey.trim() ? null : "Set the OpenAI API key in Settings first.";
    case "claude":
      return settings.claudeApiKey.trim() ? null : "Set the Claude API key in Settings first.";
    default:
      return "Configure AI commit messages in Settings first.";
  }
};