import type { BranchEntry, FileChange, FilePreview } from "../../features/repositories/api";
import type { ChangeListItem, ChangeListOptions, ChangeSortKey, RemoteDialogState } from "../types";

export const hasDiffContent = (preview: FilePreview | null) => {
  return Boolean(preview?.stagedDiff || preview?.unstagedDiff);
};

export const getDiffLineClassName = (line: string) => {
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

const getRawGitMessage = (message: string) => {
  return message.replace(/^Git command failed:\s*/i, "").trim();
};

export const normalizePath = (path: string) => path.replace(/\\/g, "/");

export const isMetaFile = (path: string) => normalizePath(path).endsWith(".meta");

export const getPairKey = (path: string) => {
  const normalized = normalizePath(path);
  return normalized.endsWith(".meta") ? normalized.slice(0, -5) : normalized;
};

export const splitPathForDisplay = (path: string) => {
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

export const getChangeMarker = (change: FileChange) => {
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

export const describeRemoteFailure = (operation: "push" | "pull" | "force-pull" | "fetch", message: string): RemoteDialogState => {
  const detail = getRawGitMessage(message);
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("your local changes to the following files would be overwritten by merge") ||
    normalized.includes("please commit your changes or stash them before you merge") ||
    normalized.includes("would be overwritten by merge")
  ) {
    return {
      tone: "error",
      title: "Pull blocked by local changes",
      summary: "Git refused to apply incoming changes because local working-tree changes would be overwritten. Commit, stash, discard, or use Force pull if you intend to replace local state.",
      detail,
    };
  }

  if (normalized.includes("has no upstream branch") || normalized.includes("no upstream branch")) {
    return {
      tone: "error",
      title: operation === "push"
        ? "Push is missing an upstream"
        : operation === "fetch"
          ? "Fetch needs a configured remote"
          : "Pull needs an upstream",
      summary: "The current branch is not tracking a remote branch yet.",
      detail,
    };
  }

  if (normalized.includes("failed to push some refs") || normalized.includes("fetch first") || normalized.includes("non-fast-forward")) {
    return {
      tone: "error",
      title: "Push was rejected by the remote",
      summary: "The remote branch has commits you do not have locally. Pull or reconcile history before pushing.",
      detail,
    };
  }

  if (normalized.includes("permission denied") || normalized.includes("publickey") || normalized.includes("authentication failed")) {
    return {
      tone: "error",
      title: "Remote authentication failed",
      summary: "Git could not authenticate with the remote. Check the repository SSH settings, key/agent state, or remote permissions.",
      detail,
    };
  }

  if (normalized.includes("could not read from remote repository") || normalized.includes("repository not found")) {
    return {
      tone: "error",
      title: "Remote repository could not be reached",
      summary: "The remote URL may be wrong, unavailable, or not accessible with your current credentials.",
      detail,
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
    detail,
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

const fileBelongsToLane = (change: FileChange, lane: "staged" | "unstaged") => {
  return lane === "staged"
    ? change.staged
    : change.unstaged || change.untracked || change.conflicted;
};

const buildSyntheticChange = (anchor: FileChange, related: FileChange[]) => {
  const all = [anchor, ...related];
  const anyStaged = all.some((change) => change.staged);
  const anyUnstaged = all.some((change) => change.unstaged);
  const anyConflicted = all.some((change) => change.conflicted);
  const anyUntracked = all.some((change) => change.untracked);
  const anyIgnored = all.some((change) => change.ignored);
  const anyStagedModified = all.some((change) => change.stagedModified);

  return {
    ...anchor,
    staged: anyStaged,
    unstaged: anyUnstaged,
    conflicted: anyConflicted,
    untracked: anyUntracked,
    ignored: anyIgnored,
    stagedModified: anyStagedModified,
    displayStatus: anyConflicted
      ? "Conflict"
      : anyStaged && (anyUnstaged || anyUntracked)
        ? "Mixed"
        : anyStaged
          ? "Staged"
          : anyUntracked
            ? "Untracked"
            : anchor.displayStatus,
  } satisfies FileChange;
};

const getCombinedMarker = (changes: FileChange[]) => {
  const markers = changes.map(getChangeMarker);
  const priority = {
    conflict: 7,
    removed: 6,
    moved: 5,
    restaged: 4,
    new: 3,
    added: 2,
    changed: 1,
  } as const;

  return markers.sort((left, right) => (priority[right.tone as keyof typeof priority] ?? 0) - (priority[left.tone as keyof typeof priority] ?? 0))[0] ?? { tone: "changed", label: "Changed" };
};

export const buildChangeList = (
  allFiles: FileChange[],
  lane: "staged" | "unstaged",
  options: ChangeListOptions,
  pairMetaFiles: boolean,
  hiddenKeys: Set<string>,
): ChangeListItem[] => {
  const groups = new Map<string, { primary?: FileChange; meta?: FileChange }>();

  for (const change of allFiles) {
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
  const builtEntries: Array<{ anchor: FileChange; item: ChangeListItem }> = [];

  for (const [pairKey, group] of groups.entries()) {
    const primary = group.primary;
    const meta = group.meta;
    const paired = pairMetaFiles && primary && meta && !meta.conflicted;

    if (paired && primary && meta) {
      const anchor = primary;
      const members = [primary, meta];
      const hiddenKey = `pair:${pairKey}`;

      if (
        (!members.some((change) => change.conflicted) && hiddenKeys.has(hiddenKey))
        || (!anchor.conflicted && members.some((change) => hiddenKeys.has(`file:${change.path}`)))
        || !members.some((change) => fileBelongsToLane(change, lane))
        || (query && !members.some((change) => matchesChangeQuery(change, query)))
      ) {
        continue;
      }

      const parts = splitPathForDisplay(getPairKey(anchor.path));
      builtEntries.push({
        anchor,
        item: {
          change: buildSyntheticChange(anchor, members.filter((change) => change.path !== anchor.path)),
          isMeta: false,
          fileName: parts.fileName,
          parentPath: parts.parentPath,
          selectionKey: anchor.path,
          hiddenKey,
          actionPaths: members.map((change) => change.path),
          pairedMeta: {
            path: meta.path,
            marker: getChangeMarker(meta),
            statusText: meta.displayStatus,
          },
          marker: getCombinedMarker(members),
        },
      });
      continue;
    }

    for (const change of [primary, meta].filter((entry): entry is FileChange => Boolean(entry))) {
      if (!fileBelongsToLane(change, lane)) {
        continue;
      }

      if (!change.conflicted && (hiddenKeys.has(`file:${change.path}`) || hiddenKeys.has(`pair:${getPairKey(change.path)}`))) {
        continue;
      }

      if (query && !matchesChangeQuery(change, query)) {
        continue;
      }

      const parts = splitPathForDisplay(change.path);
      builtEntries.push({
        anchor: change,
        item: {
          change,
          isMeta: isMetaFile(change.path),
          fileName: parts.fileName,
          parentPath: parts.parentPath,
          selectionKey: change.path,
          hiddenKey: `file:${change.path}`,
          actionPaths: [change.path],
          pairedMeta: null,
          marker: getChangeMarker(change),
        },
      });
    }
  }

  return builtEntries
    .sort((left, right) => {
      const leftValue = getSortValue(left.anchor, options.sortBy);
      const rightValue = getSortValue(right.anchor, options.sortBy);
      const baseComparison = leftValue.localeCompare(rightValue);

      if (baseComparison !== 0) {
        return options.sortDirection === "asc" ? baseComparison : -baseComparison;
      }

      const tiebreak = getPairKey(left.anchor.path).localeCompare(getPairKey(right.anchor.path));
      return options.sortDirection === "asc" ? tiebreak : -tiebreak;
    })
    .map((entry) => entry.item);
};

export const getStatusTone = (change: FileChange) => {
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