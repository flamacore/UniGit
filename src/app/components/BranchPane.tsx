import clsx from "clsx";
import { ChevronDown, ChevronRight, Expand, GitMerge, Minimize2, Plus, Trash2 } from "lucide-react";
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
  onForceSwitchBranch: (fullName: string) => void;
  onMergeBranch: (fullName: string) => void;
  onRenameBranch: (currentName: string, nextName: string) => void;
  onRequestDeleteBranch: (branch: BranchEntry) => void;
  onOpenCreateBranch: () => void;
  hasMergeConflict: boolean;
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
  onForceSwitchBranch,
  onMergeBranch,
  onRenameBranch,
  onRequestDeleteBranch,
  onOpenCreateBranch,
  hasMergeConflict,
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

  const stopRowButton = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const renderTreeNodes = (nodes: BranchTreeNode[], depth: number): JSX.Element[] => {
    return nodes.map((node) => {
      const isExpanded = filter.trim() ? true : expandedNodes.has(node.id);
      const hasChildren = node.children.length > 0;
      const branch = node.branch;

      return (
        <div key={node.id} className="branch-tree-node">
          {branch ? (
            <div
              className={clsx(
                "branch-card",
                selectedBranchFullName === branch.fullName && "branch-card--selected",
              )}
            >
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
                  <strong title={branch.name}>{branch.name}</strong>
                  <span className={clsx("pill", branch.branchKind === "remote" ? "pill--accent" : "pill--default")}>
                    {branch.branchKind}
                  </span>
                  {branch.isCurrent ? <span className="pill pill--success">current</span> : null}
                </div>
              </button>

              {selectedBranchFullName === branch.fullName ? (
                <div className="branch-row__actions">
                  <button className="ghost-button" disabled={disabled} onClick={(event) => { stopRowButton(event); onSwitchBranch(branch.fullName); }}>
                    Switch
                  </button>
                  <button className="ghost-button" disabled={disabled} onClick={(event) => { stopRowButton(event); onForceSwitchBranch(branch.fullName); }}>
                    Force switch
                  </button>
                  <button className="ghost-button" disabled={disabled || branch.isCurrent} onClick={(event) => { stopRowButton(event); onMergeBranch(branch.fullName); }}>
                    <GitMerge size={14} />
                    Merge
                  </button>
                  {branch.branchKind === "local" ? (
                    <>
                      <button className="ghost-button" disabled={disabled} onClick={(event) => { stopRowButton(event); setContextMenu({ branch, x: 16, y: 16, renameValue: branch.name.replace(/^origin\//, ""), renameMode: true }); }}>
                        Rename
                      </button>
                      <button className="ghost-button ghost-button--danger" disabled={disabled || branch.isCurrent} onClick={(event) => { stopRowButton(event); onRequestDeleteBranch(branch); }}>
                        <Trash2 size={14} />
                        Delete local
                      </button>
                      {branch.trackingName ? (
                        <button className="ghost-button ghost-button--danger" disabled={disabled} onClick={(event) => { stopRowButton(event); onRequestDeleteBranch({ ...branch, branchKind: "remote", fullName: `refs/remotes/${branch.trackingName}`, name: branch.trackingName ?? branch.name }); }}>
                          Delete remote
                        </button>
                      ) : null}
                    </>
                  ) : (
                    <button className="ghost-button ghost-button--danger" disabled={disabled} onClick={(event) => { stopRowButton(event); onRequestDeleteBranch(branch); }}>
                      Delete remote
                    </button>
                  )}
                </div>
              ) : null}
            </div>
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
    <section ref={rootRef} className={clsx("branch-panel", hasMergeConflict && "branch-panel--conflicted", isFullscreen && "branch-panel--fullscreen")}>
      <div className="board__header">
        <div>
          <p className="eyebrow">Branches</p>
          <h3>{selectedBranchFullName ? (localBranches.concat(remoteBranches).find((branch) => branch.fullName === selectedBranchFullName)?.name ?? "Branch view") : "Branch view"}</h3>
        </div>
        <div className="branch-panel__header-actions">
          <button className="ghost-button" disabled={disabled} onClick={onOpenCreateBranch}>
            <Plus size={15} />
            New branch
          </button>
          <button className="ghost-button" onClick={() => void toggleFullscreen()}>
            {isFullscreen ? <Minimize2 size={15} /> : <Expand size={15} />}
            {isFullscreen ? "Window" : "Fullscreen"}
          </button>
        </div>
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
              <button
                className="ghost-button"
                disabled={disabled}
                onClick={() => {
                  onForceSwitchBranch(contextMenu.branch.fullName);
                  setContextMenu(null);
                }}
              >
                Force switch
              </button>
              <button
                className="ghost-button"
                disabled={disabled || contextMenu.branch.isCurrent}
                onClick={() => {
                  onMergeBranch(contextMenu.branch.fullName);
                  setContextMenu(null);
                }}
              >
                Merge
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
                  onRequestDeleteBranch(contextMenu.branch);
                  setContextMenu(null);
                }}
              >
                {contextMenu.branch.branchKind === "local" ? "Delete local" : "Delete remote"}
              </button>
              {contextMenu.branch.branchKind === "local" && contextMenu.branch.trackingName ? (
                <button
                  className="ghost-button ghost-button--danger"
                  disabled={disabled}
                  onClick={() => {
                    onRequestDeleteBranch({
                      ...contextMenu.branch,
                      branchKind: "remote",
                      fullName: `refs/remotes/${contextMenu.branch.trackingName}`,
                      name: contextMenu.branch.trackingName ?? contextMenu.branch.name,
                    });
                    setContextMenu(null);
                  }}
                >
                  Delete remote
                </button>
              ) : null}
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