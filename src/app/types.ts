import type { BranchEntry, FileChange } from "../features/repositories/api";

export type ChangeSortKey = "name" | "folder" | "extension" | "status";

export type ChangeListOptions = {
  query: string;
  showPaths: boolean;
  sortBy: ChangeSortKey;
  sortDirection: "asc" | "desc";
};

export type ChangeListItem = {
  change: FileChange;
  isMeta: boolean;
  fileName: string;
  parentPath: string;
  selectionKey: string;
  hiddenKey: string;
  actionPaths: string[];
  pairedMeta: {
    path: string;
    marker: {
      tone: string;
      label: string;
    };
    statusText: string;
  } | null;
  marker: {
    tone: string;
    label: string;
  };
};

export type LocalIgnoreMap = Record<string, string[]>;

export type HiddenLocalEntry = {
  key: string;
  label: string;
};

export type RemoteDialogState = {
  tone: "error" | "info";
  title: string;
  summary: string;
  detail?: string;
};

export type AppErrorState = {
  title: string;
  summary: string;
  detail: string;
  occurredAt: string;
  logPath?: string | null;
  repoPath?: string | null;
  recoveryAction?: {
    kind: "clear-index-lock";
    label: string;
    description: string;
  } | null;
};

export type BranchContextMenuState = {
  branch: BranchEntry;
  x: number;
  y: number;
  renameValue: string;
  renameMode: boolean;
};

export type BranchTreeNode = {
  id: string;
  label: string;
  branch: BranchEntry | null;
  children: BranchTreeNode[];
};

export type ChangeContextMenuState = {
  item: ChangeListItem;
  lane: "staged" | "unstaged";
  x: number;
  y: number;
};

export type HiddenLocalContextMenuState = {
  entry: HiddenLocalEntry;
  x: number;
  y: number;
};