import { invoke } from "@tauri-apps/api/core";

export type FileChange = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
  untracked: boolean;
  ignored: boolean;
  stagedModified: boolean;
  displayStatus: string;
};

export type RepositoryCounts = {
  staged: number;
  unstaged: number;
  conflicted: number;
  untracked: number;
  ignored: number;
  stagedModified: number;
};

export type RepositorySnapshot = {
  repoPath: string;
  repoName: string;
  currentBranch: string;
  detachedHead: boolean;
  ahead: number;
  behind: number;
  lastRefreshedAt: string;
  files: FileChange[];
  counts: RepositoryCounts;
};

export type CommitSummary = {
  hash: string;
  shortHash: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  decorations: string;
};

export type CommitGraphRow = CommitSummary & {
  parentHashes: string[];
  displayBranch: string;
  lane: number;
  activeLanes: number[];
  mergeCommit: boolean;
};

export type CommitGraphPage = {
  rows: CommitGraphRow[];
  hasMore: boolean;
  nextSkip: number;
};

export type FilePreview = {
  relativePath: string;
  fileName: string;
  extension: string;
  previewKind: "image" | "text" | "asset" | "binary";
  mimeType: string;
  fileSizeBytes: number;
  modifiedAt: number | null;
  imageDataUrl: string | null;
  textExcerpt: string | null;
  stagedDiff: string | null;
  unstagedDiff: string | null;
  assetSummary: AssetSummary | null;
  supportHint: string;
};

export type AssetSummary = {
  assetKind: string;
  pipelineState: string;
  details: AssetDetail[];
};

export type AssetDetail = {
  label: string;
  value: string;
};

export const inspectRepository = (repoPath: string) => {
  return invoke<RepositorySnapshot>("inspect_repository", { repoPath });
};

export const listCommitHistory = (repoPath: string, limit = 40) => {
  return invoke<CommitSummary[]>("list_commit_history", { repoPath, limit });
};

export const listCommitGraph = (repoPath: string, limit = 240, skip = 0) => {
  return invoke<CommitGraphPage>("list_commit_graph", { repoPath, limit, skip });
};

export const stageFiles = (repoPath: string, paths: string[]) => {
  return invoke<void>("stage_files", { repoPath, paths });
};

export const unstageFiles = (repoPath: string, paths: string[]) => {
  return invoke<void>("unstage_files", { repoPath, paths });
};

export const createCommit = (repoPath: string, message: string) => {
  return invoke<void>("create_commit", { repoPath, message });
};

export const inspectFilePreview = (repoPath: string, relativePath: string) => {
  return invoke<FilePreview>("inspect_file_preview", { repoPath, relativePath });
};
