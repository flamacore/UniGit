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

export type CommitFileEntry = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

export type CommitDetail = {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committedAt: string;
  subject: string;
  body: string;
  decorations: string;
  files: CommitFileEntry[];
};

export type FileHistoryEntry = {
  hash: string;
  shortHash: string;
  authorName: string;
  authoredAt: string;
  subject: string;
  decorations: string;
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

export const inspectCommitDetail = (repoPath: string, commitHash: string) => {
  return invoke<CommitDetail>("inspect_commit_detail", { repoPath, commitHash });
};

export const listFileHistory = (repoPath: string, relativePath: string, limit = 20) => {
  return invoke<FileHistoryEntry[]>("list_file_history", { repoPath, relativePath, limit });
};

export const exportFileFromCommit = (
  repoPath: string,
  commitHash: string,
  relativePath: string,
  destinationPath: string,
) => {
  return invoke<void>("export_file_from_commit", {
    repoPath,
    commitHash,
    relativePath,
    destinationPath,
  });
};

export const restoreFileFromCommit = (
  repoPath: string,
  commitHash: string,
  relativePath: string,
) => {
  return invoke<void>("restore_file_from_commit", {
    repoPath,
    commitHash,
    relativePath,
  });
};

export const applyCommitFilePatch = (
  repoPath: string,
  commitHash: string,
  relativePath: string,
  reverse: boolean,
) => {
  return invoke<void>("apply_commit_file_patch", {
    repoPath,
    commitHash,
    relativePath,
    reverse,
  });
};

export const pushRepository = (repoPath: string) => {
  return invoke<string>("push_repository", { repoPath });
};

export const forcePullRepository = (repoPath: string) => {
  return invoke<string>("force_pull_repository", { repoPath });
};

export const logClientEvent = (scope: string, message: string, detail?: string) => {
  return invoke<void>("log_client_event", { scope, message, detail });
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
