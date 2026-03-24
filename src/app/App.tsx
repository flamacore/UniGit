import { open, save } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  Expand,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  Minimize2,
  RefreshCw,
  Sparkles,
  Settings2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { Suspense, lazy, type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BranchPane } from "./components/BranchPane";
import { BranchCreateDialog } from "./components/BranchCreateDialog";
import { BranchDeleteDialog } from "./components/BranchDeleteDialog";
import { BranchPruneDialog, type BranchPruneDialogValue } from "./components/BranchPruneDialog";
import { CommitGraphCanvas } from "./CommitGraphCanvas";
import { ConflictResolutionDialog } from "./components/ConflictResolutionDialog";
import { DropLane } from "./components/DropLane";
import { ErrorDetailDialog } from "./components/ErrorDetailDialog";
import { MergeDiscardDialog } from "./components/MergeDiscardDialog";
import { useChangeWorkbench } from "./hooks/useChangeWorkbench";
import { HiddenLocalDialog } from "./components/HiddenLocalDialog";
import { RemoteDetailDialog } from "./components/RemoteDetailDialog";
import { RepoManagerDialog } from "./components/RepoManagerDialog";
import type {
  AppErrorState,
  ChangeSortKey,
  RemoteDialogState,
} from "./types";
import {
  describeRemoteFailure,
  getDiffLineClassName,
  getStatusTone,
  hasDiffContent,
} from "./utils/changeList";
import { formatFileSize, formatRelativeTime, formatRepoLabel, formatUnixTimestamp } from "./utils/formatters";
import {
  addPathsToGitignore,
  applyCommitFilePatch,
  BranchEntry,
  ConditionalBranchPruneInput,
  CloneResult,
  CommitDetail,
  CommitGraphOrder,
  CommitGraphPage,
  CommitGraphRow,
  CommitGraphScope,
  FileChange,
  FileHistoryEntry,
  FilePreview,
  RepositoryConfig,
  RepositorySshSettings,
  RepositorySnapshot,
  cloneRepository,
  clearGitIndexLock,
  createBranch,
  createCommit,
  discardPaths,
  deleteRepositoryRemote,
  deleteBranch,
  conditionalPruneBranches,
  exportFileFromCommit,
  fetchRepository,
  forceSwitchBranch,
  forcePullRepository,
  hardPruneLocalBranches,
  inspectCommitDetail,
  inspectCommitMessageContext,
  inspectFilePreview,
  inspectRepository,
  inspectRepositoryConfig,
  getLogFilePath,
  listBranches,
  listFileHistory,
  listCommitGraph,
  logClientEvent,
  mergeBranch,
  MergeBranchResult,
  pullRepository,
  pullBranch,
  pushRepository,
  renameBranch,
  restoreFileFromCommit,
  saveRepositoryRemote,
  saveRepositorySshSettings,
  resolveConflictedFiles,
  stageFiles,
  switchBranch,
  unstageFiles,
} from "../features/repositories/api";
import { useRepositoryStore } from "../features/repositories/store/useRepositoryStore";
import { isTauri } from "../lib/tauri";
import { generateAiCommitMessage } from "./utils/aiCommitMessage";
import { getAiSettingsValidationError, loadAiSettings, persistAiSettings, type AiSettings } from "./utils/aiSettings";
import {
  getThemeSettingsValidationError,
  loadThemeSettings,
  parseCustomThemeVariables,
  persistThemeSettings,
  resolveThemePresetId,
  type ThemeSettings,
} from "./utils/themeSettings";

type BranchDeleteDialogState = {
  branch: BranchEntry;
  deleteRemote: boolean;
  remoteFullName: string | null;
  remoteLabel: string | null;
};

type MergeDiscardDialogState = {
  branchFullName: string;
  branchLabel: string;
};

type MergeConflictState = {
  branchFullName: string;
  branchLabel: string;
  conflictedFiles: string[];
};

const createDefaultBranchPruneDialogValue = (): BranchPruneDialogValue => ({
  ageEnabled: false,
  ageValue: "90",
  ageUnit: "days",
  mergedEnabled: false,
  mergedIntoMain: true,
  mergedIntoMaster: true,
  mergedIntoDev: true,
  folderEnabled: false,
  folderPrefixesText: "feature, task, bug",
  regexEnabled: false,
  regexPattern: "^(feature|task|bug)/",
  target: "both",
});

const buildRemoteBranchRef = (trackingName: string | null) => {
  return trackingName ? `refs/remotes/${trackingName}` : null;
};

const ImagePreviewCompare = lazy(async () => ({
  default: (await import("./components/ImagePreviewCompare")).ImagePreviewCompare,
}));

const UnityMaterialPreviewCompare = lazy(async () => ({
  default: (await import("./components/UnityMaterialPreviewCompare")).UnityMaterialPreviewCompare,
}));

const ModelPreviewCompare = lazy(async () => ({
  default: (await import("./components/ModelPreviewCompare")).ModelPreviewCompare,
}));

const isMergeOverwriteError = (message: string) => {
  const normalized = message.toLowerCase();
  return normalized.includes("would be overwritten by merge")
    || normalized.includes("please commit your changes or stash them before you merge");
};

const resolveBranchNameFromRef = (fullName: string) => {
  return fullName
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
};

const extractCommitRefCandidates = (...sources: Array<string | null | undefined>) => {
  return Array.from(new Set(
    sources
      .flatMap((source) => (source ?? "").split(","))
      .map((value) => value.trim())
      .filter((value) => Boolean(value) && value !== "HEAD" && !value.startsWith("tag: "))
      .map((value) => value.replace(/^HEAD ->\s*/, "").trim()),
  ));
};

const getReasonMessage = (reason: unknown, fallback: string) => {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message;
  }

  if (typeof reason === "string" && reason.trim()) {
    return reason;
  }

  if (reason && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
};

const isLockedFileCheckoutError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("failed to remove")
    && (normalized.includes("invalid argument") || normalized.includes("permission denied") || normalized.includes("access is denied"))
  ) || normalized.includes("could not unlink");
};

const describeLockedFileCheckout = (fullName: string, message: string) => {
  const match = message.match(/failed to remove\s+(.+?):\s+/i);
  const blockedPath = match?.[1]?.trim() ?? null;
  const branchLabel = fullName.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");

  return {
    title: "Branch switch blocked by a locked file",
    summary: blockedPath
      ? `Git could not replace ${blockedPath} while switching to ${branchLabel}. Another process is probably holding that file open.`
      : `Git could not replace a file while switching to ${branchLabel}. Another process is probably holding it open.`,
    extraDetail: [
      blockedPath ? `Blocked path: ${blockedPath}` : null,
      "This usually happens on Windows when Unity, the editor, the running game, or another process has a DLL or asset loaded.",
      "Close the process using the file, then run the retry action.",
    ].filter(Boolean).join("\n"),
  };
};

