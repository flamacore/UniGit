import type { CommitGraphOrder, CommitGraphScope } from "../../features/repositories/api";
import type { ChangeSortKey } from "../types";

export type BranchFilterMode = "all" | "committed" | "created";

export type HorizontalFractions = {
  left: number;
  right: number;
};

export type VerticalFractions = {
  top: number;
  bottom: number;
};

export type UiSettings = {
  branchFilterMode: BranchFilterMode;
  graphScope: CommitGraphScope;
  graphOrder: CommitGraphOrder;
  pairMetaFiles: boolean;
  showPaths: boolean;
  sortBy: ChangeSortKey;
  sortDirection: "asc" | "desc";
  panelFractions: HorizontalFractions;
  graphFractions: HorizontalFractions;
  stackFractions: VerticalFractions;
  inspectorFractions: VerticalFractions;
  commitGraphLaneScale: number;
  commitGraphLaneCropWidth: number;
};

const UI_SETTINGS_STORAGE_KEY = "unigit.ui-settings";

export const defaultUiSettings: UiSettings = {
  branchFilterMode: "all",
  graphScope: "all",
  graphOrder: "date",
  pairMetaFiles: true,
  showPaths: true,
  sortBy: "name",
  sortDirection: "asc",
  panelFractions: { left: 0.6, right: 0.4 },
  graphFractions: { left: 0.26, right: 0.74 },
  stackFractions: { top: 0.48, bottom: 0.52 },
  inspectorFractions: { top: 0.68, bottom: 0.32 },
  commitGraphLaneScale: 0.55,
  commitGraphLaneCropWidth: 220,
};

const clamp = (value: number, min: number, max: number) => {
  return Math.min(max, Math.max(min, value));
};

const normalizeHorizontalFractions = (value: unknown, defaults: HorizontalFractions): HorizontalFractions => {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const leftValue = Number((value as Partial<HorizontalFractions>).left);
  const rightValue = Number((value as Partial<HorizontalFractions>).right);

  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue) || leftValue <= 0 || rightValue <= 0) {
    return defaults;
  }

  const sum = leftValue + rightValue;

  if (!Number.isFinite(sum) || sum <= 0) {
    return defaults;
  }

  const left = clamp(leftValue / sum, 0.05, 0.95);

  return {
    left,
    right: 1 - left,
  };
};

const normalizeVerticalFractions = (value: unknown, defaults: VerticalFractions): VerticalFractions => {
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const topValue = Number((value as Partial<VerticalFractions>).top);
  const bottomValue = Number((value as Partial<VerticalFractions>).bottom);

  if (!Number.isFinite(topValue) || !Number.isFinite(bottomValue) || topValue <= 0 || bottomValue <= 0) {
    return defaults;
  }

  const sum = topValue + bottomValue;

  if (!Number.isFinite(sum) || sum <= 0) {
    return defaults;
  }

  const top = clamp(topValue / sum, 0.05, 0.95);

  return {
    top,
    bottom: 1 - top,
  };
};

const normalizeLaneScale = (value: unknown) => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultUiSettings.commitGraphLaneScale;
  }

  return clamp(numericValue, 0.45, 1.2);
};

const normalizeLaneCropWidth = (value: unknown) => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultUiSettings.commitGraphLaneCropWidth;
  }

  return Math.round(clamp(numericValue, 120, 520));
};

export const loadUiSettings = (): UiSettings => {
  if (typeof window === "undefined") {
    return defaultUiSettings;
  }

  try {
    const raw = window.localStorage.getItem(UI_SETTINGS_STORAGE_KEY);

    if (!raw) {
      return defaultUiSettings;
    }

    const parsed = JSON.parse(raw) as Partial<UiSettings>;

    return {
      branchFilterMode: parsed.branchFilterMode === "committed" || parsed.branchFilterMode === "created"
        ? parsed.branchFilterMode
        : "all",
      graphScope: parsed.graphScope === "current" || parsed.graphScope === "local" ? parsed.graphScope : "all",
      graphOrder: parsed.graphOrder === "topo" || parsed.graphOrder === "author-date" ? parsed.graphOrder : "date",
      pairMetaFiles: typeof parsed.pairMetaFiles === "boolean" ? parsed.pairMetaFiles : defaultUiSettings.pairMetaFiles,
      showPaths: typeof parsed.showPaths === "boolean" ? parsed.showPaths : defaultUiSettings.showPaths,
      sortBy: parsed.sortBy === "folder" || parsed.sortBy === "extension" || parsed.sortBy === "status"
        ? parsed.sortBy
        : "name",
      sortDirection: parsed.sortDirection === "desc" ? "desc" : "asc",
      panelFractions: normalizeHorizontalFractions(parsed.panelFractions, defaultUiSettings.panelFractions),
      graphFractions: normalizeHorizontalFractions(parsed.graphFractions, defaultUiSettings.graphFractions),
      stackFractions: normalizeVerticalFractions(parsed.stackFractions, defaultUiSettings.stackFractions),
      inspectorFractions: normalizeVerticalFractions(parsed.inspectorFractions, defaultUiSettings.inspectorFractions),
      commitGraphLaneScale: normalizeLaneScale(parsed.commitGraphLaneScale),
      commitGraphLaneCropWidth: normalizeLaneCropWidth(parsed.commitGraphLaneCropWidth),
    };
  } catch {
    return defaultUiSettings;
  }
};

export const persistUiSettings = (settings: UiSettings) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(UI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
};