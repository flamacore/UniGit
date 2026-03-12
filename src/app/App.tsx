import { open, save } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  ChevronDown,
  ChevronRight,
  Expand,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  Minimize2,
  RefreshCw,
  Settings2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommitGraphCanvas } from "./CommitGraphCanvas";
import {
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

const formatRelativeTime = (iso: string) => {
  const date = new Date(iso);
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);

  if (Number.isNaN(minutes)) {
    return iso;
  }

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);
  return `${days}d ago`;
};

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const formatUnixTimestamp = (timestamp: number | null) => {
  if (!timestamp) {
    return "Unknown";
  }

  return new Date(timestamp * 1000).toLocaleString();
};

const hasDiffContent = (preview: FilePreview | null) => {
  return Boolean(preview?.stagedDiff || preview?.unstagedDiff);
};

const getDiffLineClassName = (line: string) => {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "diff-line diff-line--file";
  }

  if (line.startsWith("@@")) {
    return "diff-line diff-line--hunk";
  }

  if (line.startsWith("+")) {
    return "diff-line diff-line--added";
  }

  if (line.startsWith("-")) {
    return "diff-line diff-line--removed";
  }

  return "diff-line";
};

type ChangeSortKey = "name" | "folder" | "extension" | "status";

type ChangeListOptions = {
  query: string;
  showPaths: boolean;
  sortBy: ChangeSortKey;
  sortDirection: "asc" | "desc";
};

type ChangeListItem = {
  change: FileChange;
  isMeta: boolean;
  fileName: string;
  parentPath: string;
  marker: {
    tone: string;
    label: string;
  };
};

type RemoteDialogState = {
  tone: "error" | "info";
  title: string;
  summary: string;
  detail?: string;
};

const formatRepoLabel = (path: string) => {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
};

const normalizePath = (path: string) => path.replace(/\\/g, "/");

const isMetaFile = (path: string) => normalizePath(path).endsWith(".meta");

const getPairKey = (path: string) => {
  const normalized = normalizePath(path);
  return normalized.endsWith(".meta") ? normalized.slice(0, -5) : normalized;
};

const splitPathForDisplay = (path: string) => {
  const normalized = normalizePath(path);
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length <= 1) {
    return {
      fileName: normalized,
      parentPath: "",
    };
  }

  return {
    fileName: segments[segments.length - 1] ?? normalized,
    parentPath: segments.slice(0, -1).join("/"),
  };
};

const getChangeMarker = (change: FileChange) => {
  if (change.conflicted) {
    return { tone: "conflict", label: "Conflict" };
  }

  if (
    change.indexStatus === "deleted" ||
    change.worktreeStatus === "deleted"
  ) {
    return { tone: "removed", label: "Removed" };
  }

  if (
    change.indexStatus === "renamed" ||
    change.worktreeStatus === "renamed" ||
    change.indexStatus === "copied" ||
    change.worktreeStatus === "copied"
  ) {
    return { tone: "moved", label: "Moved or renamed" };
  }

  if (change.stagedModified) {
    return { tone: "restaged", label: "Changed after staging" };
  }

  if (change.untracked) {
    return { tone: "new", label: "Untracked" };
  }

  if (change.indexStatus === "added" || change.worktreeStatus === "added") {
    return { tone: "added", label: "Added" };
  }

  return { tone: "changed", label: "Changed" };
};

const describeRemoteFailure = (operation: "push" | "pull" | "force-pull" | "fetch", message: string): RemoteDialogState => {
  const normalized = message.toLowerCase();

  if (normalized.includes("has no upstream branch") || normalized.includes("no upstream branch")) {
    return {
      tone: "error",
      title: operation === "push"
        ? "Push is missing an upstream"
        : operation === "fetch"
          ? "Fetch needs a configured remote"
          : "Pull needs an upstream",
      summary: "The current branch is not tracking a remote branch yet.",
      detail: message,
    };
  }

  if (normalized.includes("failed to push some refs") || normalized.includes("fetch first") || normalized.includes("non-fast-forward")) {
    return {
      tone: "error",
      title: "Push was rejected by the remote",
      summary: "The remote branch has commits you do not have locally. Pull or reconcile history before pushing.",
      detail: message,
    };
  }

  if (normalized.includes("permission denied") || normalized.includes("publickey") || normalized.includes("authentication failed")) {
    return {
      tone: "error",
      title: "Remote authentication failed",
      summary: "Git could not authenticate with the remote. Check your SSH key, agent, or remote permissions.",
      detail: message,
    };
  }

  if (normalized.includes("could not read from remote repository") || normalized.includes("repository not found")) {
    return {
      tone: "error",
      title: "Remote repository could not be reached",
      summary: "The remote URL may be wrong, unavailable, or not accessible with your current credentials.",
      detail: message,
    };
  }

  return {
    tone: "error",
    title:
      operation === "push"
        ? "Push failed"
        : operation === "pull"
          ? "Pull failed"
          : operation === "fetch"
            ? "Fetch failed"
            : "Force pull failed",
    summary:
      operation === "push"
        ? "Git rejected the push or could not complete the remote operation."
        : operation === "pull"
          ? "Git could not complete the normal sync operation."
          : operation === "fetch"
            ? "Git could not update remote refs during refresh."
            : "Git could not complete the destructive sync operation.",
    detail: message,
  };
};

