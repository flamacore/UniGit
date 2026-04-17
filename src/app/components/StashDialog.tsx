import clsx from "clsx";
import { RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { StashEntry } from "../../features/repositories/api";
import { formatRelativeTime } from "../utils/formatters";

type StashContextMenuState = {
  entry: StashEntry;
  x: number;
  y: number;
};

export type StashDialogProps = {
  entries: StashEntry[];
  loading: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onApply: (reference: string) => void;
  onDrop: (reference: string) => void;
  onClose: () => void;
};

export function StashDialog({
  entries,
  loading,
  disabled,
  onRefresh,
  onApply,
  onDrop,
  onClose,
}: StashDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<StashContextMenuState | null>(null);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (panelRef.current?.contains(event.target as Node)) {
        return;
      }

      setContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [contextMenu]);

  const openContextMenu = (entry: StashEntry, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const bounds = panelRef.current?.getBoundingClientRect();
    setContextMenu({
      entry,
      x: bounds ? event.clientX - bounds.left : 16,
      y: bounds ? event.clientY - bounds.top : 16,
    });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div ref={panelRef} className="panel hidden-local-dialog stash-dialog" onClick={(event) => {
        event.stopPropagation();
        setContextMenu(null);
      }}>
        <div className="hidden-local-dialog__header">
          <div>
            <p className="eyebrow">Stashes</p>
            <h3>Saved work snapshots</h3>
          </div>
          <div className="hidden-local-dialog__actions">
            <span className="preview-panel__meta">{entries.length}</span>
            <button className="ghost-button" disabled={disabled} onClick={onRefresh}>
              <RefreshCw size={14} className={clsx(loading && "spin")} />
              Refresh
            </button>
            <button className="icon-button" onClick={onClose} title="Close stashes">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="local-ignore-list">
          {loading ? <p className="muted">Loading stashes...</p> : null}
          {!loading && entries.length === 0 ? <p className="muted">No stashes saved.</p> : null}
          {!loading && entries.map((entry) => (
            <div
              key={entry.reference}
              className={clsx("local-ignore-row", "stash-row", contextMenu?.entry.reference === entry.reference && "local-ignore-row--selected")}
              onContextMenu={(event) => openContextMenu(entry, event)}
            >
              <div className="stash-row__content">
                <div className="stash-row__top">
                  <strong>{entry.reference}</strong>
                  <span className="muted" title={entry.createdAt}>{formatRelativeTime(entry.createdAt)}</span>
                </div>
                <p className="stash-row__message" title={entry.message}>{entry.message}</p>
                <p className="stash-row__detail" title={entry.shortHash}>{entry.shortHash}</p>
              </div>
            </div>
          ))}
        </div>

        {contextMenu ? (
          <div
            className="branch-context-menu stash-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="ghost-button"
              disabled={disabled}
              onClick={() => {
                onApply(contextMenu.entry.reference);
                setContextMenu(null);
              }}
            >
              Re-apply
            </button>
            <button
              className="ghost-button ghost-button--danger"
              disabled={disabled}
              onClick={() => {
                onDrop(contextMenu.entry.reference);
                setContextMenu(null);
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}