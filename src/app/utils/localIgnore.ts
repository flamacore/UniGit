import type { LocalIgnoreMap } from "../types";

const LOCAL_IGNORE_STORAGE_KEY = "unigit.localIgnore";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
};

const isLocalIgnoreMap = (value: unknown): value is LocalIgnoreMap => {
  if (!isPlainObject(value)) {
    return false;
  }

  return Object.values(value).every((entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"));
};

export const loadLocalIgnoreMap = (): LocalIgnoreMap => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_IGNORE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as unknown;
    return isLocalIgnoreMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const persistLocalIgnoreMap = (value: LocalIgnoreMap) => {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(LOCAL_IGNORE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Local persistence is optional and should never break the UI.
  }
};