const getSortValue = (change: FileChange, sortBy: ChangeSortKey) => {
  const normalized = getPairKey(change.path);
  const parts = splitPathForDisplay(normalized);
  const marker = getChangeMarker(change);

  switch (sortBy) {
    case "folder":
      return parts.parentPath.toLowerCase();
    case "extension": {
      const extension = parts.fileName.includes(".")
        ? parts.fileName.split(".").pop() ?? ""
        : "";
      return extension.toLowerCase();
    }
    case "status":
      return marker.tone;
    case "name":
    default:
      return parts.fileName.toLowerCase();
  }
};

const matchesChangeQuery = (change: FileChange, query: string) => {
  if (!query) {
    return true;
  }

  const candidate = [
    change.path,
    getPairKey(change.path),
    change.displayStatus,
    change.indexStatus,
    change.worktreeStatus,
  ]
    .join(" ")
    .toLowerCase();

  return candidate.includes(query);
};

const buildChangeList = (
  files: FileChange[],
  options: ChangeListOptions,
): ChangeListItem[] => {
  const groups = new Map<string, { primary?: FileChange; meta?: FileChange }>();

  for (const change of files) {
    const key = getPairKey(change.path);
    const group = groups.get(key) ?? {};

    if (isMetaFile(change.path)) {
      group.meta = change;
    } else {
      group.primary = change;
    }

    groups.set(key, group);
  }

  const query = options.query.trim().toLowerCase();

  const orderedGroups = Array.from(groups.entries())
    .filter(([, group]) => {
      const primaryMatch = group.primary
        ? matchesChangeQuery(group.primary, query)
        : false;
      const metaMatch = group.meta ? matchesChangeQuery(group.meta, query) : false;

      return primaryMatch || metaMatch;
    })
    .sort(([, left], [, right]) => {
      const leftAnchor = left.primary ?? left.meta;
      const rightAnchor = right.primary ?? right.meta;

      if (!leftAnchor || !rightAnchor) {
        return 0;
      }

      const leftValue = getSortValue(leftAnchor, options.sortBy);
      const rightValue = getSortValue(rightAnchor, options.sortBy);
      const baseComparison = leftValue.localeCompare(rightValue);

      if (baseComparison !== 0) {
        return options.sortDirection === "asc" ? baseComparison : -baseComparison;
      }

      const leftPath = getPairKey(leftAnchor.path);
      const rightPath = getPairKey(rightAnchor.path);
      const tiebreak = leftPath.localeCompare(rightPath);
      return options.sortDirection === "asc" ? tiebreak : -tiebreak;
    });

  return orderedGroups.flatMap(([, group]) => {
    const items: ChangeListItem[] = [];

    if (group.primary) {
      const parts = splitPathForDisplay(group.primary.path);
      items.push({
        change: group.primary,
        isMeta: false,
        fileName: parts.fileName,
        parentPath: parts.parentPath,
        marker: getChangeMarker(group.primary),
      });
    }

    if (group.meta) {
      const parts = splitPathForDisplay(group.meta.path);
      items.push({
        change: group.meta,
        isMeta: true,
        fileName: parts.fileName,
        parentPath: parts.parentPath,
        marker: getChangeMarker(group.meta),
      });
    }

    return items;
  });
};

const getStatusTone = (change: FileChange) => {
  if (change.conflicted) {
    return "conflict";
  }

  if (change.stagedModified) {
    return "mixed";
  }

  if (change.untracked) {
    return "accent";
  }

  if (change.staged) {
    return "success";
  }

  return "default";
};

