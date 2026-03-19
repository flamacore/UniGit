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

export type RepositoryRemote = {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
};

export type RepositorySshSettings = {
  mode: "auto" | "openssh" | "putty" | string;
  useUserSshConfig: boolean;
  privateKeyPath: string | null;
  username: string | null;
  password: string | null;
};

export type RepositorySshKeyOption = {
  path: string;
  label: string;
  keyKind: "openssh" | "putty" | string;
};

export type RepositorySshConfigHost = {
  alias: string;
  hostName: string | null;
  user: string | null;
  identityFiles: string[];
  identitiesOnly: boolean;
};

export type RepositorySshDiscovery = {
  sshDirectory: string | null;
  userConfigPath: string | null;
  configHosts: RepositorySshConfigHost[];
  privateKeys: RepositorySshKeyOption[];
  openSshCommand: string | null;
  puttyCommand: string | null;
  pageantSupported: boolean;
};

export type RepositoryConfig = {
  repoPath: string;
  repoName: string;
  currentBranch: string;
  detachedHead: boolean;
  remotes: RepositoryRemote[];
  sshSettings: RepositorySshSettings;
  sshDiscovery: RepositorySshDiscovery;
};

export type CloneResult = {
  repoPath: string;
  repoName: string;
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

export type CommitGraphScope = "current" | "local" | "all";
export type CommitGraphOrder = "date" | "topo" | "author-date";

export type BranchEntry = {
  fullName: string;
  name: string;
  branchKind: "local" | "remote";
  remoteName: string | null;
  trackingName: string | null;
  trackingState: string | null;
  isCurrent: boolean;
  commitHash: string;
  subject: string;
};

export type MergeBranchResult = {
  status: "merged" | "conflicts";
  message: string;
  conflictedFiles: string[];
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

export type CommitMessageContext = {
  currentBranch: string;
  stagedFiles: string[];
  stagedDiff: string;
  unpushedCommits: string[];
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
  previewKind: "image" | "text" | "asset" | "binary" | "material" | "model";
  mimeType: string;
  fileSizeBytes: number;
  modifiedAt: number | null;
  imageDataUrl: string | null;
  textExcerpt: string | null;
  stagedDiff: string | null;
  unstagedDiff: string | null;
  assetSummary: AssetSummary | null;
  imageSources: ImagePreviewSource[];
  imageComparisonPresets: ImageComparisonPreset[];
  defaultImageComparisonPresetKey: string | null;
  unityMaterialSources: UnityMaterialPreviewSource[];
  unityMaterialComparisonPresets: ImageComparisonPreset[];
  defaultUnityMaterialComparisonPresetKey: string | null;
  modelSources: ModelPreviewSource[];
  modelComparisonPresets: ImageComparisonPreset[];
  defaultModelComparisonPresetKey: string | null;
  supportHint: string;
};

export type ImagePreviewSource = {
  key: string;
  label: string;
  sourceKind: "workingTree" | "staged" | "head" | string;
  mimeType: string;
  byteSize: number;
  encodedBytesBase64: string;
  isPsd: boolean;
};

export type ImageComparisonPreset = {
  key: string;
  label: string;
  leftSourceKey: string;
  rightSourceKey: string;
  description: string;
};

export type UnityMaterialPreviewSource = {
  key: string;
  label: string;
  sourceKind: "workingTree" | "staged" | "head" | string;
  materialName: string;
  shaderLabel: string;
  shaderFamily: "lit" | "unlit" | "custom" | string;
  surfaceKind: "opaque" | "transparent" | "unlit" | string;
  baseColor: UnityColorValue | null;
  emissionColor: UnityColorValue | null;
  metallic: number | null;
  smoothness: number | null;
  cutoff: number | null;
  previewShapeHint: "sphere" | "box" | "cylinder" | string;
  notes: string[];
  textures: UnityMaterialTexturePreview[];
  baseTextureKey: string | null;
  normalTextureKey: string | null;
  emissionTextureKey: string | null;
};

export type UnityMaterialTexturePreview = {
  key: string;
  propertyName: string;
  label: string;
  relativePath: string;
  mimeType: string;
  encodedBytesBase64: string;
  isPsd: boolean;
};

export type UnityColorValue = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type ModelPreviewSource = {
  key: string;
  label: string;
  sourceKind: "workingTree" | "staged" | "head" | string;
  format: "fbx" | "obj" | "gltf" | "glb" | "blend" | string;
  relativePath: string;
  mimeType: string;
  encodedBytesBase64: string;
  assetLabel: string;
  notes: string[];
  externalResources: ModelPreviewResource[];
};

export type ModelPreviewResource = {
  uri: string;
  mimeType: string;
  encodedBytesBase64: string;
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

export const inspectRepositoryConfig = (repoPath: string) => {
  return invoke<RepositoryConfig>("inspect_repository_config", { repoPath });
};

export const cloneRepository = (remoteUrl: string, destinationPath: string) => {
  return invoke<CloneResult>("clone_repository", { remoteUrl, destinationPath });
};

export const saveRepositoryRemote = (
  repoPath: string,
  originalName: string | null,
  name: string,
  fetchUrl: string,
  pushUrl?: string,
) => {
  return invoke<RepositoryRemote>("save_repository_remote", {
    repoPath,
    originalName,
    name,
    fetchUrl,
    pushUrl,
  });
};

export const deleteRepositoryRemote = (repoPath: string, name: string) => {
  return invoke<string>("delete_repository_remote", { repoPath, name });
};

export const saveRepositorySshSettings = (repoPath: string, settings: RepositorySshSettings) => {
  return invoke<RepositorySshSettings>("save_repository_ssh_settings", { repoPath, settings });
};

export const listCommitHistory = (repoPath: string, limit = 40) => {
  return invoke<CommitSummary[]>("list_commit_history", { repoPath, limit });
};

export const listCommitGraph = (
  repoPath: string,
  limit = 240,
  skip = 0,
  graphScope: CommitGraphScope = "all",
  graphOrder: CommitGraphOrder = "date",
) => {
  return invoke<CommitGraphPage>("list_commit_graph", { repoPath, limit, skip, graphScope, graphOrder });
};

export const inspectCommitDetail = (repoPath: string, commitHash: string) => {
  return invoke<CommitDetail>("inspect_commit_detail", { repoPath, commitHash });
};

export const inspectCommitMessageContext = (repoPath: string) => {
  return invoke<CommitMessageContext>("inspect_commit_message_context", { repoPath });
};

export const listBranches = (repoPath: string) => {
  return invoke<BranchEntry[]>("list_branches", { repoPath });
};

export const switchBranch = (repoPath: string, fullName: string) => {
  return invoke<string>("switch_branch", { repoPath, fullName });
};

export const forceSwitchBranch = (repoPath: string, fullName: string) => {
  return invoke<string>("force_switch_branch", { repoPath, fullName });
};

export const createBranch = (repoPath: string, name: string, startPoint?: string, discardChanges = false) => {
  return invoke<string>("create_branch", { repoPath, name, startPoint, discardChanges });
};

export const renameBranch = (repoPath: string, currentName: string, nextName: string) => {
  return invoke<string>("rename_branch", { repoPath, currentName, nextName });
};

export const deleteBranch = (repoPath: string, fullName: string) => {
  return invoke<string>("delete_branch", { repoPath, fullName });
};

export const mergeBranch = (repoPath: string, fullName: string, discardLocalChanges = false) => {
  return invoke<MergeBranchResult>("merge_branch", { repoPath, fullName, discardLocalChanges });
};

export const resolveConflictedFiles = (repoPath: string, paths: string[], strategy: "ours" | "theirs") => {
  return invoke<string>("resolve_conflicted_files", { repoPath, paths, strategy });
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

export const fetchRepository = (repoPath: string) => {
  return invoke<string>("fetch_repository", { repoPath });
};

export const pullRepository = (repoPath: string) => {
  return invoke<string>("pull_repository", { repoPath });
};

export const forcePullRepository = (repoPath: string) => {
  return invoke<string>("force_pull_repository", { repoPath });
};

export const logClientEvent = (scope: string, message: string, detail?: string) => {
  return invoke<void>("log_client_event", { scope, message, detail });
};

export const getLogFilePath = () => {
  return invoke<string>("get_log_file_path");
};

export const clearGitIndexLock = (repoPath: string) => {
  return invoke<string>("clear_git_index_lock", { repoPath });
};

export const stageFiles = (repoPath: string, paths: string[]) => {
  return invoke<void>("stage_files", { repoPath, paths });
};

export const unstageFiles = (repoPath: string, paths: string[]) => {
  return invoke<void>("unstage_files", { repoPath, paths });
};

export const discardPaths = (repoPath: string, paths: string[]) => {
  return invoke<void>("discard_paths", { repoPath, paths });
};

export const addPathsToGitignore = (repoPath: string, paths: string[]) => {
  return invoke<void>("add_paths_to_gitignore", { repoPath, paths });
};

export const createCommit = (repoPath: string, message: string) => {
  return invoke<void>("create_commit", { repoPath, message });
};

export const inspectFilePreview = (repoPath: string, relativePath: string) => {
  return invoke<FilePreview>("inspect_file_preview", { repoPath, relativePath });
};
