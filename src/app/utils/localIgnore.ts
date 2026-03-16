import type { LocalIgnoreMap } from "../types";

const LOCAL_IGNORE_STORAGE_KEY = "unigit.localIgnore";

export const loadLocalIgnoreMap = (): LocalIgnoreMap => {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_IGNORE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as LocalIgnoreMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export const persistLocalIgnoreMap = (value: LocalIgnoreMap) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(LOCAL_IGNORE_STORAGE_KEY, JSON.stringify(value));
};