const buildBranchTree = (entries: BranchEntry[], scope: string): BranchTreeNode[] => {
  const roots: Array<BranchTreeNode & { childMap: Map<string, BranchTreeNode & { childMap: Map<string, any> }> }> = [];
  const rootMap = new Map<string, BranchTreeNode & { childMap: Map<string, any> }>();

  const ensureNode = (
    parentChildren: Array<BranchTreeNode & { childMap: Map<string, any> }>,
    parentMap: Map<string, BranchTreeNode & { childMap: Map<string, any> }>,
    id: string,
    label: string,
  ) => {
    let node = parentMap.get(id);

    if (!node) {
      node = {
        id,
        label,
        branch: null,
        children: [],
        childMap: new Map(),
      };
      parentMap.set(id, node);
      parentChildren.push(node);
    }

    return node;
  };

  for (const branch of entries) {
    const branchSegments = branch.name.split("/").filter(Boolean);
    const segments = branchSegments.length <= 1 ? ["root", ...branchSegments] : branchSegments;
    let currentChildren = roots;
    let currentMap = rootMap;
    let path = scope;

    segments.forEach((segment, index) => {
      path = `${path}/${segment}`;
      const node = ensureNode(currentChildren, currentMap, path, segment);

      if (index === segments.length - 1) {
        node.branch = branch;
      }

      currentChildren = node.children as Array<BranchTreeNode & { childMap: Map<string, any> }>;
      currentMap = node.childMap;
    });
  }

  const sortNodes = (nodes: Array<BranchTreeNode & { childMap?: Map<string, any> }>): BranchTreeNode[] => {
    return nodes
      .sort((left, right) => {
        const leftFolder = left.children.length > 0;
        const rightFolder = right.children.length > 0;

        if (leftFolder !== rightFolder) {
          return leftFolder ? -1 : 1;
        }

        return left.label.localeCompare(right.label);
      })
      .map((node) => ({
        id: node.id,
        label: node.label,
        branch: node.branch,
        children: sortNodes(node.children as Array<BranchTreeNode & { childMap?: Map<string, any> }>),
      }));
  };

  return sortNodes(roots);
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
  const [commitGraph, setCommitGraph] = useState<CommitGraphRow[]>([]);
  const [graphNextSkip, setGraphNextSkip] = useState(0);
  const [graphHasMore, setGraphHasMore] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [selectedChangePaths, setSelectedChangePaths] = useState<string[]>([]);
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
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
  const [showPaths, setShowPaths] = useState(true);
  const [sortBy, setSortBy] = useState<ChangeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [graphFractions, setGraphFractions] = useState({ left: 0.26, right: 0.74 });
  const [panelFractions, setPanelFractions] = useState({ left: 0.6, right: 0.4 });
  const graphSplitRef = useRef<HTMLDivElement | null>(null);
  const contentGridRef = useRef<HTMLElement | null>(null);

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

  const rawUnstagedChanges = useMemo(
    () =>
      snapshot?.files.filter(
        (file) => file.unstaged || file.untracked || file.conflicted,
      ) ?? [],
    [snapshot?.files],
  );

  const rawStagedChanges = useMemo(
    () => snapshot?.files.filter((file) => file.staged) ?? [],
    [snapshot?.files],
  );

  const changeListOptions = useMemo<ChangeListOptions>(
    () => ({
      query: changeQuery,
      showPaths,
      sortBy,
      sortDirection,
    }),
    [changeQuery, showPaths, sortBy, sortDirection],
  );

  const unstagedChanges = useMemo(
    () => buildChangeList(rawUnstagedChanges, changeListOptions),
    [changeListOptions, rawUnstagedChanges],
  );

  const stagedChanges = useMemo(
    () => buildChangeList(rawStagedChanges, changeListOptions),
    [changeListOptions, rawStagedChanges],
  );

  const selectedChange = useMemo(
    () => snapshot?.files.find((file) => file.path === selectedChangePath) ?? null,
    [selectedChangePath, snapshot?.files],
  );

  const handleSelectChange = useCallback(
    (path: string, event: MouseEvent<HTMLElement>, orderedPaths: string[]) => {
      const withPath = (paths: string[]) => (paths.includes(path) ? paths : [...paths, path]);
      const isToggle = event.ctrlKey || event.metaKey;
      const isRange = event.shiftKey && selectionAnchorPath;

      if (isRange && selectionAnchorPath) {
        const startIndex = orderedPaths.indexOf(selectionAnchorPath);
        const endIndex = orderedPaths.indexOf(path);

        if (startIndex !== -1 && endIndex !== -1) {
          const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
          const range = orderedPaths.slice(from, to + 1);
          setSelectedChangePaths(range);
          setSelectedChangePath(path);
          return;
        }
      }

      if (isToggle) {
        setSelectedChangePaths((current) => {
          const next = current.includes(path)
            ? current.filter((entry) => entry !== path)
            : [...current, path];

          if (next.length === 0) {
            setSelectedChangePath(null);
          } else {
            setSelectedChangePath(path);
          }

          return next;
        });
        setSelectionAnchorPath(path);
        return;
      }

      setSelectedChangePaths(withPath([path]));
      setSelectedChangePath(path);
      setSelectionAnchorPath(path);
    },
    [selectionAnchorPath],
  );

  const selectedUnstagedPaths = useMemo(() => {
    const lanePaths = new Set(unstagedChanges.map((item) => item.change.path));
    return selectedChangePaths.filter((path) => lanePaths.has(path));
  }, [selectedChangePaths, unstagedChanges]);

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
      return "Force pull resets tracked files to upstream and stores a safety ref first.";
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
            {remoteDialog.detail ? <pre className="remote-dialog__detail">{remoteDialog.detail}</pre> : null}
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
              <p className="board__hint">Drag, click, commit. Nothing extra.</p>
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
            </div>

            <div className="lanes">
              <DropLane
                title="Unstaged"
                icon={<Undo2 size={16} />}
                items={unstagedChanges}
                actionLabel="Stage"
                dropAction="unstage"
                disabled={submitting}
                onAction={(path) => void runFileOperation("stage", [path])}
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
                onBulkAction={() => void runFileOperation("stage", selectedUnstagedPaths)}
                bulkSecondaryLabel="Stage all"
                bulkSecondaryDisabled={submitting || unstagedChanges.length === 0}
                onBulkSecondaryAction={() =>
                  void runFileOperation(
                    "stage",
                    unstagedChanges.map((item) => item.change.path),
                  )
                }
              />
              <DropLane
                title="Staged"
                icon={<Upload size={16} />}
                items={stagedChanges}
                actionLabel="Unstage"
                dropAction="stage"
                disabled={submitting}
                onAction={(path) => void runFileOperation("unstage", [path])}
                onDropFiles={(paths, origin) => {
                  if (origin === "unstaged") {
                    void runFileOperation("stage", paths);
                  }
                }}
                showPaths={showPaths}
                onSelect={handleSelectChange}
                selectedPaths={selectedChangePaths}
                primarySelectedPath={selectedChangePath}
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
              <button
                className="primary-button"
                disabled={!stagedChanges.length || !commitMessage.trim() || submitting}
                onClick={() => void commitChanges()}
              >
                <GitCommitHorizontal size={16} />
                Commit staged
              </button>
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
    </div>
  );
}