export function App() {
  const {
    repositories,
    selectedRepository,
    addRepository,
    removeRepository,
    selectRepository,
  } = useRepositoryStore();

  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [branches, setBranches] = useState<BranchEntry[]>([]);
  const [selectedBranchFullName, setSelectedBranchFullName] = useState<string | null>(null);
  const [branchQuery, setBranchQuery] = useState("");
  const [branchCreateOpen, setBranchCreateOpen] = useState(false);
  const [branchCreateName, setBranchCreateName] = useState("");
  const [branchCreateDiscardChanges, setBranchCreateDiscardChanges] = useState(false);
  const [branchDeleteDialog, setBranchDeleteDialog] = useState<BranchDeleteDialogState | null>(null);
  const [branchPruneDialog, setBranchPruneDialog] = useState<BranchPruneDialogValue | null>(null);
  const [mergeDiscardDialog, setMergeDiscardDialog] = useState<MergeDiscardDialogState | null>(null);
  const [mergeConflictState, setMergeConflictState] = useState<MergeConflictState | null>(null);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [commitGraph, setCommitGraph] = useState<CommitGraphRow[]>([]);
  const [graphScope, setGraphScope] = useState<CommitGraphScope>("all");
  const [graphOrder, setGraphOrder] = useState<CommitGraphOrder>("date");
  const [graphNextSkip, setGraphNextSkip] = useState(0);
  const [graphHasMore, setGraphHasMore] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [aiSettings, setAiSettings] = useState<AiSettings>(() => loadAiSettings());
  const [themeSettings, setThemeSettings] = useState<ThemeSettings>(() => loadThemeSettings());
  const [aiGeneratingCommitMessage, setAiGeneratingCommitMessage] = useState(false);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AppErrorState | null>(null);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [errorRecoveryBusy, setErrorRecoveryBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [remoteDialog, setRemoteDialog] = useState<RemoteDialogState | null>(null);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  const [repoManagerOpen, setRepoManagerOpen] = useState(false);
  const [repoConfig, setRepoConfig] = useState<RepositoryConfig | null>(null);
  const [repoConfigLoading, setRepoConfigLoading] = useState(false);
  const [repoConfigError, setRepoConfigError] = useState<string | null>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneDestination, setCloneDestination] = useState("");
  const [notificationsHovered, setNotificationsHovered] = useState(false);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [materialPreviewMode, setMaterialPreviewMode] = useState<"preview" | "text">("preview");
  const [diffDialogOpen, setDiffDialogOpen] = useState(false);
  const [fileHistory, setFileHistory] = useState<FileHistoryEntry[]>([]);
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false);
  const [fileHistoryError, setFileHistoryError] = useState<string | null>(null);
  const [changeQuery, setChangeQuery] = useState("");
  const [pairMetaFiles, setPairMetaFiles] = useState(true);
  const [showHiddenLocalMenu, setShowHiddenLocalMenu] = useState(false);
  const [showPaths, setShowPaths] = useState(true);
  const [isInspectorFullscreen, setIsInspectorFullscreen] = useState(false);
  const [isChangesFullscreen, setIsChangesFullscreen] = useState(false);
  const [inspectorFractions, setInspectorFractions] = useState({ top: 0.68, bottom: 0.32 });
  const [sortBy, setSortBy] = useState<ChangeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [stackFractions, setStackFractions] = useState({ top: 0.48, bottom: 0.52 });
  const [graphFractions, setGraphFractions] = useState({ left: 0.26, right: 0.74 });
  const [panelFractions, setPanelFractions] = useState({ left: 0.6, right: 0.4 });
  const changesBoardRef = useRef<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorSplitRef = useRef<HTMLDivElement | null>(null);
  const workspaceSplitRef = useRef<HTMLElement | null>(null);
  const graphSplitRef = useRef<HTMLDivElement | null>(null);
  const contentGridRef = useRef<HTMLElement | null>(null);
  const lastAutoRefreshAtRef = useRef(0);
  const gitActivityStartedAtRef = useRef(0);
  const gitActivityHideTimeoutRef = useRef<number | null>(null);
  const appliedThemeVariableKeysRef = useRef<string[]>([]);
  const [logFilePath, setLogFilePath] = useState<string | null>(null);
  const [gitActivityShown, setGitActivityShown] = useState(false);

  const {
    changeContextMenu,
    handleSelectChange,
    handleSelectHiddenLocal,
    hiddenLocalContextMenu,
    hiddenLocalEntries,
    hideLocally,
    openChangeContextMenu,
    openHiddenLocalContextMenu,
    resolveActionPathsForSelection,
    resolveContextSelectionKeys,
    resolveHiddenKeysForSelection,
    resolveHiddenLocalSelection,
    restoreHiddenLocalKeys,
    selectedChange,
    selectedChangePath,
    selectedChangePaths,
    selectionAnchorPath,
    selectedHiddenLocalKeys,
    selectedStagedPaths,
    selectedUnstagedPaths,
    setChangeContextMenu,
    setHiddenLocalContextMenu,
    setSelectedChangePath,
    setSelectedChangePaths,
    setSelectionAnchorPath,
    stagedChanges,
    unstagedChanges,
  } = useChangeWorkbench({
    snapshotFiles: snapshot?.files,
    selectedRepository,
    changeQuery,
    showPaths,
    sortBy,
    sortDirection,
    pairMetaFiles,
    setStatusMessage,
  });

  const applyGraphPage = useCallback((page: CommitGraphPage, mode: "replace" | "append") => {
    setCommitGraph((currentRows) => {
      if (mode === "replace") {
        return page.rows;
      }

      const seen = new Set(currentRows.map((row) => row.hash));
      const appended = page.rows.filter((row) => !seen.has(row.hash));
      return [...currentRows, ...appended];
    });
    setGraphHasMore(page.hasMore);
    setGraphNextSkip(page.nextSkip);
  }, []);

  const writeClientLog = useCallback((scope: string, message: string, detail?: string) => {
    void logClientEvent(scope, message, detail).catch(() => {
      // Logging must never block UI actions.
    });
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let cancelled = false;

    const loadLogFilePath = async () => {
      try {
        const path = await getLogFilePath();
        if (!cancelled) {
          setLogFilePath(path);
        }
      } catch {
        if (!cancelled) {
          setLogFilePath(null);
        }
      }
    };

    void loadLogFilePath();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!error) {
      setErrorDialogOpen(false);
    }
  }, [error]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsInspectorFullscreen(document.fullscreenElement === inspectorRef.current);
      setIsChangesFullscreen(document.fullscreenElement === changesBoardRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!remoteDialog) {
      setRemoteDialogOpen(false);
    }
  }, [remoteDialog]);

  useEffect(() => {
    return () => {
      if (gitActivityHideTimeoutRef.current) {
        window.clearTimeout(gitActivityHideTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if ((snapshot?.counts.conflicted ?? 0) === 0) {
      setMergeConflictState(null);
      return;
    }

    if (!mergeConflictState) {
      return;
    }

    const conflictedFiles = snapshot?.files.filter((file) => file.conflicted).map((file) => file.path) ?? [];

    if (conflictedFiles.length === 0) {
      setMergeConflictState(null);
      return;
    }

    setMergeConflictState((current) => current ? { ...current, conflictedFiles } : current);
  }, [mergeConflictState, snapshot]);

  useEffect(() => {
    if (mergeConflictState) {
      setConflictDialogOpen(true);
    } else {
      setConflictDialogOpen(false);
    }
  }, [mergeConflictState]);

  useEffect(() => {
    persistAiSettings(aiSettings);
  }, [aiSettings]);

  useEffect(() => {
    persistThemeSettings(themeSettings);
  }, [themeSettings]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const root = document.documentElement;
    const presetId = resolveThemePresetId(themeSettings);
    const nextVariables = parseCustomThemeVariables(themeSettings);

    root.dataset.theme = presetId;
    root.style.colorScheme = presetId === "light" ? "light" : "dark";

    for (const key of appliedThemeVariableKeysRef.current) {
      if (!(key in nextVariables)) {
        root.style.removeProperty(key);
      }
    }

    for (const [key, value] of Object.entries(nextVariables)) {
      root.style.setProperty(key, value);
    }

    appliedThemeVariableKeysRef.current = Object.keys(nextVariables);
  }, [themeSettings]);

  const reportAppError = useCallback((options: {
    scope: string;
    title: string;
    fallback: string;
    reason?: unknown;
    context?: string;
    detail?: string;
  }) => {
    const summary = options.reason instanceof Error
      ? options.reason.message || options.fallback
      : typeof options.reason === "string" && options.reason.trim()
        ? options.reason
        : options.fallback;
    const rawDetail = options.reason instanceof Error
      ? options.reason.stack?.trim() || options.reason.message || options.fallback
      : typeof options.reason === "string" && options.reason.trim()
        ? options.reason
        : options.fallback;
    const normalizedSummary = summary.toLowerCase();
    const normalizedDetail = rawDetail.toLowerCase();
    const canClearIndexLock = Boolean(
      selectedRepository
      && normalizedSummary.includes("index.lock")
      && normalizedSummary.includes("file exists")
      && (normalizedDetail.includes("another git process seems to be running") || normalizedDetail.includes("remove the file manually")),
    );
    const occurredAt = new Date().toISOString();
    const fullDetail = [
      `Time: ${occurredAt}`,
      selectedRepository ? `Repository: ${selectedRepository}` : null,
      options.context ? `Action: ${options.context}` : null,
      options.detail ? `Context:\n${options.detail}` : null,
      `Summary: ${summary}`,
      `Error detail:\n${rawDetail}`,
      logFilePath ? `Log file:\n${logFilePath}` : null,
    ].filter(Boolean).join("\n\n");

    setError({
      title: options.title,
      summary,
      detail: fullDetail,
      occurredAt,
      logPath: logFilePath,
      repoPath: selectedRepository,
      recoveryAction: canClearIndexLock ? {
        kind: "clear-index-lock",
        label: "Remove lock file",
        description: "Attempt the safe fix by removing the stale .git/index.lock file for this repository.",
      } : null,
    });

    writeClientLog(options.scope, options.title, fullDetail);
  }, [logFilePath, selectedRepository, writeClientLog]);

  const showRemoteDialog = useCallback((dialog: RemoteDialogState, options?: {
    scope?: string;
    context?: string;
    extraDetail?: string;
  }) => {
    const occurredAt = new Date().toISOString();
    const fullDetail = [
      `Time: ${occurredAt}`,
      selectedRepository ? `Repository: ${selectedRepository}` : null,
      options?.context ? `Action: ${options.context}` : null,
      `Summary: ${dialog.summary}`,
      dialog.detail ? `Git said:\n${dialog.detail}` : null,
      options?.extraDetail ? `Context:\n${options.extraDetail}` : null,
      logFilePath ? `Log file:\n${logFilePath}` : null,
    ].filter(Boolean).join("\n\n");

    setRemoteDialog({
      ...dialog,
      occurredAt,
      logPath: logFilePath,
      fullDetail,
    });

    if (options?.scope) {
      writeClientLog(options.scope, dialog.title, fullDetail);
    }
  }, [logFilePath, selectedRepository, writeClientLog]);

  const showRepoManager = repoManagerOpen || repositories.length === 0;

  const refreshRepository = useCallback(async (options?: { fetchRemote?: boolean }) => {
    if (!selectedRepository) {
      setSnapshot(null);
      setBranches([]);
      setSelectedBranchFullName(null);
      setCommitGraph([]);
      setGraphHasMore(false);
      setGraphNextSkip(0);
      return;
    }

    setLoading(true);
    setGraphLoading(true);
    setError(null);

    try {
      if (options?.fetchRemote) {
        try {
          writeClientLog("git.fetch", `Fetching remote updates for ${selectedRepository}.`);
          await fetchRepository(selectedRepository);
        } catch (reason) {
          const message = getReasonMessage(reason, "Fetch failed.");
          showRemoteDialog(describeRemoteFailure("fetch", message), {
            scope: "git.fetch.error",
            context: `Fetch remote updates for ${selectedRepository}.`,
          });
        }
      }

      const [nextSnapshot, nextBranches, nextGraph] = await Promise.all([
        inspectRepository(selectedRepository),
        listBranches(selectedRepository),
        listCommitGraph(selectedRepository, 260, 0, graphScope, graphOrder),
      ]);

      setSnapshot(nextSnapshot);
      setBranches(nextBranches);
      applyGraphPage(nextGraph, "replace");

      setSelectedBranchFullName((current) => {
        if (current && nextBranches.some((branch) => branch.fullName === current)) {
          return current;
        }

        return nextBranches.find((branch) => branch.isCurrent)?.fullName ?? null;
      });

      if (selectedChangePath) {
        const stillExists = nextSnapshot.files.some(
          (file) => file.path === selectedChangePath,
        );
        if (!stillExists) {
          setSelectedChangePath(null);
        }
      }

      setSelectedChangePaths((current) =>
        current.filter((path) => nextSnapshot.files.some((file) => file.path === path)),
      );

      if (selectionAnchorPath && !nextSnapshot.files.some((file) => file.path === selectionAnchorPath)) {
        setSelectionAnchorPath(null);
      }

      if (selectedCommitHash) {
        const stillExists = nextGraph.rows.some((commit) => commit.hash === selectedCommitHash);

        if (!stillExists) {
          setSelectedCommitHash(null);
          setCommitDetail(null);
        }
      }
    } catch (reason) {
      reportAppError({
        scope: "repo.refresh.error",
        title: "Repository refresh failed",
        fallback: "Failed to read repository.",
        reason,
        context: "Refresh repository state and commit graph.",
      });
      setSnapshot(null);
      setCommitGraph([]);
      setGraphHasMore(false);
      setGraphNextSkip(0);
    } finally {
      setLoading(false);
      setGraphLoading(false);
    }
  }, [applyGraphPage, graphOrder, graphScope, selectedChangePath, selectedCommitHash, selectedRepository, selectionAnchorPath, showRemoteDialog, writeClientLog]);

  const runErrorRecoveryAction = useCallback(async () => {
    if (!error?.recoveryAction || !error.repoPath) {
      return;
    }

    setErrorRecoveryBusy(true);

    try {
      if (error.recoveryAction.kind === "clear-index-lock") {
        const result = await clearGitIndexLock(error.repoPath);
        setStatusMessage(result);
        writeClientLog("git.index-lock.clear", result, error.repoPath);
        setError(null);
        await refreshRepository();
        return;
      }

      if (error.recoveryAction.kind === "retry-branch-switch" && error.recoveryAction.branchFullName) {
        const result = error.recoveryAction.force
          ? await forceSwitchBranch(error.repoPath, error.recoveryAction.branchFullName)
          : await switchBranch(error.repoPath, error.recoveryAction.branchFullName);
        setStatusMessage(result);
        writeClientLog(
          error.recoveryAction.force ? "git.branch.force-switch.retry" : "git.branch.switch.retry",
          result,
          error.repoPath,
        );
        setMergeConflictState(null);
        setError(null);
        await refreshRepository({ fetchRemote: true });
      }
    } catch (reason) {
      reportAppError({
        scope: error.recoveryAction.kind === "clear-index-lock"
          ? "git.index-lock.clear.error"
          : error.recoveryAction.force
            ? "git.branch.force-switch.retry.error"
            : "git.branch.switch.retry.error",
        title: error.recoveryAction.kind === "clear-index-lock"
          ? "Remove lock file failed"
          : error.recoveryAction.force
            ? "Retry force switch failed"
            : "Retry branch switch failed",
        fallback: error.recoveryAction.kind === "clear-index-lock"
          ? "Automatic lock file cleanup failed."
          : error.recoveryAction.force
            ? "Retrying the force switch failed."
            : "Retrying the branch switch failed.",
        reason,
        context: error.recoveryAction.kind === "clear-index-lock"
          ? `Remove stale .git/index.lock for ${error.repoPath}.`
          : `${error.recoveryAction.force ? "Retry force switch" : "Retry branch switch"} ${error.recoveryAction.branchFullName ?? ""}.`,
      });
    } finally {
      setErrorRecoveryBusy(false);
    }
  }, [error, refreshRepository, reportAppError, writeClientLog]);

  const loadMoreGraph = useCallback(async () => {
    if (!selectedRepository || graphLoading || !graphHasMore) {
      return;
    }

    setGraphLoading(true);

    try {
      const nextPage = await listCommitGraph(selectedRepository, 260, graphNextSkip, graphScope, graphOrder);
      applyGraphPage(nextPage, "append");
    } catch (reason) {
      reportAppError({
        scope: "history.graph.error",
        title: "Commit graph loading failed",
        fallback: "Graph loading failed.",
        reason,
        context: `Load more commit graph rows from offset ${graphNextSkip}.`,
      });
    } finally {
      setGraphLoading(false);
    }
  }, [applyGraphPage, graphHasMore, graphLoading, graphNextSkip, graphOrder, graphScope, reportAppError, selectedRepository]);

  useEffect(() => {
    if (!selectedRepository || !selectedChangePath) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      setFileHistory([]);
      setFileHistoryError(null);
      setFileHistoryLoading(false);
      return;
    }

    let cancelled = false;

    const loadPreview = async () => {
      setPreviewLoading(true);
      setPreviewError(null);

      try {
        const nextPreview = await inspectFilePreview(
          selectedRepository,
          selectedChangePath,
        );

        if (!cancelled) {
          setPreview(nextPreview);
        }
      } catch (reason) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(
            reason instanceof Error ? reason.message : "Preview loading failed.",
          );
        }
      } finally {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      }
    };

    void loadPreview();

    return () => {
      cancelled = true;
    };
  }, [selectedChangePath, selectedRepository]);

  useEffect(() => {
    if (!selectedRepository || !selectedChangePath) {
      setFileHistory([]);
      setFileHistoryError(null);
      setFileHistoryLoading(false);
      return;
    }

    let cancelled = false;

    const loadFileHistory = async () => {
      setFileHistoryLoading(true);
      setFileHistoryError(null);

      try {
        const nextHistory = await listFileHistory(selectedRepository, selectedChangePath, 16);

        if (!cancelled) {
          setFileHistory(nextHistory);
        }
      } catch (reason) {
        if (!cancelled) {
          setFileHistory([]);
          setFileHistoryError(
            reason instanceof Error ? reason.message : "File history loading failed.",
          );
        }
      } finally {
        if (!cancelled) {
          setFileHistoryLoading(false);
        }
      }
    };

    void loadFileHistory();

    return () => {
      cancelled = true;
    };
  }, [selectedChangePath, selectedRepository]);

  useEffect(() => {
    if (!selectedRepository || !selectedCommitHash) {
      setCommitDetail(null);
      setCommitDetailError(null);
      setCommitDetailLoading(false);
      return;
    }

    let cancelled = false;

    const loadCommitDetail = async () => {
      setCommitDetailLoading(true);
      setCommitDetailError(null);

      try {
        const nextCommitDetail = await inspectCommitDetail(selectedRepository, selectedCommitHash);

        if (!cancelled) {
          setCommitDetail(nextCommitDetail);
        }
      } catch (reason) {
        if (!cancelled) {
          setCommitDetail(null);
          setCommitDetailError(
            reason instanceof Error ? reason.message : "Commit detail loading failed.",
          );
        }
      } finally {
        if (!cancelled) {
          setCommitDetailLoading(false);
        }
      }
    };

    void loadCommitDetail();

    return () => {
      cancelled = true;
    };
  }, [selectedCommitHash, selectedRepository]);

  useEffect(() => {
    void refreshRepository();
  }, [refreshRepository]);

  const runAutoRefresh = useCallback(async (reason: "interval" | "resume") => {
    if (!selectedRepository || showRepoManager || submitting || loading) {
      return;
    }

    if (document.hidden) {
      return;
    }

    const now = Date.now();
    if (now - lastAutoRefreshAtRef.current < 10_000) {
      return;
    }

    lastAutoRefreshAtRef.current = now;
    writeClientLog("repo.auto-refresh", `Running automatic repository refresh (${reason}).`, selectedRepository);
    await refreshRepository({ fetchRemote: true });
  }, [loading, refreshRepository, selectedRepository, showRepoManager, submitting, writeClientLog]);

  useEffect(() => {
    if (!selectedRepository || showRepoManager) {
      return;
    }

    const interval = window.setInterval(() => {
      void runAutoRefresh("interval");
    }, 5 * 60 * 1000);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void runAutoRefresh("resume");
      }
    };

    const handleFocus = () => {
      void runAutoRefresh("resume");
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
    };
  }, [runAutoRefresh, selectedRepository, showRepoManager]);

  useEffect(() => {
    if (!showRepoManager || !selectedRepository) {
      setRepoConfig(null);
      setRepoConfigError(null);
      setRepoConfigLoading(false);
      return;
    }

    let cancelled = false;

    const loadRepoConfig = async () => {
      setRepoConfigLoading(true);
      setRepoConfigError(null);

      try {
        const nextConfig = await inspectRepositoryConfig(selectedRepository);
        if (!cancelled) {
          setRepoConfig(nextConfig);
        }
      } catch (reason) {
        if (!cancelled) {
          setRepoConfig(null);
          setRepoConfigError(reason instanceof Error ? reason.message : "Repository settings failed to load.");
        }
      } finally {
        if (!cancelled) {
          setRepoConfigLoading(false);
        }
      }
    };

    void loadRepoConfig();

    return () => {
      cancelled = true;
    };
  }, [selectedRepository, showRepoManager]);

  useEffect(() => {
    if (notificationsHovered) {
      return;
    }

    const timers: number[] = [];

    if (statusMessage) {
      timers.push(window.setTimeout(() => setStatusMessage(null), 5000));
    }

    if (error && !errorDialogOpen) {
      timers.push(window.setTimeout(() => setError(null), 9000));
    }

    if (remoteDialog && !remoteDialogOpen) {
      timers.push(
        window.setTimeout(
          () => setRemoteDialog(null),
          remoteDialog.tone === "error" ? 12000 : 7000,
        ),
      );
    }

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [error, errorDialogOpen, notificationsHovered, remoteDialog, remoteDialogOpen, statusMessage]);


  const pickRepository = useCallback(async () => {
    let path: string | null = null;

    if (isTauri()) {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a local Git repository",
      });

      path = typeof selected === "string" ? selected : null;
    } else {
      path = window.prompt("Enter a local repository path") ?? null;
    }

    if (path) {
      addRepository(path);
      setStatusMessage(`Added ${path}`);
      writeClientLog("repo.add", `Added repository ${path}`);
    }
  }, [addRepository, writeClientLog]);

  const pickCloneDestination = useCallback(async () => {
    if (isTauri()) {
      const selected = await save({
        title: "Choose clone destination",
      });

      if (typeof selected === "string") {
        setCloneDestination(selected);
      }
      return;
    }

    const value = window.prompt("Clone destination path", cloneDestination) ?? null;
    if (value) {
      setCloneDestination(value);
    }
  }, [cloneDestination]);

  const toggleInspectorFullscreen = useCallback(async () => {
    if (!inspectorRef.current) {
      return;
    }

    if (document.fullscreenElement === inspectorRef.current) {
      await document.exitFullscreen();
      return;
    }

    await inspectorRef.current.requestFullscreen();
  }, []);

  const toggleChangesFullscreen = useCallback(async () => {
    if (!changesBoardRef.current) {
      return;
    }

    if (document.fullscreenElement === changesBoardRef.current) {
      await document.exitFullscreen();
      return;
    }

    await changesBoardRef.current.requestFullscreen();
  }, []);

  const runCloneRepository = useCallback(async () => {
    if (!cloneUrl.trim() || !cloneDestination.trim()) {
      reportAppError({
        scope: "repo.clone.validation",
        title: "Clone repository failed",
        fallback: "Clone URL and destination path are required.",
        reason: "Clone URL and destination path are required.",
        context: "Validate clone repository inputs.",
        detail: `Remote URL: ${cloneUrl.trim() || "<empty>"}\nDestination: ${cloneDestination.trim() || "<empty>"}`,
      });
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("repo.clone", `Cloning ${cloneUrl.trim()} into ${cloneDestination.trim()}.`);
      const result: CloneResult = await cloneRepository(cloneUrl.trim(), cloneDestination.trim());
      addRepository(result.repoPath);
      setCloneUrl("");
      setCloneDestination("");
      setRepoManagerOpen(false);
      setStatusMessage(`Cloned ${result.repoName}.`);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      reportAppError({
        scope: "repo.clone.error",
        title: "Clone repository failed",
        fallback: "Clone failed.",
        reason,
        context: `Clone ${cloneUrl.trim()} into ${cloneDestination.trim()}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [addRepository, cloneDestination, cloneUrl, refreshRepository, reportAppError, writeClientLog]);

  const runDiscardChangePaths = useCallback(async (paths: string[]) => {
    if (!selectedRepository || paths.length === 0) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.discard", `Discarding ${paths.length} change path(s).`, paths.join("\n"));
      await discardPaths(selectedRepository, paths);
      setStatusMessage(`Discarded ${paths.length} path${paths.length > 1 ? "s" : ""}.`);
      setSelectedChangePath(null);
      setSelectedChangePaths([]);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "git.discard.error",
        title: "Discard changes failed",
        fallback: "Discard failed.",
        reason,
        context: `Discard ${paths.length} change path(s).`,
        detail: paths.join("\n"),
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runDiscardAllUnstaged = useCallback(async () => {
    if (!selectedRepository || unstagedChanges.length === 0) {
      return;
    }

    const allPaths = Array.from(new Set(unstagedChanges.flatMap((item) => item.actionPaths)));
    const confirmed = window.confirm(
      `Discard all ${allPaths.length} unstaged path${allPaths.length === 1 ? "" : "s"}? This also removes newly added untracked files.`,
    );

    if (!confirmed) {
      return;
    }

    await runDiscardChangePaths(allPaths);
  }, [refreshRepository, runDiscardChangePaths, selectedRepository, unstagedChanges]);

  const runAddToGitignore = useCallback(async (paths: string[]) => {
    if (!selectedRepository || paths.length === 0) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.gitignore.add", `Appending ${paths.length} path(s) to .gitignore.`, paths.join("\n"));
      await addPathsToGitignore(selectedRepository, paths);
      setStatusMessage(`Added ${paths.length} path${paths.length > 1 ? "s" : ""} to .gitignore.`);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "git.gitignore.add.error",
        title: "Update .gitignore failed",
        fallback: "Updating .gitignore failed.",
        reason,
        context: `Append ${paths.length} path(s) to .gitignore.`,
        detail: paths.join("\n"),
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runSaveRepositoryRemote = useCallback(async (
    originalName: string | null,
    name: string,
    fetchUrl: string,
    pushUrl: string,
  ) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("repo.remote.save", `Saving remote ${originalName ?? name}.`, `${name}\n${fetchUrl}\n${pushUrl}`);
      await saveRepositoryRemote(selectedRepository, originalName, name, fetchUrl, pushUrl || undefined);
      setStatusMessage(`Saved remote ${name}.`);
      const nextConfig = await inspectRepositoryConfig(selectedRepository);
      setRepoConfig(nextConfig);
    } catch (reason) {
      reportAppError({
        scope: "repo.remote.save.error",
        title: "Save remote failed",
        fallback: "Saving remote failed.",
        reason,
        context: `Save remote ${originalName ?? name}.`,
        detail: `${name}\n${fetchUrl}\n${pushUrl}`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [reportAppError, selectedRepository, writeClientLog]);

  const runDeleteRepositoryRemote = useCallback(async (name: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("repo.remote.delete", `Removing remote ${name}.`);
      const result = await deleteRepositoryRemote(selectedRepository, name);
      setStatusMessage(result);
      const nextConfig = await inspectRepositoryConfig(selectedRepository);
      setRepoConfig(nextConfig);
    } catch (reason) {
      reportAppError({
        scope: "repo.remote.delete.error",
        title: "Remove remote failed",
        fallback: "Removing remote failed.",
        reason,
        context: `Remove remote ${name}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [reportAppError, selectedRepository, writeClientLog]);

  const pickRepositorySshPrivateKey = useCallback(async () => {
    if (isTauri()) {
      const selected = await open({
        multiple: false,
        title: "Choose SSH private key",
      });

      return typeof selected === "string" ? selected : null;
    }

    return window.prompt("SSH private key path") ?? null;
  }, []);

  const runSaveRepositorySshSettings = useCallback(async (settings: RepositorySshSettings) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog(
        "repo.ssh.save",
        `Saving SSH settings for ${selectedRepository}.`,
        [
          `mode=${settings.mode}`,
          `useUserSshConfig=${settings.useUserSshConfig}`,
          `privateKeyPath=${settings.privateKeyPath ?? "<default>"}`,
          `username=${settings.username ?? "<default>"}`,
        ].join("\n"),
      );
      await saveRepositorySshSettings(selectedRepository, settings);
      const nextConfig = await inspectRepositoryConfig(selectedRepository);
      setRepoConfig(nextConfig);
      setStatusMessage("Saved repository SSH settings.");
    } catch (reason) {
      reportAppError({
        scope: "repo.ssh.save.error",
        title: "Save SSH settings failed",
        fallback: "Saving repository SSH settings failed.",
        reason,
        context: `Save repository SSH settings for ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [reportAppError, selectedRepository, writeClientLog]);

  const runFileOperation = useCallback(
    async (mode: "stage" | "unstage", paths: string[]) => {
      if (!selectedRepository || paths.length === 0) {
        return;
      }

      setSubmitting(true);
      setError(null);

      try {
        writeClientLog("git.stage", `Running ${mode} for ${paths.length} path(s).`, paths.join("\n"));
        if (mode === "stage") {
          await stageFiles(selectedRepository, paths);
          setStatusMessage(`Staged ${paths.length} file${paths.length > 1 ? "s" : ""}.`);
        } else {
          await unstageFiles(selectedRepository, paths);
          setStatusMessage(
            `Moved ${paths.length} file${paths.length > 1 ? "s" : ""} back to unstaged.`,
          );
        }

        await refreshRepository();
      } catch (reason) {
        reportAppError({
          scope: "git.stage.error",
          title: mode === "stage" ? "Stage files failed" : "Unstage files failed",
          fallback: "Git operation failed.",
          reason,
          context: `Run ${mode} for ${paths.length} path(s).`,
          detail: paths.join("\n"),
        });
      } finally {
        setSubmitting(false);
      }
    },
    [refreshRepository, reportAppError, selectedRepository, writeClientLog],
  );

  const commitChanges = useCallback(async () => {
    if (!selectedRepository || !commitMessage.trim()) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.commit", "Creating commit.", commitMessage.trim());
      await createCommit(selectedRepository, commitMessage.trim());
      setCommitMessage("");
      setStatusMessage("Committed staged changes.");
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "git.commit.error",
        title: "Commit failed",
        fallback: "Commit failed.",
        reason,
        context: "Create a commit from staged changes.",
        detail: commitMessage.trim(),
      });
    } finally {
      setSubmitting(false);
    }
  }, [commitMessage, refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runGenerateCommitMessage = useCallback(async () => {
    if (!selectedRepository || !stagedChanges.length) {
      return;
    }

    const settingsError = getAiSettingsValidationError(aiSettings);

    if (settingsError) {
      reportAppError({
        scope: "ai.commit-message.config",
        title: "AI commit messages are not configured",
        fallback: settingsError,
        reason: settingsError,
        context: "Generate AI commit message.",
      });
      return;
    }

    setAiGeneratingCommitMessage(true);
    setError(null);

    try {
      writeClientLog("ai.commit-message.start", `Generating commit message with ${aiSettings.provider}.`);
      const context = await inspectCommitMessageContext(selectedRepository);
      const generatedMessage = await generateAiCommitMessage(aiSettings, context);
      setCommitMessage(generatedMessage);
      setStatusMessage(`Generated commit message with ${aiSettings.provider}.`);
      writeClientLog("ai.commit-message.success", `Generated commit message with ${aiSettings.provider}.`, generatedMessage);
    } catch (reason) {
      reportAppError({
        scope: "ai.commit-message.error",
        title: "AI commit message generation failed",
        fallback: "AI commit message generation failed.",
        reason,
        context: `Generate commit message with ${aiSettings.provider}.`,
      });
    } finally {
      setAiGeneratingCommitMessage(false);
    }
  }, [aiSettings, reportAppError, selectedRepository, stagedChanges.length, writeClientLog]);

  const commitAndPushChanges = useCallback(async () => {
    if (!selectedRepository || !commitMessage.trim()) {
      return;
    }

    const message = commitMessage.trim();
    let committed = false;

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.commit", "Creating commit before push.", message);
      await createCommit(selectedRepository, message);
      committed = true;
      setCommitMessage("");

      writeClientLog("git.push", `Pushing repository ${selectedRepository} after commit.`);
      const pushResult = await pushRepository(selectedRepository);

      setStatusMessage(pushResult || "Committed staged changes and pushed them.");
      showRemoteDialog({
        tone: "info",
        title: "Commit and push completed",
        summary: pushResult || "Staged changes were committed and pushed to the tracked remote branch.",
      }, {
        scope: "git.push.success",
        context: `Push repository ${selectedRepository} after commit.`,
      });
      await refreshRepository();
    } catch (reason) {
      const failure = getReasonMessage(reason, "Commit and push failed.");

      if (committed) {
        setError(null);
        setStatusMessage("Committed staged changes locally. Push failed.");
        showRemoteDialog(describeRemoteFailure("push", failure), {
          scope: "git.push.error",
          context: `Push repository ${selectedRepository} after commit.`,
          extraDetail: message,
        });
        await refreshRepository();
      } else {
        reportAppError({
          scope: "git.commit.error",
          title: "Commit before push failed",
          fallback: "Commit and push failed.",
          reason: failure,
          context: "Create a commit before push.",
          detail: message,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [commitMessage, refreshRepository, reportAppError, selectedRepository, showRemoteDialog, writeClientLog]);

  const exportCommitFile = useCallback(async (commitHash: string, relativePath: string) => {
    if (!selectedRepository || !commitHash) {
      return;
    }

    const defaultFileName = relativePath.split(/[\\/]/).pop() ?? "file";
    let destinationPath: string | null = null;

    if (isTauri()) {
      const selected = await save({
        defaultPath: defaultFileName,
        title: `Export ${defaultFileName} from commit`,
      });

      destinationPath = typeof selected === "string" ? selected : null;
    } else {
      destinationPath = window.prompt("Export destination path", defaultFileName) ?? null;
    }

    if (!destinationPath) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("history.export", `Exporting ${relativePath} from ${commitHash}.`, destinationPath);
      await exportFileFromCommit(selectedRepository, commitHash, relativePath, destinationPath);
      setStatusMessage(`Exported ${relativePath} from ${commitHash.slice(0, 7)}.`);
    } catch (reason) {
      reportAppError({
        scope: "history.export.error",
        title: "Commit file export failed",
        fallback: "Commit file export failed.",
        reason,
        context: `Export ${relativePath} from ${commitHash}.`,
        detail: `Destination: ${destinationPath}`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [reportAppError, selectedRepository, writeClientLog]);

  const restoreCommitFile = useCallback(async (commitHash: string, relativePath: string) => {
    if (!selectedRepository || !commitHash) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("history.restore", `Restoring ${relativePath} from ${commitHash}.`);
      await restoreFileFromCommit(selectedRepository, commitHash, relativePath);
      setStatusMessage(`Restored ${relativePath} from ${commitHash.slice(0, 7)}.`);
      setSelectedChangePath(relativePath);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "history.restore.error",
        title: "Commit file restore failed",
        fallback: "Commit file restore failed.",
        reason,
        context: `Restore ${relativePath} from ${commitHash}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const applyFilePatchFromCommit = useCallback(async (commitHash: string, relativePath: string, reverse: boolean) => {
    if (!selectedRepository || !commitHash) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog(
        reverse ? "history.patch.reverse" : "history.patch.apply",
        `${reverse ? "Reversing" : "Applying"} file patch for ${relativePath} from ${commitHash}.`,
      );
      await applyCommitFilePatch(selectedRepository, commitHash, relativePath, reverse);
      setStatusMessage(
        `${reverse ? "Reverted" : "Applied"} ${relativePath} ${reverse ? "from" : "using"} ${commitHash.slice(0, 7)}.`,
      );
      setSelectedChangePath(relativePath);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: reverse ? "history.patch.reverse.error" : "history.patch.apply.error",
        title: reverse ? "Revert file patch failed" : "Apply file patch failed",
        fallback: "Commit file patch failed.",
        reason,
        context: `${reverse ? "Reverse" : "Apply"} patch for ${relativePath} from ${commitHash}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const selectedBranch = useMemo(
    () => branches.find((branch) => branch.fullName === selectedBranchFullName) ?? null,
    [branches, selectedBranchFullName],
  );

  const branchCreateBaseLabel = useMemo(() => {
    return selectedBranch?.name ?? branches.find((branch) => branch.isCurrent)?.name ?? "HEAD";
  }, [branches, selectedBranch]);

  const aiCommitDisabledReason = useMemo(() => {
    if (aiGeneratingCommitMessage) {
      return "Generating commit message...";
    }

    if (!selectedRepository) {
      return "Select a repository first.";
    }

    if (!stagedChanges.length) {
      return "Stage at least one file to generate a commit message.";
    }

    return getAiSettingsValidationError(aiSettings);
  }, [aiGeneratingCommitMessage, aiSettings, selectedRepository, stagedChanges.length]);

  const aiCommitEnabled = !aiCommitDisabledReason;

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLowerCase();
    const visible = !query
      ? branches
      : branches.filter((branch) => {
          return [
            branch.name,
            branch.branchKind,
            branch.trackingName ?? "",
            branch.subject,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query);
        });

    return {
      local: visible.filter((branch) => branch.branchKind === "local"),
      remote: visible.filter((branch) => branch.branchKind === "remote"),
    };
  }, [branchQuery, branches]);

  const selectedCommit = useMemo(
    () => commitGraph.find((commit) => commit.hash === selectedCommitHash) ?? null,
    [commitGraph, selectedCommitHash],
  );

  const selectedCommitBranches = useMemo(() => {
    if (!selectedCommit) {
      return [];
    }

    const tipMatches = branches.filter((branch) => branch.commitHash === selectedCommit.hash);
    const refCandidates = extractCommitRefCandidates(
      selectedCommit.displayBranch,
      selectedCommit.decorations,
      commitDetail?.decorations,
    );
    const normalizedCandidates = refCandidates.map((value) => value.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, ""));
    const matchedByRef = branches.filter((branch) => {
      const branchName = resolveBranchNameFromRef(branch.fullName);
      return normalizedCandidates.some((candidate) => {
        return branch.fullName === candidate
          || branch.name === candidate
          || branchName === candidate
          || branchName.endsWith(`/${candidate}`)
          || candidate.endsWith(`/${branch.name}`);
      });
    });

    const unique = new Map<string, typeof branches[number]>();
    [...tipMatches, ...matchedByRef].forEach((branch) => unique.set(branch.fullName, branch));
    return Array.from(unique.values());
  }, [branches, commitDetail?.decorations, selectedCommit]);

  const [selectedCommitBranchFullName, setSelectedCommitBranchFullName] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedCommitBranches.length) {
      setSelectedCommitBranchFullName(null);
      return;
    }

    setSelectedCommitBranchFullName((current) => {
      if (current && selectedCommitBranches.some((branch) => branch.fullName === current)) {
        return current;
      }

      return selectedCommitBranches[0].fullName;
    });
  }, [selectedCommitBranches]);

  const selectedCommitBranch = useMemo(() => {
    if (!selectedCommitBranchFullName) {
      return selectedCommitBranches[0] ?? null;
    }

    return selectedCommitBranches.find((branch) => branch.fullName === selectedCommitBranchFullName) ?? selectedCommitBranches[0] ?? null;
  }, [selectedCommitBranchFullName, selectedCommitBranches]);

  const filteredHistory = useMemo(() => {
    if (!historyFilter.trim()) {
      return commitGraph;
    }

    const query = historyFilter.trim().toLowerCase();

    return commitGraph.filter((commit) => {
      return [
        commit.subject,
        commit.authorName,
        commit.hash,
        commit.shortHash,
        commit.decorations,
      ].some((value) => value.toLowerCase().includes(query));
    });
  }, [commitGraph, historyFilter]);

  const branchLabel = snapshot?.detachedHead
    ? `Detached at ${snapshot.currentBranch}`
    : snapshot?.currentBranch ?? "No repository selected";

  const powerSummary = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    if (snapshot.behind > 0) {
      return "Force pull discards local state only for files touched upstream and keeps unrelated local-only changes.";
    }

    if (snapshot.ahead > 0) {
      return "Push publishes your local commits to the tracked remote branch.";
    }

    return null;
  }, [snapshot]);

  const previewHeading = preview?.previewKind
    ? `${preview.previewKind[0].toUpperCase()}${preview.previewKind.slice(1)} preview`
    : "Preview";
  const canToggleMaterialTextPreview = preview?.previewKind === "material" && Boolean(preview?.textExcerpt);
  const showMaterialTextPreview = canToggleMaterialTextPreview && materialPreviewMode === "text";

  useEffect(() => {
    setMaterialPreviewMode("preview");
    setDiffDialogOpen(false);
  }, [selectedChangePath]);

  const resizePanels = useCallback((clientX: number) => {
    const container = contentGridRef.current;

    if (!container) {
      return;
    }

    const bounds = container.getBoundingClientRect();
    const totalWidth = bounds.width;

    if (!totalWidth) {
      return;
    }

    setPanelFractions((current) => {
      const leftPx = current.left * totalWidth;
      const rightPx = current.right * totalWidth;
      const nextX = clientX - bounds.left;
      const minLeft = 320;
      const minRight = 320;
      const clampedLeft = Math.min(
        Math.max(nextX, minLeft),
        totalWidth - minRight,
      );
      const newRight = totalWidth - clampedLeft;

      return {
        left: clampedLeft / totalWidth,
        right: newRight / totalWidth,
      };
    });
  }, []);

  const resizeGraphPanels = useCallback((clientX: number) => {
    const container = graphSplitRef.current;

    if (!container) {
      return;
    }

    const bounds = container.getBoundingClientRect();
    const totalWidth = bounds.width;

    if (!totalWidth) {
      return;
    }

    setGraphFractions(() => {
      const nextX = clientX - bounds.left;
      const minLeft = 220;
      const minRight = 420;
      const clampedLeft = Math.min(Math.max(nextX, minLeft), totalWidth - minRight);
      const newRight = totalWidth - clampedLeft;

      return {
        left: clampedLeft / totalWidth,
        right: newRight / totalWidth,
      };
    });
  }, []);

  const resizeWorkspacePanels = useCallback((clientY: number) => {
    const container = workspaceSplitRef.current;

    if (!container) {
      return;
    }

    const bounds = container.getBoundingClientRect();
    const totalHeight = bounds.height;

    if (!totalHeight) {
      return;
    }

    setStackFractions(() => {
      const nextY = clientY - bounds.top;
      const minTop = 220;
      const minBottom = 260;
      const clampedTop = Math.min(Math.max(nextY, minTop), totalHeight - minBottom);
      const newBottom = totalHeight - clampedTop;

      return {
        top: clampedTop / totalHeight,
        bottom: newBottom / totalHeight,
      };
    });
  }, []);

  const resizeInspectorPanels = useCallback((clientY: number) => {
    const container = inspectorSplitRef.current;

    if (!container) {
      return;
    }

    const bounds = container.getBoundingClientRect();
    const totalHeight = bounds.height;

    if (!totalHeight) {
      return;
    }

    setInspectorFractions(() => {
      const nextY = clientY - bounds.top;
      const minTop = 260;
      const minBottom = 180;
      const clampedTop = Math.min(Math.max(nextY, minTop), totalHeight - minBottom);
      const newBottom = totalHeight - clampedTop;

      return {
        top: clampedTop / totalHeight,
        bottom: newBottom / totalHeight,
      };
    });
  }, []);

  const startResize = useCallback(() => {
    const handlePointerMove = (event: PointerEvent) => {
      resizePanels(event.clientX);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [resizePanels]);

  const startGraphResize = useCallback(() => {
    const handlePointerMove = (event: PointerEvent) => {
      resizeGraphPanels(event.clientX);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [resizeGraphPanels]);

  const startWorkspaceResize = useCallback(() => {
    const handlePointerMove = (event: PointerEvent) => {
      resizeWorkspacePanels(event.clientY);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [resizeWorkspacePanels]);

  const startInspectorResize = useCallback(() => {
    const handlePointerMove = (event: PointerEvent) => {
      resizeInspectorPanels(event.clientY);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [resizeInspectorPanels]);

  const lowerGridTemplateColumns = useMemo(() => {
    return `${panelFractions.left}fr 12px ${panelFractions.right}fr`;
  }, [panelFractions]);

  const graphGridTemplateColumns = useMemo(() => {
    return `${graphFractions.left}fr 12px ${graphFractions.right}fr`;
  }, [graphFractions]);

  const workspaceGridTemplateRows = useMemo(() => {
    return `${stackFractions.top}fr 12px ${stackFractions.bottom}fr`;
  }, [stackFractions]);

  const inspectorGridTemplateRows = useMemo(() => {
    return `${inspectorFractions.top}fr 12px ${inspectorFractions.bottom}fr`;
  }, [inspectorFractions]);

  const gitActivityRequestedVisible = loading
    || submitting
    || graphLoading
    || commitDetailLoading
    || repoConfigLoading
    || previewLoading
    || fileHistoryLoading
    || errorRecoveryBusy;

  const gitActivityLabel = useMemo(() => {
    if (errorRecoveryBusy) {
      return "Repairing repository...";
    }

    if (submitting) {
      return "Running Git command...";
    }

    if (loading) {
      return "Refreshing repository...";
    }

    if (repoConfigLoading) {
      return "Loading repository settings...";
    }

    if (graphLoading) {
      return "Loading history...";
    }

    if (commitDetailLoading) {
      return "Loading commit detail...";
    }

    if (previewLoading) {
      return "Loading preview...";
    }

    if (fileHistoryLoading) {
      return "Loading file history...";
    }

    return "Working...";
  }, [commitDetailLoading, errorRecoveryBusy, fileHistoryLoading, graphLoading, loading, previewLoading, repoConfigLoading, submitting]);

  useEffect(() => {
    if (gitActivityHideTimeoutRef.current) {
      window.clearTimeout(gitActivityHideTimeoutRef.current);
      gitActivityHideTimeoutRef.current = null;
    }

    if (gitActivityRequestedVisible) {
      gitActivityStartedAtRef.current = Date.now();
      setGitActivityShown(true);
      return;
    }

    const elapsed = Date.now() - gitActivityStartedAtRef.current;
    const remaining = Math.max(0, 700 - elapsed);

    gitActivityHideTimeoutRef.current = window.setTimeout(() => {
      setGitActivityShown(false);
      gitActivityHideTimeoutRef.current = null;
    }, remaining);
  }, [gitActivityRequestedVisible]);

  const renderDiffStack = (expanded: boolean) => !previewLoading && !previewError && hasDiffContent(preview) ? (
    <div className={clsx("diff-stack", !expanded && "diff-stack--inline")}>
      <div className="preview-panel__header">
        <strong>Exact changes</strong>
        <span className="preview-panel__meta">Git diff</span>
      </div>

      {!expanded ? (
        <button
          className="ghost-button diff-stack__open-button"
          onClick={() => setDiffDialogOpen(true)}
          aria-label="Open full diff viewer"
          title="Open full diff viewer"
        >
          <Expand size={14} />
          Open diff
        </button>
      ) : null}

      {preview?.unstagedDiff ? (
        <div className="diff-card">
          <div className="diff-card__header">
            <span className="pill pill--mixed">Unstaged diff</span>
          </div>
          <pre className="diff-code">
            {preview.unstagedDiff.split("\n").map((line, index) => (
              <div key={`unstaged-${index}`} className={getDiffLineClassName(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      ) : null}

      {preview?.stagedDiff ? (
        <div className="diff-card">
          <div className="diff-card__header">
            <span className="pill pill--success">Staged diff</span>
          </div>
          <pre className="diff-code">
            {preview.stagedDiff.split("\n").map((line, index) => (
              <div key={`staged-${index}`} className={getDiffLineClassName(line)}>
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      ) : null}
    </div>
  ) : null;

  const previewBodyContent = (
    <>
      {!previewLoading && !previewError && preview?.previewKind === "image" ? (
        <Suspense fallback={<p className="muted">Loading image preview...</p>}>
          <ImagePreviewCompare preview={preview} />
        </Suspense>
      ) : null}

      {!previewLoading && !previewError && preview?.previewKind === "material" && !showMaterialTextPreview ? (
        <Suspense fallback={<p className="muted">Loading material preview...</p>}>
          <UnityMaterialPreviewCompare preview={preview} />
        </Suspense>
      ) : null}

      {!previewLoading && !previewError && preview?.previewKind === "model" ? (
        <Suspense fallback={<p className="muted">Loading model preview...</p>}>
          <ModelPreviewCompare preview={preview} />
        </Suspense>
      ) : null}

      {!previewLoading && !previewError && (preview?.previewKind === "text" || showMaterialTextPreview) ? (
        <div className="preview-frame preview-frame--code">
          <pre className="preview-code">{preview.textExcerpt}</pre>
        </div>
      ) : null}

      {!previewLoading && !previewError && preview && preview.previewKind !== "image" && preview.previewKind !== "text" && preview.previewKind !== "material" && preview.previewKind !== "model" ? (
        <div className="preview-frame preview-frame--placeholder">
          <p>{preview.supportHint}</p>
        </div>
      ) : null}

      {!previewLoading && !previewError && preview?.assetSummary ? (
        <div className="asset-summary">
          <div className="preview-panel__header">
            <strong>{preview.assetSummary.assetKind}</strong>
            <span className="preview-panel__meta">{preview.assetSummary.pipelineState}</span>
          </div>
          <dl className="preview-details">
            {preview.assetSummary.details.map((detail) => (
              <div key={`${detail.label}-${detail.value}`}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {preview ? (
        <dl className="preview-details">
          <div>
            <dt>Type</dt>
            <dd>{preview.mimeType}</dd>
          </div>
          <div>
            <dt>Extension</dt>
            <dd>{preview.extension || "none"}</dd>
          </div>
          <div>
            <dt>Modified</dt>
            <dd>{formatUnixTimestamp(preview.modifiedAt)}</dd>
          </div>
        </dl>
      ) : null}
    </>
  );

  const applyMergeBranchResult = useCallback(async (branchFullName: string, branchLabel: string, result: MergeBranchResult) => {
    setStatusMessage(result.message);

    if (result.status === "conflicts") {
      setMergeConflictState({
        branchFullName,
        branchLabel,
        conflictedFiles: result.conflictedFiles,
      });
    }

    await refreshRepository({ fetchRemote: true });
  }, [refreshRepository]);

  const runSwitchBranch = useCallback(async (fullName: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.switch", `Switching branch ${fullName}.`);
      const result = await switchBranch(selectedRepository, fullName);
      setStatusMessage(result);
      setMergeConflictState(null);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      const message = getReasonMessage(reason, "Branch switch failed.");
      if (isLockedFileCheckoutError(message)) {
        const lockedFile = describeLockedFileCheckout(fullName, message);
        const occurredAt = new Date().toISOString();
        const fullDetail = [
          `Time: ${occurredAt}`,
          selectedRepository ? `Repository: ${selectedRepository}` : null,
          `Action: Switch branch ${fullName}.`,
          `Context:\n${lockedFile.extraDetail}`,
          `Summary: ${lockedFile.summary}`,
          `Error detail:\n${message}`,
          logFilePath ? `Log file:\n${logFilePath}` : null,
        ].filter(Boolean).join("\n\n");

        setError({
          title: lockedFile.title,
          summary: lockedFile.summary,
          detail: fullDetail,
          occurredAt,
          logPath: logFilePath,
          repoPath: selectedRepository,
          recoveryAction: {
            kind: "retry-branch-switch",
            label: "Retry switch",
            description: "After closing the process that is using the locked file, run the branch switch again.",
            branchFullName: fullName,
            force: false,
          },
        });
        writeClientLog("git.branch.switch.locked-file", lockedFile.title, fullDetail);
      } else {
        reportAppError({
          scope: "git.branch.switch.error",
          title: "Branch switch failed",
          fallback: "Branch switch failed.",
          reason,
          context: `Switch branch ${fullName}.`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [logFilePath, refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runForceSwitchBranch = useCallback(async (fullName: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.force-switch", `Force switching branch ${fullName}.`);
      const result = await forceSwitchBranch(selectedRepository, fullName);
      setStatusMessage(result);
      setMergeConflictState(null);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      const message = getReasonMessage(reason, "Force switch failed.");
      if (isLockedFileCheckoutError(message)) {
        const lockedFile = describeLockedFileCheckout(fullName, message);
        const occurredAt = new Date().toISOString();
        const fullDetail = [
          `Time: ${occurredAt}`,
          selectedRepository ? `Repository: ${selectedRepository}` : null,
          `Action: Force switch branch ${fullName}.`,
          `Context:\n${lockedFile.extraDetail}`,
          `Summary: ${lockedFile.summary}`,
          `Error detail:\n${message}`,
          logFilePath ? `Log file:\n${logFilePath}` : null,
        ].filter(Boolean).join("\n\n");

        setError({
          title: lockedFile.title,
          summary: lockedFile.summary,
          detail: fullDetail,
          occurredAt,
          logPath: logFilePath,
          repoPath: selectedRepository,
          recoveryAction: {
            kind: "retry-branch-switch",
            label: "Retry force switch",
            description: "After closing the process that is using the locked file, run the force switch again.",
            branchFullName: fullName,
            force: true,
          },
        });
        writeClientLog("git.branch.force-switch.locked-file", lockedFile.title, fullDetail);
      } else {
        reportAppError({
          scope: "git.branch.force-switch.error",
          title: "Force switch failed",
          fallback: "Force switch failed.",
          reason,
          context: `Force switch branch ${fullName}.`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [logFilePath, refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runCreateBranch = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    const nextName = branchCreateName.trim();

    if (!nextName) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const startPoint = selectedBranchFullName ?? branches.find((branch) => branch.isCurrent)?.fullName;
      writeClientLog("git.branch.create", `Creating branch ${nextName}.`, startPoint ?? "HEAD");
      const result = await createBranch(selectedRepository, nextName, startPoint ?? undefined, branchCreateDiscardChanges);
      setStatusMessage(result);
      setBranchCreateOpen(false);
      setBranchCreateName("");
      setBranchCreateDiscardChanges(false);
      setMergeConflictState(null);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      reportAppError({
        scope: "git.branch.create.error",
        title: "Create branch failed",
        fallback: "Create branch failed.",
        reason,
        context: `Create branch ${branchCreateName.trim()}.`,
        detail: selectedBranchFullName ?? undefined,
      });
    } finally {
      setSubmitting(false);
    }
  }, [branchCreateDiscardChanges, branchCreateName, branches, refreshRepository, reportAppError, selectedBranchFullName, selectedRepository, writeClientLog]);

  const runRenameBranch = useCallback(async (currentName: string, nextName: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.rename", `Renaming branch ${currentName} to ${nextName}.`);
      const result = await renameBranch(selectedRepository, currentName, nextName);
      setStatusMessage(result);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      reportAppError({
        scope: "git.branch.rename.error",
        title: "Branch rename failed",
        fallback: "Branch rename failed.",
        reason,
        context: `Rename branch ${currentName} to ${nextName}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const openDeleteBranchDialog = useCallback((branch: BranchEntry) => {
    const remoteFullName = branch.branchKind === "local"
      ? buildRemoteBranchRef(branch.trackingName)
      : null;

    setBranchDeleteDialog({
      branch,
      deleteRemote: false,
      remoteFullName,
      remoteLabel: branch.branchKind === "local" ? branch.trackingName : null,
    });
  }, []);

  const runConfirmDeleteBranch = useCallback(async () => {
    if (!selectedRepository || !branchDeleteDialog) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.delete", `Deleting branch ${branchDeleteDialog.branch.fullName}.`);
      const localResult = await deleteBranch(selectedRepository, branchDeleteDialog.branch.fullName);

      let finalMessage = localResult;

      if (branchDeleteDialog.deleteRemote && branchDeleteDialog.remoteFullName) {
        const remoteResult = await deleteBranch(selectedRepository, branchDeleteDialog.remoteFullName);
        finalMessage = `${localResult} ${remoteResult}`;
      }

      setStatusMessage(finalMessage);
      setBranchDeleteDialog(null);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      reportAppError({
        scope: "git.branch.delete.error",
        title: "Branch deletion failed",
        fallback: "Branch deletion failed.",
        reason,
        context: `Delete branch ${branchDeleteDialog.branch.fullName}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [branchDeleteDialog, refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runSoftPruneBranches = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.branch.prune.soft", `Soft prune requested for ${selectedRepository}.`);
      const result = await fetchRepository(selectedRepository);
      setStatusMessage(result === "Fetch completed." ? "Soft prune completed." : `Soft prune completed. ${result}`);
      await refreshRepository();
    } catch (reason) {
      const message = getReasonMessage(reason, "Soft prune failed.");
      setError(null);
      showRemoteDialog(describeRemoteFailure("fetch", message), {
        scope: "git.branch.prune.soft.error",
        context: `Soft prune for ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, showRemoteDialog, writeClientLog]);

  const runLocalHardPruneBranches = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.prune.hard-local", `Local hard prune requested for ${selectedRepository}.`);
      const result = await hardPruneLocalBranches(selectedRepository);
      setStatusMessage(result);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "git.branch.prune.hard-local.error",
        title: "Local hard prune failed",
        fallback: "Local hard prune failed.",
        reason,
        context: `Local hard prune for ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runConditionalPruneBranches = useCallback(async () => {
    if (!selectedRepository || !branchPruneDialog) {
      return;
    }

    const input: ConditionalBranchPruneInput = {
      mergedIntoBranches: branchPruneDialog.mergedEnabled
        ? [
          branchPruneDialog.mergedIntoMain ? "main" : null,
          branchPruneDialog.mergedIntoMaster ? "master" : null,
          branchPruneDialog.mergedIntoDev ? "dev" : null,
        ].filter((value): value is string => Boolean(value))
        : [],
      folderPrefixes: branchPruneDialog.folderEnabled
        ? branchPruneDialog.folderPrefixesText.split(",").map((value) => value.trim()).filter(Boolean)
        : [],
      regexPattern: branchPruneDialog.regexEnabled ? branchPruneDialog.regexPattern.trim() || undefined : undefined,
      target: branchPruneDialog.target,
    };

    if (branchPruneDialog.ageEnabled) {
      const parsedAgeValue = Number(branchPruneDialog.ageValue.trim());
      if (Number.isFinite(parsedAgeValue) && parsedAgeValue > 0) {
        input.ageValue = parsedAgeValue;
        input.ageUnit = branchPruneDialog.ageUnit;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.prune.conditional", `Conditional prune requested for ${selectedRepository}.`, JSON.stringify(input, null, 2));
      const result = await conditionalPruneBranches(selectedRepository, input);
      setStatusMessage(result);
      setBranchPruneDialog(null);
      await refreshRepository();
    } catch (reason) {
      reportAppError({
        scope: "git.branch.prune.conditional.error",
        title: "Conditional prune failed",
        fallback: "Conditional prune failed.",
        reason,
        context: `Conditional prune for ${selectedRepository}.`,
        detail: JSON.stringify(input, null, 2),
      });
    } finally {
      setSubmitting(false);
    }
  }, [branchPruneDialog, refreshRepository, reportAppError, selectedRepository, writeClientLog]);

  const runMergeBranch = useCallback(async (fullName: string, discardLocalChanges = false) => {
    if (!selectedRepository) {
      return;
    }

    const branchLabel = resolveBranchNameFromRef(fullName);

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.merge", `Merging branch ${fullName}.`, discardLocalChanges ? "discard local changes" : undefined);
      const result = await mergeBranch(selectedRepository, fullName, discardLocalChanges);
      setMergeDiscardDialog(null);
      await applyMergeBranchResult(fullName, branchLabel, result);
    } catch (reason) {
      const message = getReasonMessage(reason, "Merge failed.");

      if (!discardLocalChanges && isMergeOverwriteError(message)) {
        setMergeDiscardDialog({
          branchFullName: fullName,
          branchLabel,
        });
      } else {
        reportAppError({
          scope: "git.branch.merge.error",
          title: "Merge failed",
          fallback: "Merge failed.",
          reason,
          context: `Merge branch ${fullName}.`,
        });
      }
    } finally {
      setSubmitting(false);
    }
  }, [applyMergeBranchResult, reportAppError, selectedRepository, writeClientLog]);

  const runResolveConflicts = useCallback(async (paths: string[], strategy: "ours" | "theirs") => {
    if (!selectedRepository || paths.length === 0) {
      return;
    }

    setSubmitting(true);

    try {
      writeClientLog("git.merge.resolve", `Resolving ${paths.length} conflicted file(s).`, `${strategy}\n${paths.join("\n")}`);
      const result = await resolveConflictedFiles(selectedRepository, paths, strategy);
      setStatusMessage(result);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      reportAppError({
        scope: "git.merge.resolve.error",
        title: "Conflict resolution failed",
        fallback: "Conflict resolution failed.",
        reason,
        context: `Resolve conflicted files for ${snapshot?.currentBranch ?? selectedRepository}.`,
        detail: `${strategy}\n${paths.join("\n")}`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, reportAppError, selectedRepository, snapshot?.currentBranch, writeClientLog]);

  const resolveConflictedPathsForSelection = useCallback((selectionKeys: string[]) => {
    const conflictedPaths = new Set(
      (snapshot?.files ?? [])
        .filter((file) => file.conflicted)
        .map((file) => file.path),
    );

    return Array.from(
      new Set(
        resolveActionPathsForSelection(selectionKeys).filter((path) => conflictedPaths.has(path)),
      ),
    );
  }, [resolveActionPathsForSelection, snapshot?.files]);

  const runPush = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.push", `Pushing repository ${selectedRepository}.`);
      const result = await pushRepository(selectedRepository);
      setStatusMessage(result || "Push completed.");
      showRemoteDialog({
        tone: "info",
        title: "Push completed",
        summary: result || "Local commits were pushed to the tracked remote branch.",
      }, {
        scope: "git.push.success",
        context: `Push repository ${selectedRepository}.`,
      });
      await refreshRepository();
    } catch (reason) {
      const message = getReasonMessage(reason, "Push failed.");
      setError(null);
      showRemoteDialog(describeRemoteFailure("push", message), {
        scope: "git.push.error",
        context: `Push repository ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, showRemoteDialog, writeClientLog]);

  const runPull = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.pull", `Pull requested for ${selectedRepository}.`);
      const result = await pullRepository(selectedRepository);
      setStatusMessage(result || "Pull completed.");
      showRemoteDialog({
        tone: "info",
        title: "Pull completed",
        summary: result || "Remote commits were integrated with a fast-forward pull.",
      }, {
        scope: "git.pull.success",
        context: `Pull repository ${selectedRepository}.`,
      });
      await refreshRepository();
    } catch (reason) {
      const message = getReasonMessage(reason, "Pull failed.");
      setError(null);
      showRemoteDialog(describeRemoteFailure("pull", message), {
        scope: "git.pull.error",
        context: `Pull repository ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, showRemoteDialog, writeClientLog]);

  const runPullBranch = useCallback(async (fullName: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.branch.pull", `Pull requested for branch ${fullName}.`, selectedRepository);
      const result = await pullBranch(selectedRepository, fullName);
      setStatusMessage(result || "Branch pull completed.");
      showRemoteDialog({
        tone: "info",
        title: "Branch pull completed",
        summary: result || "The selected local branch was updated from its tracked remote without switching to it.",
      }, {
        scope: "git.branch.pull.success",
        context: `Pull branch ${fullName} for ${selectedRepository}.`,
      });
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      const message = getReasonMessage(reason, "Branch pull failed.");
      setError(null);
      showRemoteDialog(describeRemoteFailure("pull", message), {
        scope: "git.branch.pull.error",
        context: `Pull branch ${fullName} for ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, showRemoteDialog, writeClientLog]);

  const runForcePull = useCallback(async () => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);
    setRemoteDialog(null);

    try {
      writeClientLog("git.force-pull", `Force pull requested for ${selectedRepository}.`);
      const result = await forcePullRepository(selectedRepository);
      setStatusMessage(result);
      setError(null);
      showRemoteDialog({
        tone: "info",
        title: "Force pull completed",
        summary: result,
      }, {
        scope: "git.force-pull.success",
        context: `Force pull repository ${selectedRepository}.`,
      });
      await refreshRepository();
    } catch (reason) {
      const message = getReasonMessage(reason, "Force pull failed.");
      setError(null);
      showRemoteDialog(describeRemoteFailure("force-pull", message), {
        scope: "git.force-pull.error",
        context: `Force pull repository ${selectedRepository}.`,
      });
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, showRemoteDialog, writeClientLog]);

  return (
    <div className="shell">
      <div
        className={clsx("git-activity-bar", gitActivityShown && "git-activity-bar--active")}
        aria-hidden={!gitActivityShown}
      >
        <div className="git-activity-bar__label">{gitActivityLabel}</div>
        <div className="git-activity-bar__track" />
        <div className="git-activity-bar__indicator" />
      </div>
      <header className="chrome panel">
        <div className="chrome__row">
          <div className="brand-block brand-block--compact">
            <h1>UniGit</h1>
          </div>

          <div className="repo-tabs panel-scroll">
            {repositories.length === 0 ? (
              <button className="repo-tab repo-tab--empty" onClick={() => setRepoManagerOpen(true)}>
                Open repository manager
              </button>
            ) : null}

            {repositories.map((repo) => {
              const active = repo === selectedRepository;
              return (
                <button
                  key={repo}
                  className={clsx("repo-tab", active && "repo-tab--active")}
                  onClick={() => selectRepository(repo)}
                  title={repo}
                >
                  <span className="repo-tab__label">{formatRepoLabel(repo)}</span>
                  <span className="repo-tab__path">{repo}</span>
                  <span
                    className="repo-tab__remove"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeRepository(repo);
                    }}
                  >
                    <X size={12} />
                  </span>
                </button>
              );
            })}
          </div>

          <button className="icon-button" onClick={() => setRepoManagerOpen(true)}>
            <Settings2 size={16} />
          </button>

          <button className="icon-button icon-button--strong" onClick={() => void pickRepository()}>
            <FolderPlus size={16} />
          </button>
        </div>

        <div className="chrome__row chrome__row--secondary">
          <div className="branch-summary">
            <div className="branch-chip">
              <GitBranch size={14} />
              <span>{branchLabel}</span>
            </div>
            {selectedRepository ? <span className="meta-inline" title={selectedRepository}>{selectedRepository}</span> : null}
          </div>

          <div className="topbar__actions">
            <div className="sync-chip">
              <span>{snapshot ? `${snapshot.ahead}/${snapshot.behind}` : "No repo"}</span>
            </div>
            <button
              className="ghost-button"
              disabled={!selectedRepository || loading || submitting || !snapshot?.behind}
              onClick={() => void runPull()}
            >
              Pull
            </button>
            <button
              className="ghost-button"
              disabled={!selectedRepository || loading || submitting}
              onClick={() => void runPush()}
            >
              Push
            </button>
            <button
              className="ghost-button ghost-button--danger"
              disabled={!selectedRepository || loading || submitting || !snapshot?.behind}
              onClick={() => void runForcePull()}
            >
              Force pull
            </button>
            <button
              className="icon-button"
              disabled={!selectedRepository || loading || submitting}
              onClick={() => void refreshRepository({ fetchRemote: true })}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {powerSummary ? <div className="power-summary">{powerSummary}</div> : null}
        {remoteDialog ? (
          <div
            className={clsx("banner", "remote-dialog", remoteDialog.tone === "error" && "remote-dialog--error")}
            onMouseEnter={() => setNotificationsHovered(true)}
            onMouseLeave={() => setNotificationsHovered(false)}
          >
            <div className="remote-dialog__header">
              <div className="error-banner__copy">
                <strong>{remoteDialog.title}</strong>
                <span title={remoteDialog.summary}>{remoteDialog.summary}</span>
              </div>
              <div className="error-banner__actions">
                <button className="ghost-button" onClick={() => setRemoteDialogOpen(true)}>
                  View details
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    writeClientLog("notification.dismiss", `Dismissed remote dialog: ${remoteDialog.title}`);
                    setRemoteDialog(null);
                  }}
                  aria-label="Dismiss remote dialog"
                  title="Dismiss remote dialog"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </header>

      <main className="workspace">

        {error ? (
          <div
            className="banner banner--error"
            onMouseEnter={() => setNotificationsHovered(true)}
            onMouseLeave={() => setNotificationsHovered(false)}
          >
            <div className="error-banner__copy">
              <strong>{error.title}</strong>
              <span title={error.summary}>{error.summary}</span>
            </div>
            <div className="error-banner__actions">
              {error.recoveryAction ? (
                <button className="ghost-button" disabled={errorRecoveryBusy} onClick={() => void runErrorRecoveryAction()}>
                  {errorRecoveryBusy ? "Fixing..." : error.recoveryAction.label}
                </button>
              ) : null}
              <button className="ghost-button" onClick={() => setErrorDialogOpen(true)}>
                View details
              </button>
              <button className="icon-button" onClick={() => setError(null)} aria-label="Dismiss error" title="Dismiss error">
                <X size={14} />
              </button>
            </div>
          </div>
        ) : null}
        {statusMessage ? (
          <div
            className="banner"
            onMouseEnter={() => setNotificationsHovered(true)}
            onMouseLeave={() => setNotificationsHovered(false)}
          >
            {statusMessage}
          </div>
        ) : null}

        {changeContextMenu ? (
          <div
            className="change-context-menu"
            style={{ left: changeContextMenu.x, top: changeContextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {changeContextMenu.item.change.conflicted ? (
              <>
                <button
                  className="ghost-button"
                  disabled={submitting || resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)).length === 0}
                  onClick={() => {
                    void runResolveConflicts(resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)), "ours");
                    setChangeContextMenu(null);
                  }}
                >
                  {resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)).length > 1 ? "Keep local for selected" : "Keep local (ours)"}
                </button>
                <button
                  className="ghost-button"
                  disabled={submitting || resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)).length === 0}
                  onClick={() => {
                    void runResolveConflicts(resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)), "theirs");
                    setChangeContextMenu(null);
                  }}
                >
                  {resolveConflictedPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)).length > 1 ? "Take incoming for selected" : "Take incoming (theirs)"}
                </button>
              </>
            ) : null}

            {changeContextMenu.lane === "unstaged" ? (
              <button
                className="ghost-button"
                disabled={submitting}
                onClick={() => {
                  void runFileOperation("stage", resolveActionPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)));
                  setChangeContextMenu(null);
                }}
              >
                {resolveContextSelectionKeys(changeContextMenu.item).length > 1 ? "Stage selected" : "Stage"}
              </button>
            ) : (
              <button
                className="ghost-button"
                disabled={submitting}
                onClick={() => {
                  void runFileOperation("unstage", resolveActionPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)));
                  setChangeContextMenu(null);
                }}
              >
                {resolveContextSelectionKeys(changeContextMenu.item).length > 1 ? "Unstage selected" : "Unstage"}
              </button>
            )}

            <button
              className="ghost-button"
              disabled={submitting}
              onClick={() => {
                void runDiscardChangePaths(resolveActionPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)));
                setChangeContextMenu(null);
              }}
            >
              {resolveContextSelectionKeys(changeContextMenu.item).length > 1 ? "Discard selected" : "Discard"}
            </button>

            {changeContextMenu.lane === "unstaged" ? (
              <button
                className="ghost-button"
                disabled={submitting}
                onClick={() => {
                  void runAddToGitignore(resolveActionPathsForSelection(resolveContextSelectionKeys(changeContextMenu.item)));
                  setChangeContextMenu(null);
                }}
              >
                Add to .gitignore
              </button>
            ) : null}

            <button
              className="ghost-button"
              onClick={() => {
                hideLocally(resolveHiddenKeysForSelection(resolveContextSelectionKeys(changeContextMenu.item)));
                setChangeContextMenu(null);
              }}
            >
              Ignore locally
            </button>
          </div>
        ) : null}

        {hiddenLocalContextMenu ? (
          <div
            className="change-context-menu"
            style={{ left: hiddenLocalContextMenu.x, top: hiddenLocalContextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button
              className="ghost-button"
              onClick={() => {
                restoreHiddenLocalKeys(resolveHiddenLocalSelection(hiddenLocalContextMenu.entry));
                setHiddenLocalContextMenu(null);
              }}
            >
              {resolveHiddenLocalSelection(hiddenLocalContextMenu.entry).length > 1 ? "Restore selected" : "Restore"}
            </button>
          </div>
        ) : null}

        <section
          ref={workspaceSplitRef}
          className="content-grid"
          style={{ gridTemplateRows: workspaceGridTemplateRows }}
        >
          <section className="panel graph-shell graph-panel--embedded">
            <div
              ref={graphSplitRef}
              className="graph-split"
              style={{ gridTemplateColumns: graphGridTemplateColumns }}
            >
              <BranchPane
                localBranches={filteredBranches.local}
                remoteBranches={filteredBranches.remote}
                filter={branchQuery}
                onFilterChange={setBranchQuery}
                selectedBranchFullName={selectedBranchFullName}
                onSelectBranch={setSelectedBranchFullName}
                onSwitchBranch={(fullName) => void runSwitchBranch(fullName)}
                onPullBranch={(fullName) => void runPullBranch(fullName)}
                onForceSwitchBranch={(fullName) => void runForceSwitchBranch(fullName)}
                onMergeBranch={(fullName) => void runMergeBranch(fullName)}
                onRenameBranch={(currentName, nextName) => void runRenameBranch(currentName, nextName)}
                onRequestDeleteBranch={openDeleteBranchDialog}
                onSoftPrune={() => void runSoftPruneBranches()}
                onLocalHardPrune={() => void runLocalHardPruneBranches()}
                onOpenConditionalPrune={() => setBranchPruneDialog(createDefaultBranchPruneDialogValue())}
                onOpenCreateBranch={() => {
                  setBranchCreateName("");
                  setBranchCreateDiscardChanges(false);
                  setBranchCreateOpen(true);
                }}
                hasMergeConflict={Boolean(mergeConflictState)}
                disabled={submitting}
              />

              <div
                className="panel-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={() => startGraphResize()}
              >
                <GripVertical size={14} />
              </div>

              <CommitGraphCanvas
                rows={filteredHistory}
                filter={historyFilter}
                onFilterChange={setHistoryFilter}
                graphScope={graphScope}
                onGraphScopeChange={setGraphScope}
                graphOrder={graphOrder}
                onGraphOrderChange={setGraphOrder}
                onLoadMore={() => void loadMoreGraph()}
                hasMore={graphHasMore}
                loading={graphLoading}
                selectedCommitHash={selectedCommitHash}
                onSelectCommit={(commitHash) => {
                  setSelectedCommitHash(commitHash);
                  setSelectedChangePath(null);
                }}
              />
            </div>
          </section>

          <div
            className="panel-resizer panel-resizer--horizontal"
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={() => startWorkspaceResize()}
          >
            <GripVertical size={14} />
          </div>

          <section className="bottom-stack">
            <section
              ref={contentGridRef}
              className="lower-grid"
              style={{ gridTemplateColumns: lowerGridTemplateColumns }}
            >
              <div ref={changesBoardRef} className={clsx("board panel board--changes", isChangesFullscreen && "board--changes--fullscreen")}>
            <div className="board__header">
              <div>
                <p className="eyebrow">Changes</p>
                <h3>Working tree</h3>
              </div>
              <div className="changes-header-actions">
                <p className="board__hint">Drag, click, commit. Nothing extra.</p>
                <button className="ghost-button" onClick={() => void toggleChangesFullscreen()} title="Toggle working tree fullscreen">
                  {isChangesFullscreen ? <Minimize2 size={15} /> : <Expand size={15} />}
                  {isChangesFullscreen ? "Window" : "Fullscreen"}
                </button>
                <button
                  className="icon-button"
                  disabled={!selectedRepository || loading || submitting}
                  onClick={() => void refreshRepository()}
                  title="Refresh changes"
                >
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>

            <div className="changes-toolbar">
              <input
                className="changes-filter"
                placeholder="Filter files"
                value={changeQuery}
                onChange={(event) => setChangeQuery(event.target.value)}
              />
              <select
                className="changes-select"
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value as ChangeSortKey)}
              >
                <option value="name">Sort: name</option>
                <option value="folder">Sort: folder</option>
                <option value="extension">Sort: extension</option>
                <option value="status">Sort: status</option>
              </select>
              <button
                className="ghost-button"
                onClick={() =>
                  setSortDirection((value) => (value === "asc" ? "desc" : "asc"))
                }
              >
                {sortDirection === "asc" ? "A-Z" : "Z-A"}
              </button>
              <button
                className={clsx("ghost-button", !showPaths && "ghost-button--active")}
                onClick={() => setShowPaths((value) => !value)}
              >
                {showPaths ? "Hide paths" : "Show paths"}
              </button>
              <button
                className={clsx("ghost-button", pairMetaFiles && "ghost-button--active")}
                onClick={() => setPairMetaFiles((value) => !value)}
              >
                {pairMetaFiles ? "Unity meta paired" : "Unity meta separate"}
              </button>
              <button
                className={clsx("ghost-button", showHiddenLocalMenu && "ghost-button--active")}
                onClick={() => setShowHiddenLocalMenu(true)}
              >
                Hidden local {hiddenLocalEntries.length ? `(${hiddenLocalEntries.length})` : ""}
              </button>
            </div>

            <div className="lanes">
              <DropLane
                title="Unstaged"
                icon={<Undo2 size={16} />}
                items={unstagedChanges}
                actionLabel="Stage"
                dropAction="unstage"
                disabled={submitting}
                onAction={(selectionKey) => void runFileOperation("stage", resolveActionPathsForSelection([selectionKey]))}
                onOpenContextMenu={openChangeContextMenu}
                onDropFiles={(paths, origin) => {
                  if (origin === "staged") {
                    void runFileOperation("unstage", paths);
                  }
                }}
                showPaths={showPaths}
                onSelect={handleSelectChange}
                selectedPaths={selectedChangePaths}
                primarySelectedPath={selectedChangePath}
                bulkActionLabel="Stage selected"
                bulkActionDisabled={submitting || selectedUnstagedPaths.length === 0}
                onBulkAction={() => void runFileOperation("stage", resolveActionPathsForSelection(selectedUnstagedPaths))}
                bulkSecondaryLabel="Stage all"
                bulkSecondaryDisabled={submitting || unstagedChanges.length === 0}
                onBulkSecondaryAction={() =>
                  void runFileOperation(
                    "stage",
                    Array.from(new Set(unstagedChanges.flatMap((item) => item.actionPaths))),
                  )
                }
                extraActions={[
                  {
                    label: "Discard selected",
                    disabled: submitting || selectedUnstagedPaths.length === 0,
                    onClick: () => void runDiscardChangePaths(resolveActionPathsForSelection(selectedUnstagedPaths)),
                    danger: true,
                  },
                  {
                    label: "Discard all",
                    disabled: submitting || unstagedChanges.length === 0,
                    onClick: () => void runDiscardAllUnstaged(),
                    danger: true,
                  },
                  {
                    label: "Ignore locally",
                    disabled: selectedUnstagedPaths.length === 0,
                    onClick: () => hideLocally(resolveHiddenKeysForSelection(selectedUnstagedPaths)),
                  },
                ]}
              />
              <DropLane
                title="Staged"
                icon={<Upload size={16} />}
                items={stagedChanges}
                actionLabel="Unstage"
                dropAction="stage"
                disabled={submitting}
                onAction={(selectionKey) => void runFileOperation("unstage", resolveActionPathsForSelection([selectionKey]))}
                onOpenContextMenu={openChangeContextMenu}
                onDropFiles={(paths, origin) => {
                  if (origin === "unstaged") {
                    void runFileOperation("stage", paths);
                  }
                }}
                showPaths={showPaths}
                onSelect={handleSelectChange}
                selectedPaths={selectedChangePaths}
                primarySelectedPath={selectedChangePath}
                bulkActionLabel="Unstage selected"
                bulkActionDisabled={submitting || selectedStagedPaths.length === 0}
                onBulkAction={() => void runFileOperation("unstage", resolveActionPathsForSelection(selectedStagedPaths))}
                extraActions={[
                  {
                    label: "Discard selected",
                    disabled: submitting || selectedStagedPaths.length === 0,
                    onClick: () => void runDiscardChangePaths(resolveActionPathsForSelection(selectedStagedPaths)),
                    danger: true,
                  },
                  {
                    label: "Ignore locally",
                    disabled: selectedStagedPaths.length === 0,
                    onClick: () => hideLocally(resolveHiddenKeysForSelection(selectedStagedPaths)),
                  },
                ]}
              />
            </div>
            </div>

          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={() => startResize()}
          >
            <GripVertical size={14} />
          </div>

          <section
            ref={inspectorRef}
            className={clsx(
              "panel inspector inspector--long",
              mergeConflictState && "inspector--conflicted",
              isInspectorFullscreen && "inspector--fullscreen",
            )}
          >
            <div className="board__header">
              <div>
                <p className="eyebrow">Selection</p>
                <h3 className="title-truncate" title={selectedChange?.path ?? selectedCommit?.subject ?? undefined}>
                  {selectedChange?.path ?? selectedCommit?.subject ?? "Nothing selected"}
                </h3>
              </div>
              <button className="ghost-button" onClick={() => void toggleInspectorFullscreen()}>
                {isInspectorFullscreen ? <Minimize2 size={15} /> : <Expand size={15} />}
                {isInspectorFullscreen ? "Window" : "Fullscreen"}
              </button>
            </div>
            {mergeConflictState ? (
              <div className="selection-conflict-banner">
                <span className="pill pill--mixed">Merge conflict</span>
                <strong>{mergeConflictState.branchLabel}</strong>
                <span className="muted">{mergeConflictState.conflictedFiles.length} conflicted file(s)</span>
                <button className="ghost-button" disabled={submitting} onClick={() => setConflictDialogOpen(true)}>
                  Resolve conflicts
                </button>
              </div>
            ) : null}
            {selectedChange ? (
              <div className={clsx("selection-card", !isInspectorFullscreen && "panel-scroll", isInspectorFullscreen && "selection-card--split")}>
                <span className={clsx("pill", `pill--${getStatusTone(selectedChange)}`)}>
                  {selectedChange.displayStatus}
                </span>
                <dl>
                  <div>
                    <dt>Index</dt>
                    <dd>{selectedChange.indexStatus || "clean"}</dd>
                  </div>
                  <div>
                    <dt>Working tree</dt>
                    <dd>{selectedChange.worktreeStatus || "clean"}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{previewLoading ? "Loading" : preview?.supportHint ?? "Not loaded"}</dd>
                  </div>
                </dl>

                {selectedChange.conflicted ? (
                  <div className="branch-selection-actions">
                    <span className="pill pill--mixed">Unmerged</span>
                    <button
                      className="ghost-button"
                      disabled={submitting}
                      onClick={() => void runResolveConflicts([selectedChange.path], "ours")}
                    >
                      Keep local (ours)
                    </button>
                    <button
                      className="ghost-button"
                      disabled={submitting}
                      onClick={() => void runResolveConflicts([selectedChange.path], "theirs")}
                    >
                      Take incoming (theirs)
                    </button>
                  </div>
                ) : null}

                <div
                  ref={isInspectorFullscreen ? inspectorSplitRef : undefined}
                  className={clsx(isInspectorFullscreen && "inspector-content-split")}
                  style={isInspectorFullscreen ? { gridTemplateRows: inspectorGridTemplateRows } : undefined}
                >
                  <div className={clsx(isInspectorFullscreen && "inspector-pane panel-scroll")}>
                    <div className="preview-panel">
                      <div className="preview-panel__header">
                        <strong>{previewHeading}</strong>
                        <div className="preview-panel__header-actions">
                          {canToggleMaterialTextPreview ? (
                            <>
                              <button className={clsx("ghost-button", materialPreviewMode === "preview" && "ghost-button--active")} onClick={() => setMaterialPreviewMode("preview")}>
                                Preview
                              </button>
                              <button className={clsx("ghost-button", materialPreviewMode === "text" && "ghost-button--active")} onClick={() => setMaterialPreviewMode("text")}>
                                Text
                              </button>
                            </>
                          ) : null}
                          {preview ? (
                            <span className="preview-panel__meta">{formatFileSize(preview.fileSizeBytes)}</span>
                          ) : null}
                        </div>
                      </div>

                      {previewLoading ? <p className="muted">Loading preview...</p> : null}
                      {previewError ? <p className="muted">{previewError}</p> : null}

                      {renderDiffStack(false)}
                      {previewBodyContent}
                    </div>
                  </div>

                  {isInspectorFullscreen ? (
                    <div
                      className="panel-resizer panel-resizer--horizontal"
                      role="separator"
                      aria-orientation="horizontal"
                      onPointerDown={() => startInspectorResize()}
                    >
                      <GripVertical size={14} />
                    </div>
                  ) : null}

                  <div className={clsx("file-history-list", isInspectorFullscreen && "inspector-pane panel-scroll")}>
                    <div className="preview-panel__header">
                      <strong>File history</strong>
                      <span className="preview-panel__meta">{fileHistory.length}</span>
                    </div>

                    {fileHistoryLoading ? <p className="muted">Loading file history...</p> : null}
                    {fileHistoryError ? <p className="muted">{fileHistoryError}</p> : null}

                    {!fileHistoryLoading && !fileHistoryError
                      ? fileHistory.map((entry) => (
                          <div key={`${entry.hash}-${selectedChange.path}`} className="file-history-row">
                            <div className="file-history-row__main">
                              <span className="pill pill--default">{entry.shortHash}</span>
                              <div className="file-history-row__text">
                                <strong title={entry.subject}>{entry.subject}</strong>
                                <p>{entry.authorName} {formatRelativeTime(entry.authoredAt)}</p>
                              </div>
                            </div>
                            <div className="file-history-row__actions">
                              <button
                                className="ghost-button"
                                disabled={submitting}
                                onClick={() => {
                                  setSelectedCommitHash(entry.hash);
                                  setSelectedChangePath(null);
                                }}
                              >
                                View
                              </button>
                              <button
                                className="ghost-button"
                                disabled={submitting}
                                onClick={() => void exportCommitFile(entry.hash, selectedChange.path)}
                              >
                                Export
                              </button>
                              <button
                                className="ghost-button"
                                disabled={submitting}
                                onClick={() => void restoreCommitFile(entry.hash, selectedChange.path)}
                              >
                                Restore
                              </button>
                              <button
                                className="ghost-button"
                                disabled={submitting}
                                onClick={() => void applyFilePatchFromCommit(entry.hash, selectedChange.path, false)}
                              >
                                Apply
                              </button>
                              <button
                                className="ghost-button"
                                disabled={submitting}
                                onClick={() => void applyFilePatchFromCommit(entry.hash, selectedChange.path, true)}
                              >
                                Revert
                              </button>
                            </div>
                          </div>
                        ))
                      : null}
                  </div>
                </div>
              </div>
            ) : selectedCommitHash ? (
              <div className="selection-card panel-scroll">
                {commitDetailLoading ? <p className="muted">Loading commit details...</p> : null}
                {commitDetailError ? <p className="muted">{commitDetailError}</p> : null}

                {!commitDetailLoading && !commitDetailError && commitDetail ? (
                  <>
                    <span className="pill pill--accent">Commit {commitDetail.shortHash}</span>
                    {selectedCommitBranch ? (
                      <div className="branch-selection-actions">
                        {selectedCommitBranches.length > 1 ? (
                          <select
                            className="changes-select"
                            value={selectedCommitBranch.fullName}
                            onChange={(event) => setSelectedCommitBranchFullName(event.target.value)}
                          >
                            {selectedCommitBranches.map((branch) => (
                              <option key={branch.fullName} value={branch.fullName}>{branch.name}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="pill pill--default">Branch {selectedCommitBranch.name}</span>
                        )}
                        <button className="ghost-button" disabled={submitting || selectedCommitBranch.isCurrent} onClick={() => void runSwitchBranch(selectedCommitBranch.fullName)}>
                          Switch to
                        </button>
                        <button className="ghost-button" disabled={submitting || selectedCommitBranch.isCurrent} onClick={() => void runForceSwitchBranch(selectedCommitBranch.fullName)}>
                          Force switch
                        </button>
                        <button className="ghost-button" disabled={submitting || selectedCommitBranch.isCurrent} onClick={() => void runMergeBranch(selectedCommitBranch.fullName)}>
                          Merge
                        </button>
                      </div>
                    ) : null}
                    <dl>
                      <div>
                        <dt>Author</dt>
                        <dd>{commitDetail.authorName}</dd>
                      </div>
                      <div>
                        <dt>Email</dt>
                        <dd>{commitDetail.authorEmail}</dd>
                      </div>
                      <div>
                        <dt>Authored</dt>
                        <dd>{formatRelativeTime(commitDetail.authoredAt)}</dd>
                      </div>
                      <div>
                        <dt>Parents</dt>
                        <dd>{commitDetail.parentHashes.length || 0}</dd>
                      </div>
                    </dl>

                    {commitDetail.body ? (
                      <div className="preview-frame preview-frame--placeholder">
                        <p>{commitDetail.body}</p>
                      </div>
                    ) : null}

                    <div className="commit-file-list">
                      <div className="preview-panel__header">
                        <strong>Files in commit</strong>
                        <span className="preview-panel__meta">{commitDetail.files.length}</span>
                      </div>
                      {commitDetail.files.map((file) => (
                        <div key={`${commitDetail.hash}-${file.path}`} className="commit-file-row">
                          <div className="commit-file-row__main">
                            <span className="pill pill--default">{file.status}</span>
                            <strong title={file.path}>{file.path}</strong>
                          </div>
                          <div className="commit-file-row__actions">
                            <span className="preview-panel__meta">
                              {file.additions ?? 0}+ / {file.deletions ?? 0}-
                            </span>
                            <button
                              className="ghost-button"
                              disabled={submitting}
                              onClick={() => void exportCommitFile(commitDetail.hash, file.path)}
                            >
                              Export
                            </button>
                            <button
                              className="ghost-button"
                              disabled={submitting}
                              onClick={() => void restoreCommitFile(commitDetail.hash, file.path)}
                            >
                              Restore
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : (
              <p className="muted">Pick a file to inspect its current Git state.</p>
            )}
          </section>
            </section>

            <section className="panel commit-shell">
              <div className="commit-box">
                <div className="commit-box__editor">
                  <textarea
                    className="commit-box__input"
                    placeholder="Commit message"
                    value={commitMessage}
                    onChange={(event) => setCommitMessage(event.target.value)}
                  />
                  {aiGeneratingCommitMessage ? (
                    <div className="commit-box__overlay" aria-live="polite" aria-label="Generating commit message">
                      <div className="commit-box__spinner" />
                      <span>Generating commit message...</span>
                    </div>
                  ) : null}
                  <span title={aiCommitDisabledReason ?? "Generate a commit message from staged changes and unpushed commits."}>
                    <button
                      className={clsx("icon-button", "commit-box__ai-button", !aiCommitEnabled && "commit-box__ai-button--disabled")}
                      disabled={!aiCommitEnabled}
                      onClick={() => void runGenerateCommitMessage()}
                      aria-label="Generate commit message with AI"
                    >
                      <Sparkles size={16} />
                    </button>
                  </span>
                </div>
                <div className="commit-box__actions">
                  <button
                    className="ghost-button"
                    disabled={!stagedChanges.length || !commitMessage.trim() || submitting || aiGeneratingCommitMessage}
                    onClick={() => void commitAndPushChanges()}
                  >
                    <GitCommitHorizontal size={16} />
                    Commit & Push
                  </button>
                  <button
                    className="primary-button"
                    disabled={!stagedChanges.length || !commitMessage.trim() || submitting || aiGeneratingCommitMessage}
                    onClick={() => void commitChanges()}
                  >
                    <GitCommitHorizontal size={16} />
                    Commit staged
                  </button>
                </div>
              </div>
            </section>
          </section>
        </section>
      </main>

      {showRepoManager ? (
        <RepoManagerDialog
          repositories={repositories}
          selectedRepository={selectedRepository}
          onSelectRepository={selectRepository}
          onAddExistingRepository={() => void pickRepository()}
          onRemoveRepository={removeRepository}
          onClose={() => setRepoManagerOpen(false)}
          canClose={repositories.length > 0}
          cloneUrl={cloneUrl}
          onCloneUrlChange={setCloneUrl}
          cloneDestination={cloneDestination}
          onCloneDestinationChange={setCloneDestination}
          onPickCloneDestination={() => void pickCloneDestination()}
          onClone={() => void runCloneRepository()}
          cloneDisabled={submitting || !cloneUrl.trim() || !cloneDestination.trim()}
          repoConfig={repoConfig}
          repoConfigLoading={repoConfigLoading}
          repoConfigError={repoConfigError}
          onSaveRemote={(originalName, name, fetchUrl, pushUrl) =>
            void runSaveRepositoryRemote(originalName, name, fetchUrl, pushUrl)
          }
          onDeleteRemote={(name) => void runDeleteRepositoryRemote(name)}
          onSaveSshSettings={(settings) => void runSaveRepositorySshSettings(settings)}
          onPickSshPrivateKey={() => pickRepositorySshPrivateKey()}
          settingsDisabled={submitting}
          aiSettings={aiSettings}
          onAiSettingsChange={setAiSettings}
          themeSettings={themeSettings}
          onThemeSettingsChange={setThemeSettings}
          themeValidationError={getThemeSettingsValidationError(themeSettings)}
        />
      ) : null}

      {showHiddenLocalMenu ? (
        <HiddenLocalDialog
          entries={hiddenLocalEntries}
          selectedKeys={selectedHiddenLocalKeys}
          onSelect={handleSelectHiddenLocal}
          onOpenContextMenu={openHiddenLocalContextMenu}
          onRestoreOne={(key) => restoreHiddenLocalKeys([key])}
          onRestoreSelected={() => restoreHiddenLocalKeys(selectedHiddenLocalKeys)}
          onClose={() => {
            setShowHiddenLocalMenu(false);
            setHiddenLocalContextMenu(null);
          }}
        />
      ) : null}

      {error && errorDialogOpen ? (
        <ErrorDetailDialog
          error={error}
          onClose={() => setErrorDialogOpen(false)}
          onRunRecoveryAction={error.recoveryAction ? () => void runErrorRecoveryAction() : undefined}
          recoveryBusy={errorRecoveryBusy}
        />
      ) : null}

      {remoteDialog && remoteDialogOpen ? (
        <RemoteDetailDialog dialog={remoteDialog} onClose={() => setRemoteDialogOpen(false)} />
      ) : null}

      {selectedChange && preview && hasDiffContent(preview) && diffDialogOpen ? (
        <div className="dialog-backdrop dialog-backdrop--diff" onClick={() => setDiffDialogOpen(false)}>
          <section className="panel diff-viewer-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="diff-viewer-dialog__header">
              <div>
                <p className="eyebrow">Diff Viewer</p>
                <h3 title={selectedChange.path}>{selectedChange.path}</h3>
                <p className="muted">Expanded diff view for detailed inspection.</p>
              </div>
              <button className="icon-button" onClick={() => setDiffDialogOpen(false)} aria-label="Close diff viewer" title="Close diff viewer">
                <X size={14} />
              </button>
            </div>

            <div className="diff-viewer-dialog__body panel-scroll">
              {renderDiffStack(true)}
            </div>
          </section>
        </div>
      ) : null}

      {branchCreateOpen ? (
        <BranchCreateDialog
          baseLabel={branchCreateBaseLabel}
          value={branchCreateName}
          discardChanges={branchCreateDiscardChanges}
          disabled={submitting}
          onChangeValue={setBranchCreateName}
          onChangeDiscard={setBranchCreateDiscardChanges}
          onClose={() => setBranchCreateOpen(false)}
          onSubmit={() => void runCreateBranch()}
        />
      ) : null}

      {branchDeleteDialog ? (
        <BranchDeleteDialog
          branch={branchDeleteDialog.branch}
          deleteRemote={branchDeleteDialog.deleteRemote}
          remoteLabel={branchDeleteDialog.remoteLabel}
          disabled={submitting}
          onChangeDeleteRemote={(value) => setBranchDeleteDialog((current) => current ? { ...current, deleteRemote: value } : current)}
          onClose={() => setBranchDeleteDialog(null)}
          onConfirm={() => void runConfirmDeleteBranch()}
        />
      ) : null}

      {branchPruneDialog ? (
        <BranchPruneDialog
          value={branchPruneDialog}
          disabled={submitting}
          onChange={setBranchPruneDialog}
          onClose={() => setBranchPruneDialog(null)}
          onConfirm={() => void runConditionalPruneBranches()}
        />
      ) : null}

      {mergeDiscardDialog ? (
        <MergeDiscardDialog
          branchLabel={mergeDiscardDialog.branchLabel}
          disabled={submitting}
          onClose={() => setMergeDiscardDialog(null)}
          onConfirm={() => void runMergeBranch(mergeDiscardDialog.branchFullName, true)}
        />
      ) : null}

      {mergeConflictState && conflictDialogOpen ? (
        <ConflictResolutionDialog
          branchLabel={mergeConflictState.branchLabel}
          conflictedFiles={mergeConflictState.conflictedFiles}
          disabled={submitting}
          onClose={() => setConflictDialogOpen(false)}
          onResolve={(paths, strategy) => void runResolveConflicts(paths, strategy)}
        />
      ) : null}
    </div>
  );
}
