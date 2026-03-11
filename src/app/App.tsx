import { open } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import {
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  GripVertical,
  RefreshCw,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommitGraphCanvas } from "./CommitGraphCanvas";
import {
  CommitDetail,
  CommitGraphPage,
  CommitGraphRow,
  FileChange,
  FilePreview,
  RepositorySnapshot,
  createCommit,
  inspectCommitDetail,
  inspectFilePreview,
  inspectRepository,
  listCommitGraph,
  stageFiles,
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

export function App() {
  const {
    repositories,
    selectedRepository,
    addRepository,
    removeRepository,
    selectRepository,
  } = useRepositoryStore();

  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(null);
  const [commitGraph, setCommitGraph] = useState<CommitGraphRow[]>([]);
  const [graphNextSkip, setGraphNextSkip] = useState(0);
  const [graphHasMore, setGraphHasMore] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<CommitDetail | null>(null);
  const [commitDetailLoading, setCommitDetailLoading] = useState(false);
  const [commitDetailError, setCommitDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [changeQuery, setChangeQuery] = useState("");
  const [showPaths, setShowPaths] = useState(true);
  const [sortBy, setSortBy] = useState<ChangeSortKey>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [panelFractions, setPanelFractions] = useState({ left: 0.6, right: 0.4 });
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

  const refreshRepository = useCallback(async () => {
    if (!selectedRepository) {
      setSnapshot(null);
      setCommitGraph([]);
      setGraphHasMore(false);
      setGraphNextSkip(0);
      return;
    }

    setLoading(true);
    setGraphLoading(true);
    setError(null);

    try {
      const [nextSnapshot, nextGraph] = await Promise.all([
        inspectRepository(selectedRepository),
        listCommitGraph(selectedRepository, 260, 0),
      ]);

      setSnapshot(nextSnapshot);
      applyGraphPage(nextGraph, "replace");

      if (selectedChangePath) {
        const stillExists = nextSnapshot.files.some(
          (file) => file.path === selectedChangePath,
        );
        if (!stillExists) {
          setSelectedChangePath(null);
        }
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
  }, [applyGraphPage, selectedChangePath, selectedCommitHash, selectedRepository]);

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
    }
  }, [addRepository]);

  const runFileOperation = useCallback(
    async (mode: "stage" | "unstage", paths: string[]) => {
      if (!selectedRepository || paths.length === 0) {
        return;
      }

      setSubmitting(true);
      setError(null);

      try {
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
      } finally {
        setSubmitting(false);
      }
    },
    [refreshRepository, selectedRepository],
  );

  const commitChanges = useCallback(async () => {
    if (!selectedRepository || !commitMessage.trim()) {
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await createCommit(selectedRepository, commitMessage.trim());
      setCommitMessage("");
      setStatusMessage("Committed staged changes.");
      await refreshRepository();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Commit failed.");
    } finally {
      setSubmitting(false);
    }
  }, [commitMessage, refreshRepository, selectedRepository]);

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

  const lowerGridTemplateColumns = useMemo(() => {
    return `${panelFractions.left}fr 12px ${panelFractions.right}fr`;
  }, [panelFractions]);

  return (
    <div className="shell">
      <header className="chrome panel">
        <div className="chrome__row">
          <div className="brand-block brand-block--compact">
            <h1>UniGit</h1>
          </div>

          <div className="repo-tabs panel-scroll">
            {repositories.length === 0 ? (
              <button className="repo-tab repo-tab--empty" onClick={() => void pickRepository()}>
                Add repository
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
              className="icon-button"
              disabled={!selectedRepository || loading || submitting}
              onClick={() => void refreshRepository()}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className="workspace">

        {error ? <div className="banner banner--error">{error}</div> : null}
        {statusMessage ? <div className="banner">{statusMessage}</div> : null}

        <section className="content-grid">
          <section className="panel graph-panel graph-panel--embedded">
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
                onSelect={setSelectedChangePath}
                selectedPath={selectedChangePath}
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
                onSelect={setSelectedChangePath}
                selectedPath={selectedChangePath}
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
                          <span className="preview-panel__meta">
                            {file.additions ?? 0}+ / {file.deletions ?? 0}-
                          </span>
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
  onSelect: (path: string) => void;
  selectedPath: string | null;
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
  selectedPath,
}: DropLaneProps) {
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
        <span className="lane__icon">{icon}</span>
        <div>
          <h4>{title}</h4>
          <p>{items.length} files</p>
        </div>
      </header>

      <div className="lane__list">
        {items.map((item) => {
          return (
            <article
              key={`${title}-${item.change.path}`}
              className={clsx(
                "change-card",
                selectedPath === item.change.path && "change-card--selected",
                item.isMeta && "change-card--meta",
              )}
              draggable={!disabled}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/x-unigit-change",
                  JSON.stringify({
                    paths: [item.change.path],
                    origin: dropAction === "stage" ? "unstaged" : "staged",
                  }),
                );
              }}
              onClick={() => onSelect(item.change.path)}
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
