import clsx from "clsx";
import type { JSX, MouseEvent } from "react";
import type { ChangeListItem } from "../types";

export type DropLaneProps = {
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
  onOpenContextMenu: (item: ChangeListItem, lane: "staged" | "unstaged", event: MouseEvent<HTMLElement>) => void;
  selectedPaths: string[];
  primarySelectedPath: string | null;
  bulkActionLabel?: string;
  bulkActionDisabled?: boolean;
  onBulkAction?: () => void;
  bulkSecondaryLabel?: string;
  bulkSecondaryDisabled?: boolean;
  onBulkSecondaryAction?: () => void;
  extraActions?: Array<{
    label: string;
    disabled?: boolean;
    onClick: () => void;
    danger?: boolean;
  }>;
};

export function DropLane({
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
  onOpenContextMenu,
  selectedPaths,
  primarySelectedPath,
  bulkActionLabel,
  bulkActionDisabled,
  onBulkAction,
  bulkSecondaryLabel,
  bulkSecondaryDisabled,
  onBulkSecondaryAction,
  extraActions,
}: DropLaneProps) {
  const orderedPaths = items.map((item) => item.selectionKey);

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

        {bulkActionLabel || bulkSecondaryLabel || extraActions?.length ? (
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
            {extraActions?.map((action) => (
              <button
                key={action.label}
                className={clsx("ghost-button", action.danger && "ghost-button--danger")}
                disabled={action.disabled}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>

      <div className="lane__list">
        {items.map((item) => {
          return (
            <article
              key={`${title}-${item.selectionKey}`}
              className={clsx(
                "change-card",
                `change-card--${item.marker.tone}`,
                selectedPaths.includes(item.selectionKey) && "change-card--selected",
                primarySelectedPath === item.selectionKey && "change-card--focused",
                item.isMeta && "change-card--meta",
              )}
              draggable={!disabled}
              onDragStart={(event) => {
                const draggedPaths = selectedPaths.includes(item.selectionKey)
                  ? Array.from(new Set(items.filter((entry) => selectedPaths.includes(entry.selectionKey)).flatMap((entry) => entry.actionPaths)))
                  : item.actionPaths;
                event.dataTransfer.setData(
                  "application/x-unigit-change",
                  JSON.stringify({
                    paths: draggedPaths,
                    origin: dropAction === "stage" ? "unstaged" : "staged",
                  }),
                );
              }}
              onClick={(event) => onSelect(item.selectionKey, event, orderedPaths)}
              onContextMenu={(event) => onOpenContextMenu(item, dropAction === "stage" ? "staged" : "unstaged", event)}
            >
              <div className="change-card__main">
                <span
                  className={clsx("change-marker", `change-marker--${item.marker.tone}`)}
                  title={item.marker.label}
                  aria-label={item.marker.label}
                />
                <div className="change-card__text">
                  <strong title={item.parentPath ? `${item.parentPath}/${item.fileName}` : item.fileName}>{item.fileName}</strong>
                  {showPaths && item.parentPath ? (
                    <p title={item.parentPath}>{item.parentPath}</p>
                  ) : null}
                  {item.pairedMeta ? (
                    <div className="change-card__meta-child">
                      <span className={clsx("change-marker", `change-marker--${item.pairedMeta.marker.tone}`)} />
                      <span className="change-card__meta-child-name" title={item.pairedMeta.path}>
                        Has paired meta file
                      </span>
                      <span className="change-card__meta-child-status">{item.pairedMeta.statusText}</span>
                    </div>
                  ) : null}
                </div>
              </div>
              <button
                className="ghost-button"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  onAction(item.selectionKey);
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