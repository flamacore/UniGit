import { open, save } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  RefreshCw,
  Settings2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BranchPane } from "./components/BranchPane";
import { CommitGraphCanvas } from "./CommitGraphCanvas";
import { DropLane } from "./components/DropLane";
import { useChangeWorkbench } from "./hooks/useChangeWorkbench";
import { HiddenLocalDialog } from "./components/HiddenLocalDialog";
import { RepoManagerDialog } from "./components/RepoManagerDialog";
import type {
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
  CloneResult,
  CommitDetail,
  CommitGraphPage,
  CommitGraphRow,
  FileChange,
  FileHistoryEntry,
  FilePreview,
  RepositoryConfig,
  RepositorySnapshot,
  cloneRepository,
  createCommit,
  discardPaths,
  deleteRepositoryRemote,
  deleteBranch,
  exportFileFromCommit,
  fetchRepository,
  forcePullRepository,
  inspectCommitDetail,
  inspectFilePreview,
  inspectRepository,
  inspectRepositoryConfig,
  listBranches,
  listFileHistory,
  listCommitGraph,
  logClientEvent,
  pullRepository,
  pushRepository,
  renameBranch,
  restoreFileFromCommit,
  saveRepositoryRemote,
  stageFiles,
  switchBranch,
  unstageFiles,
} from "../features/repositories/api";
import { useRepositoryStore } from "../features/repositories/store/useRepositoryStore";
import { isTauri } from "../lib/tauri";

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
  const [commitGraph, setCommitGraph] = useState<CommitGraphRow[]>([]);
  const [graphNextSkip, setGraphNextSkip] = useState(0);
  const [graphHasMore, setGraphHasMore] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [remoteDialog, setRemoteDialog] = useState<RemoteDialogState | null>(null);
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
  const [fileHistory, setFileHistory] = useState<FileHistoryEntry[]>([]);
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false);
  const [fileHistoryError, setFileHistoryError] = useState<string | null>(null);
  const [changeQuery, setChangeQuery] = useState("");
  const [pairMetaFiles, setPairMetaFiles] = useState(true);
  const [showHiddenLocalMenu, setShowHiddenLocalMenu] = useState(false);
  const [showPaths, setShowPaths] = useState(true);
  const [sortBy, setSortBy] = useState<ChangeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [graphFractions, setGraphFractions] = useState({ left: 0.26, right: 0.74 });
  const [panelFractions, setPanelFractions] = useState({ left: 0.6, right: 0.4 });
  const graphSplitRef = useRef<HTMLDivElement | null>(null);
  const contentGridRef = useRef<HTMLElement | null>(null);

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
          const message = reason instanceof Error ? reason.message : "Fetch failed.";
          setRemoteDialog(describeRemoteFailure("fetch", message));
          writeClientLog("git.fetch.error", `Fetch failed for ${selectedRepository}.`, message);
        }
      }

      const [nextSnapshot, nextBranches, nextGraph] = await Promise.all([
        inspectRepository(selectedRepository),
        listBranches(selectedRepository),
        listCommitGraph(selectedRepository, 260, 0),
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
      const message =
        reason instanceof Error ? reason.message : "Failed to read repository.";
      setError(message);
      setSnapshot(null);
      setCommitGraph([]);
      setGraphHasMore(false);
      setGraphNextSkip(0);
    } finally {
      setLoading(false);
      setGraphLoading(false);
    }
  }, [applyGraphPage, selectedChangePath, selectedCommitHash, selectedRepository, selectionAnchorPath, writeClientLog]);

  const loadMoreGraph = useCallback(async () => {
    if (!selectedRepository || graphLoading || !graphHasMore) {
      return;
    }

    setGraphLoading(true);

    try {
      const nextPage = await listCommitGraph(selectedRepository, 260, graphNextSkip);
      applyGraphPage(nextPage, "append");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Graph loading failed.");
    } finally {
      setGraphLoading(false);
    }
  }, [applyGraphPage, graphHasMore, graphLoading, graphNextSkip, selectedRepository]);

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

  const showRepoManager = repoManagerOpen || repositories.length === 0;

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

    if (error) {
      timers.push(window.setTimeout(() => setError(null), 9000));
    }

    if (remoteDialog) {
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
  }, [error, notificationsHovered, remoteDialog, statusMessage]);


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

  const runCloneRepository = useCallback(async () => {
    if (!cloneUrl.trim() || !cloneDestination.trim()) {
      setError("Clone URL and destination path are required.");
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
      const message = reason instanceof Error ? reason.message : "Clone failed.";
      setError(message);
      writeClientLog("repo.clone.error", `Clone failed for ${cloneUrl.trim()}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [addRepository, cloneDestination, cloneUrl, refreshRepository, writeClientLog]);

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
      const message = reason instanceof Error ? reason.message : "Discard failed.";
      setError(message);
      writeClientLog("git.discard.error", `Discard failed for ${paths.length} path(s).`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      const message = reason instanceof Error ? reason.message : "Updating .gitignore failed.";
      setError(message);
      writeClientLog("git.gitignore.add.error", `Updating .gitignore failed for ${paths.length} path(s).`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      const message = reason instanceof Error ? reason.message : "Saving remote failed.";
      setError(message);
      writeClientLog("repo.remote.save.error", `Saving remote failed for ${originalName ?? name}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [selectedRepository, writeClientLog]);

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
      const message = reason instanceof Error ? reason.message : "Removing remote failed.";
      setError(message);
      writeClientLog("repo.remote.delete.error", `Removing remote failed for ${name}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [selectedRepository, writeClientLog]);

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
        setError(reason instanceof Error ? reason.message : "Git operation failed.");
        writeClientLog(
          "git.stage.error",
          `Failed to ${mode} ${paths.length} path(s).`,
          reason instanceof Error ? reason.message : "Git operation failed.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [refreshRepository, selectedRepository, writeClientLog],
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
      setError(reason instanceof Error ? reason.message : "Commit failed.");
      writeClientLog(
        "git.commit.error",
        "Commit failed.",
        reason instanceof Error ? reason.message : "Commit failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [commitMessage, refreshRepository, selectedRepository, writeClientLog]);

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
      setRemoteDialog({
        tone: "info",
        title: "Commit and push completed",
        summary: pushResult || "Staged changes were committed and pushed to the tracked remote branch.",
      });
      await refreshRepository();
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : "Commit and push failed.";

      if (committed) {
        setError(null);
        setStatusMessage("Committed staged changes locally. Push failed.");
        setRemoteDialog(describeRemoteFailure("push", failure));
        writeClientLog("git.push.error", `Push after commit failed for ${selectedRepository}.`, failure);
        await refreshRepository();
      } else {
        setError(failure);
        writeClientLog("git.commit.error", "Commit before push failed.", failure);
      }
    } finally {
      setSubmitting(false);
    }
  }, [commitMessage, refreshRepository, selectedRepository, writeClientLog]);

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
      setError(reason instanceof Error ? reason.message : "Commit file export failed.");
      writeClientLog(
        "history.export.error",
        `Export failed for ${relativePath} from ${commitHash}.`,
        reason instanceof Error ? reason.message : "Commit file export failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [selectedRepository, writeClientLog]);

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
      setError(reason instanceof Error ? reason.message : "Commit file restore failed.");
      writeClientLog(
        "history.restore.error",
        `Restore failed for ${relativePath} from ${commitHash}.`,
        reason instanceof Error ? reason.message : "Commit file restore failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      setError(reason instanceof Error ? reason.message : "Commit file patch failed.");
      writeClientLog(
        reverse ? "history.patch.reverse.error" : "history.patch.apply.error",
        `${reverse ? "Reverse" : "Apply"} patch failed for ${relativePath} from ${commitHash}.`,
        reason instanceof Error ? reason.message : "Commit file patch failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

  const selectedBranch = useMemo(
    () => branches.find((branch) => branch.fullName === selectedBranchFullName) ?? null,
    [branches, selectedBranchFullName],
  );

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

  const lowerGridTemplateColumns = useMemo(() => {
    return `${panelFractions.left}fr 12px ${panelFractions.right}fr`;
  }, [panelFractions]);

  const graphGridTemplateColumns = useMemo(() => {
    return `${graphFractions.left}fr 12px ${graphFractions.right}fr`;
  }, [graphFractions]);

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
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Branch switch failed.";
      setError(message);
      writeClientLog("git.branch.switch.error", `Branch switch failed for ${fullName}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      await refreshRepository();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Branch rename failed.";
      setError(message);
      writeClientLog("git.branch.rename.error", `Branch rename failed for ${currentName}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

  const runDeleteBranch = useCallback(async (fullName: string) => {
    if (!selectedRepository) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      writeClientLog("git.branch.delete", `Deleting branch ${fullName}.`);
      const result = await deleteBranch(selectedRepository, fullName);
      setStatusMessage(result);
      await refreshRepository({ fetchRemote: true });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Branch deletion failed.";
      setError(message);
      writeClientLog("git.branch.delete.error", `Branch deletion failed for ${fullName}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      setRemoteDialog({
        tone: "info",
        title: "Push completed",
        summary: result || "Local commits were pushed to the tracked remote branch.",
      });
      await refreshRepository();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Push failed.";
      setError(null);
      setRemoteDialog(describeRemoteFailure("push", message));
      writeClientLog("git.push.error", `Push failed for ${selectedRepository}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      setRemoteDialog({
        tone: "info",
        title: "Pull completed",
        summary: result || "Remote commits were integrated with a fast-forward pull.",
      });
      await refreshRepository();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Pull failed.";
      setError(null);
      setRemoteDialog(describeRemoteFailure("pull", message));
      writeClientLog("git.pull.error", `Pull failed for ${selectedRepository}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

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
      setRemoteDialog({
        tone: "info",
        title: "Force pull completed",
        summary: result,
      });
      await refreshRepository();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Force pull failed.";
      setError(null);
      setRemoteDialog(describeRemoteFailure("force-pull", message));
      writeClientLog("git.force-pull.error", `Force pull failed for ${selectedRepository}.`, message);
    } finally {
      setSubmitting(false);
    }
  }, [refreshRepository, selectedRepository, writeClientLog]);

  return (
    <div className="shell">
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
              <strong>{remoteDialog.title}</strong>
              <button
                className="icon-button"
                onClick={() => {
                  writeClientLog("notification.dismiss", `Dismissed remote dialog: ${remoteDialog.title}`);
                  setRemoteDialog(null);
                }}
              >
                <X size={14} />
              </button>
            </div>
            <p>{remoteDialog.summary}</p>
            {remoteDialog.detail ? (
              <div className="remote-dialog__detail-block">
                <span className="remote-dialog__detail-label">Git said</span>
                <pre className="remote-dialog__detail">{remoteDialog.detail}</pre>
              </div>
            ) : null}
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
            {error}
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

        <section className="content-grid">
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
                onRenameBranch={(currentName, nextName) => void runRenameBranch(currentName, nextName)}
                onDeleteBranch={(fullName) => void runDeleteBranch(fullName)}
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

          <section
            ref={contentGridRef}
            className="lower-grid"
            style={{ gridTemplateColumns: lowerGridTemplateColumns }}
          >
            <div className="board panel board--changes">
            <div className="board__header">
              <div>
                <p className="eyebrow">Changes</p>
                <h3>Working tree</h3>
              </div>
              <div className="changes-header-actions">
                <p className="board__hint">Drag, click, commit. Nothing extra.</p>
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

          <section className="panel inspector inspector--long">
            <div className="board__header">
              <div>
                <p className="eyebrow">Selection</p>
                <h3 className="title-truncate" title={selectedChange?.path ?? selectedCommit?.subject ?? undefined}>
                  {selectedChange?.path ?? selectedCommit?.subject ?? "Nothing selected"}
                </h3>
              </div>
            </div>
            {selectedChange ? (
              <div className="selection-card panel-scroll">
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

                <div className="preview-panel">
                  <div className="preview-panel__header">
                    <strong>{previewHeading}</strong>
                    {preview ? (
                      <span className="preview-panel__meta">{formatFileSize(preview.fileSizeBytes)}</span>
                    ) : null}
                  </div>

                  {previewLoading ? <p className="muted">Loading preview...</p> : null}
                  {previewError ? <p className="muted">{previewError}</p> : null}

                  {!previewLoading && !previewError && hasDiffContent(preview) ? (
                    <div className="diff-stack">
                      <div className="preview-panel__header">
                        <strong>Exact changes</strong>
                        <span className="preview-panel__meta">Git diff</span>
                      </div>

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
                  ) : null}

                  {!previewLoading && !previewError && preview?.previewKind === "image" && preview.imageDataUrl ? (
                    <div className="preview-frame">
                      <img className="preview-image" src={preview.imageDataUrl} alt={preview.relativePath} />
                    </div>
                  ) : null}

                  {!previewLoading && !previewError && preview?.previewKind === "text" ? (
                    <div className="preview-frame preview-frame--code">
                      <pre className="preview-code">{preview.textExcerpt}</pre>
                    </div>
                  ) : null}

                  {!previewLoading && !previewError && preview && preview.previewKind !== "image" && preview.previewKind !== "text" ? (
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

                  <div className="file-history-list">
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
              <textarea
                className="commit-box__input"
                placeholder="Commit message"
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
              />
              <div className="commit-box__actions">
                <button
                  className="ghost-button"
                  disabled={!stagedChanges.length || !commitMessage.trim() || submitting}
                  onClick={() => void commitAndPushChanges()}
                >
                  <GitCommitHorizontal size={16} />
                  Commit & Push
                </button>
                <button
                  className="primary-button"
                  disabled={!stagedChanges.length || !commitMessage.trim() || submitting}
                  onClick={() => void commitChanges()}
                >
                  <GitCommitHorizontal size={16} />
                  Commit staged
                </button>
              </div>
            </div>
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
          settingsDisabled={submitting}
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
    </div>
  );
}