type DropLaneProps = {
  title: string;
  icon: JSX.Element;
  items: ChangeListItem[];
  actionLabel: string;
  dropAction: "stage" | "unstage";
  disabled: boolean;
  onAction: (path: string) => void;
  onDropFiles: (paths: string[], origin: "staged" | "unstaged") => void;
  showPaths: boolean;
  onSelect: (path: string, event: MouseEvent<HTMLElement>, orderedPaths: string[]) => void;
  selectedPaths: string[];
  primarySelectedPath: string | null;
  bulkActionLabel?: string;
  bulkActionDisabled?: boolean;
  onBulkAction?: () => void;
  bulkSecondaryLabel?: string;
  bulkSecondaryDisabled?: boolean;
  onBulkSecondaryAction?: () => void;
};

type BranchPaneProps = {
  localBranches: BranchEntry[];
  remoteBranches: BranchEntry[];
  filter: string;
  onFilterChange: (value: string) => void;
  selectedBranchFullName: string | null;
  onSelectBranch: (fullName: string) => void;
  onSwitchBranch: (fullName: string) => void;
  onRenameBranch: (currentName: string, nextName: string) => void;
  onDeleteBranch: (fullName: string) => void;
  disabled: boolean;
};

type RepoManagerDialogProps = {
  repositories: string[];
  selectedRepository: string | null;
  onSelectRepository: (path: string | null) => void;
  onAddExistingRepository: () => void;
  onRemoveRepository: (path: string) => void;
  onClose: () => void;
  canClose: boolean;
  cloneUrl: string;
  onCloneUrlChange: (value: string) => void;
  cloneDestination: string;
  onCloneDestinationChange: (value: string) => void;
  onPickCloneDestination: () => void;
  onClone: () => void;
  cloneDisabled: boolean;
  repoConfig: RepositoryConfig | null;
  repoConfigLoading: boolean;
  repoConfigError: string | null;
  onSaveRemote: (originalName: string | null, name: string, fetchUrl: string, pushUrl: string) => void;
  onDeleteRemote: (name: string) => void;
  settingsDisabled: boolean;
};

