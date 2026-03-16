import clsx from "clsx";
import { ChevronDown, ChevronRight, Expand, Minimize2 } from "lucide-react";
import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BranchEntry } from "../../features/repositories/api";
import type { BranchContextMenuState, BranchTreeNode } from "../types";
import { buildBranchTree } from "../utils/branchTree";

export type BranchPaneProps = {
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

export function BranchPane({
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

  const renderTreeNodes = (nodes: BranchTreeNode[], depth: number): JSX.Element[] => {
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