type BranchContextMenuState = {
  branch: BranchEntry;
  x: number;
  y: number;
  renameValue: string;
  renameMode: boolean;
};

type BranchTreeNode = {
  id: string;
  label: string;
  branch: BranchEntry | null;
  children: BranchTreeNode[];
};

function DropLane({
  title,
  icon,
  items,
  actionLabel,
  dropAction,
  disabled,
  onAction,
  onDropFiles,
  showPaths,
  onSelect,
  selectedPaths,
  primarySelectedPath,
  bulkActionLabel,
  bulkActionDisabled,
  onBulkAction,
  bulkSecondaryLabel,
  bulkSecondaryDisabled,
  onBulkSecondaryAction,
}: DropLaneProps) {
  const orderedPaths = items.map((item) => item.change.path);

  return (
    <section
      className="lane"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData("application/x-unigit-change");
        if (!raw) {
          return;
        }

        const payload = JSON.parse(raw) as {
          paths: string[];
          origin: "staged" | "unstaged";
        };

        if (dropAction === "stage" && payload.origin === "unstaged") {
          onDropFiles(payload.paths, payload.origin);
        }

        if (dropAction === "unstage" && payload.origin === "staged") {
          onDropFiles(payload.paths, payload.origin);
        }
      }}
    >
      <header className="lane__header">
        <div className="lane__header-main">
          <span className="lane__icon">{icon}</span>
          <div>
            <h4>{title}</h4>
            <p>{items.length} files</p>
          </div>
        </div>

        {bulkActionLabel || bulkSecondaryLabel ? (
          <div className="lane__actions">
            {bulkActionLabel && onBulkAction ? (
              <button
                className="ghost-button"
                disabled={bulkActionDisabled}
                onClick={onBulkAction}
              >
                {bulkActionLabel}
              </button>
            ) : null}
            {bulkSecondaryLabel && onBulkSecondaryAction ? (
              <button
                className="ghost-button"
                disabled={bulkSecondaryDisabled}
                onClick={onBulkSecondaryAction}
              >
                {bulkSecondaryLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="lane__list">
        {items.map((item) => {
          return (
            <article
              key={`${title}-${item.change.path}`}
              className={clsx(
                "change-card",
                selectedPaths.includes(item.change.path) && "change-card--selected",
                primarySelectedPath === item.change.path && "change-card--focused",
                item.isMeta && "change-card--meta",
              )}
              draggable={!disabled}
              onDragStart={(event) => {
                const draggedPaths = selectedPaths.includes(item.change.path)
                  ? orderedPaths.filter((path) => selectedPaths.includes(path))
                  : [item.change.path];
                event.dataTransfer.setData(
                  "application/x-unigit-change",
                  JSON.stringify({
                    paths: draggedPaths,
                    origin: dropAction === "stage" ? "unstaged" : "staged",
                  }),
                );
              }}
              onClick={(event) => onSelect(item.change.path, event, orderedPaths)}
            >
              <div className="change-card__main">
                <span
                  className={clsx("change-marker", `change-marker--${item.marker.tone}`)}
                  title={item.marker.label}
                  aria-label={item.marker.label}
                />
                <div className="change-card__text">
                  <strong title={item.change.path}>{item.fileName}</strong>
                  {showPaths && item.parentPath ? (
                    <p title={item.parentPath}>{item.parentPath}</p>
                  ) : null}
                </div>
              </div>
              <button
                className="ghost-button"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(item.change.path);
                }}
              >
                {actionLabel}
              </button>
            </article>
          );
        })}

        {!items.length ? <p className="muted">No files here.</p> : null}
      </div>
    </section>
  );
}

function RepoManagerDialog({
  repositories,
  selectedRepository,
  onSelectRepository,
  onAddExistingRepository,
  onRemoveRepository,
  onClose,
  canClose,
  cloneUrl,
  onCloneUrlChange,
  cloneDestination,
  onCloneDestinationChange,
  onPickCloneDestination,
  onClone,
  cloneDisabled,
  repoConfig,
  repoConfigLoading,
  repoConfigError,
  onSaveRemote,
  onDeleteRemote,
  settingsDisabled,
}: RepoManagerDialogProps) {
  const [draftRemotes, setDraftRemotes] = useState<Array<{ originalName: string | null; name: string; fetchUrl: string; pushUrl: string }>>([]);

  useEffect(() => {
    if (!repoConfig) {
      setDraftRemotes([]);
      return;
    }

    setDraftRemotes(
      repoConfig.remotes.map((remote) => ({
        originalName: remote.name,
        name: remote.name,
        fetchUrl: remote.fetchUrl ?? "",
        pushUrl: remote.pushUrl ?? remote.fetchUrl ?? "",
      })),
    );
  }, [repoConfig]);

  return (
    <div className="dialog-backdrop">
      <section className="panel repo-manager-dialog">
        <div className="repo-manager-dialog__header">
          <div>
            <p className="eyebrow">Repositories</p>
            <h2>Repository manager</h2>
          </div>
          {canClose ? (
            <button className="icon-button" onClick={onClose}>
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="repo-manager-dialog__body">
          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Loaded repositories</h3>
              <button className="ghost-button" onClick={onAddExistingRepository}>
                <FolderPlus size={15} />
                Open existing
              </button>
            </div>

            <div className="repo-manager-list panel-scroll">
              {repositories.length ? repositories.map((repo) => (
                <div key={repo} className={clsx("repo-manager-row", selectedRepository === repo && "repo-manager-row--selected")}>
                  <button className="repo-manager-row__main" onClick={() => onSelectRepository(repo)}>
                    <strong>{formatRepoLabel(repo)}</strong>
                    <span>{repo}</span>
                  </button>
                  <button className="ghost-button ghost-button--danger" onClick={() => onRemoveRepository(repo)}>
                    Remove
                  </button>
                </div>
              )) : <p className="muted">No repositories loaded yet. Clone one or open an existing local checkout.</p>}
            </div>
          </section>

          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Clone repository</h3>
            </div>

            <div className="repo-clone-form">
              <label className="repo-form-field">
                <span>Remote URL</span>
                <input
                  className="changes-filter"
                  placeholder="git@github.com:owner/repo.git or https://..."
                  value={cloneUrl}
                  onChange={(event) => onCloneUrlChange(event.target.value)}
                />
              </label>

              <label className="repo-form-field">
                <span>Destination path</span>
                <div className="repo-form-field__row">
                  <input
                    className="changes-filter"
                    placeholder="C:/Code/MyRepo"
                    value={cloneDestination}
                    onChange={(event) => onCloneDestinationChange(event.target.value)}
                  />
                  <button className="ghost-button" onClick={onPickCloneDestination}>
                    Browse
                  </button>
                </div>
              </label>

              <button className="primary-button" disabled={cloneDisabled} onClick={onClone}>
                Clone repository
              </button>
            </div>
          </section>

          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Repository settings</h3>
            </div>

            {repoConfigLoading ? <p className="muted">Loading repository settings...</p> : null}
            {repoConfigError ? <p className="muted">{repoConfigError}</p> : null}

            {!repoConfigLoading && !repoConfigError && repoConfig ? (
              <div className="repo-config-card">
                <dl className="repo-config-grid">
                  <div>
                    <dt>Name</dt>
                    <dd>{repoConfig.repoName}</dd>
                  </div>
                  <div>
                    <dt>Path</dt>
                    <dd>{repoConfig.repoPath}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{repoConfig.detachedHead ? `Detached at ${repoConfig.currentBranch}` : repoConfig.currentBranch}</dd>
                  </div>
                </dl>

                <div className="repo-config-remotes">
                  <div className="preview-panel__header">
                    <strong>Remotes</strong>
                    <div className="repo-config-remotes__actions">
                      <span className="preview-panel__meta">{draftRemotes.length}</span>
                      <button
                        className="ghost-button"
                        disabled={settingsDisabled}
                        onClick={() => setDraftRemotes((current) => [...current, { originalName: null, name: "", fetchUrl: "", pushUrl: "" }])}
                      >
                        Add remote
                      </button>
                    </div>
                  </div>
                  {draftRemotes.length ? draftRemotes.map((remote, index) => (
                    <div key={`${remote.originalName ?? "new"}-${index}`} className="repo-remote-row">
                      <label className="repo-form-field">
                        <span>Name</span>
                        <input
                          className="changes-filter"
                          value={remote.name}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, name: event.target.value } : entry))}
                        />
                      </label>
                      <label className="repo-form-field">
                        <span>Fetch URL</span>
                        <input
                          className="changes-filter"
                          value={remote.fetchUrl}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, fetchUrl: event.target.value } : entry))}
                        />
                      </label>
                      <label className="repo-form-field">
                        <span>Push URL</span>
                        <input
                          className="changes-filter"
                          value={remote.pushUrl}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, pushUrl: event.target.value } : entry))}
                        />
                      </label>
                      <div className="repo-remote-row__actions">
                        <button
                          className="ghost-button"
                          disabled={settingsDisabled || !remote.name.trim() || !remote.fetchUrl.trim()}
                          onClick={() => onSaveRemote(remote.originalName, remote.name.trim(), remote.fetchUrl.trim(), remote.pushUrl.trim())}
                        >
                          Save remote
                        </button>
                        <button
                          className="ghost-button ghost-button--danger"
                          disabled={settingsDisabled || !remote.originalName}
                          onClick={() => {
                            if (remote.originalName) {
                              onDeleteRemote(remote.originalName);
                            } else {
                              setDraftRemotes((current) => current.filter((_, entryIndex) => entryIndex !== index));
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )) : <p className="muted">No remotes configured yet. Add one here.</p>}
                </div>
              </div>
            ) : null}

            {!repoConfigLoading && !repoConfigError && !repoConfig ? (
              <p className="muted">Select a loaded repository to inspect its settings.</p>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}

function BranchPane({
  localBranches,
  remoteBranches,
  filter,
  onFilterChange,
  selectedBranchFullName,
  onSelectBranch,
  onSwitchBranch,
  onRenameBranch,
  onDeleteBranch,
  disabled,
}: BranchPaneProps) {
  const rootRef = useRef<HTMLElement | null>(null);
  const [contextMenu, setContextMenu] = useState<BranchContextMenuState | null>(null);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set(["local", "remote", "local/root", "remote/root"]));
  const [isFullscreen, setIsFullscreen] = useState(false);

  const localTree = useMemo(() => buildBranchTree(localBranches, "local"), [localBranches]);
  const remoteTree = useMemo(() => buildBranchTree(remoteBranches, "remote"), [remoteBranches]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }

      setContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [contextMenu]);

  const toggleFullscreen = useCallback(async () => {
    if (!rootRef.current) {
      return;
    }

    if (document.fullscreenElement === rootRef.current) {
      await document.exitFullscreen();
      return;
    }

    await rootRef.current.requestFullscreen();
  }, []);

  const toggleNode = (id: string) => {
    setExpandedNodes((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const openContextMenu = (event: MouseEvent<HTMLElement>, branch: BranchEntry) => {
    event.preventDefault();
    onSelectBranch(branch.fullName);

    const bounds = rootRef.current?.getBoundingClientRect();
    setContextMenu({
      branch,
      x: bounds ? event.clientX - bounds.left : 16,
      y: bounds ? event.clientY - bounds.top : 16,
      renameValue: branch.name.replace(/^origin\//, ""),
      renameMode: false,
    });
  };

  const renderTreeNodes = (nodes: BranchTreeNode[], depth: number) => {
    return nodes.map((node) => {
      const isExpanded = filter.trim() ? true : expandedNodes.has(node.id);
      const hasChildren = node.children.length > 0;
      const branch = node.branch;

      return (
        <div key={node.id} className="branch-tree-node">
          {branch ? (
            <button
              className={clsx(
                "branch-row",
                "branch-row--tree",
                selectedBranchFullName === branch.fullName && "branch-row--selected",
                branch.isCurrent && "branch-row--current",
              )}
              style={{ paddingLeft: `${10 + depth * 18}px` }}
              onClick={() => {
                onSelectBranch(branch.fullName);
                setContextMenu(null);
              }}
              onContextMenu={(event) => openContextMenu(event, branch)}
            >
              <div className="branch-row__top">
                <div className="branch-row__label">
                  {hasChildren ? (
                    <span
                      className="branch-tree-toggle"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleNode(node.id);
                      }}
                    >
                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </span>
                  ) : <span className="branch-tree-toggle branch-tree-toggle--spacer" />}
                  <span className={clsx("pill", branch.branchKind === "remote" ? "pill--accent" : "pill--default")}>
                    {branch.branchKind}
                  </span>
                </div>
                {branch.isCurrent ? <span className="pill pill--success">current</span> : null}
              </div>
              <strong title={branch.name}>{branch.name}</strong>
              <p title={branch.subject}>{branch.subject || "No subject"}</p>
              {branch.trackingName ? (
                <span className="branch-row__meta">
                  {branch.trackingName}{branch.trackingState ? ` ${branch.trackingState}` : ""}
                </span>
              ) : null}
            </button>
          ) : (
            <button
              className="branch-folder-row"
              style={{ paddingLeft: `${10 + depth * 18}px` }}
              onClick={() => toggleNode(node.id)}
            >
              <span className="branch-tree-toggle">
                {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <strong>{node.label}</strong>
              <span className="muted">{node.children.length}</span>
            </button>
          )}

          {hasChildren && isExpanded ? (
            <div className="branch-tree-children">
              {renderTreeNodes(node.children, depth + 1)}
            </div>
          ) : null}
        </div>
      );
    });
  };

  const renderBranchGroup = (title: string, nodes: BranchTreeNode[]) => {
    return (
      <div className="branch-group">
        <div className="branch-group__header">
          <strong>{title}</strong>
          <span className="muted">{nodes.length}</span>
        </div>

        <div className="branch-group__list">
          {nodes.length ? renderTreeNodes(nodes, 0) : <p className="muted">No branches here.</p>}
        </div>
      </div>
    );
  };

  return (
    <section ref={rootRef} className={clsx("branch-panel", isFullscreen && "branch-panel--fullscreen")}>
      <div className="board__header">
        <div>
          <p className="eyebrow">Branches</p>
          <h3>{selectedBranchFullName ? (localBranches.concat(remoteBranches).find((branch) => branch.fullName === selectedBranchFullName)?.name ?? "Branch view") : "Branch view"}</h3>
        </div>
        <button className="ghost-button" onClick={() => void toggleFullscreen()}>
          {isFullscreen ? <Minimize2 size={15} /> : <Expand size={15} />}
          {isFullscreen ? "Window" : "Fullscreen"}
        </button>
      </div>

      <input
        className="history-filter"
        placeholder="Filter branches"
        value={filter}
        onChange={(event) => onFilterChange(event.target.value)}
      />

      <div className="branch-panel__scroll panel-scroll">
        {renderBranchGroup("Local", localTree)}
        {renderBranchGroup("Remote", remoteTree)}
      </div>

      {contextMenu ? (
        <div
          className="branch-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {!contextMenu.renameMode ? (
            <>
              <button
                className="ghost-button"
                disabled={disabled}
                onClick={() => {
                  onSwitchBranch(contextMenu.branch.fullName);
                  setContextMenu(null);
                }}
              >
                Switch to
              </button>
              {contextMenu.branch.branchKind === "local" ? (
                <button
                  className="ghost-button"
                  disabled={disabled}
                  onClick={() => setContextMenu((current) => current ? { ...current, renameMode: true } : current)}
                >
                  Rename
                </button>
              ) : null}
              <button
                className="ghost-button ghost-button--danger"
                disabled={disabled || contextMenu.branch.isCurrent}
                onClick={() => {
                  onDeleteBranch(contextMenu.branch.fullName);
                  setContextMenu(null);
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <form
              className="branch-rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                onRenameBranch(contextMenu.branch.fullName, contextMenu.renameValue);
                setContextMenu(null);
              }}
            >
              <input
                className="changes-filter"
                value={contextMenu.renameValue}
                onChange={(event) => setContextMenu((current) => current ? { ...current, renameValue: event.target.value } : current)}
                autoFocus
              />
              <div className="branch-rename-form__actions">
                <button className="ghost-button" type="submit" disabled={disabled || !contextMenu.renameValue.trim()}>
                  Save
                </button>
                <button className="ghost-button" type="button" onClick={() => setContextMenu((current) => current ? { ...current, renameMode: false } : current)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}
