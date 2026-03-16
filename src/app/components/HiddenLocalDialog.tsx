import clsx from "clsx";
import { X } from "lucide-react";
import type { MouseEvent } from "react";
import type { HiddenLocalEntry } from "../types";

export type HiddenLocalDialogProps = {
  entries: HiddenLocalEntry[];
  selectedKeys: string[];
  onSelect: (key: string, event: MouseEvent<HTMLElement>, orderedKeys: string[]) => void;
  onOpenContextMenu: (entry: HiddenLocalEntry, event: MouseEvent<HTMLElement>) => void;
  onRestoreOne: (key: string) => void;
  onRestoreSelected: () => void;
  onClose: () => void;
};

export function HiddenLocalDialog({
  entries,
  selectedKeys,
  onSelect,
  onOpenContextMenu,
  onRestoreOne,
  onRestoreSelected,
  onClose,
}: HiddenLocalDialogProps) {
  const orderedKeys = entries.map((entry) => entry.key);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="panel hidden-local-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="hidden-local-dialog__header">
          <div>
            <p className="eyebrow">Hidden local</p>
            <h3>Locally hidden changes</h3>
          </div>
          <div className="hidden-local-dialog__actions">
            <span className="preview-panel__meta">{entries.length}</span>
            <button className="ghost-button" disabled={selectedKeys.length === 0} onClick={onRestoreSelected}>
              Restore selected
            </button>
            <button className="icon-button" onClick={onClose} title="Close hidden local">
              <X size={14} />
            </button>
          </div>
        </div>

        <div className="local-ignore-list">
          {entries.length ? entries.map((entry) => (
            <div
              key={entry.key}
              className={clsx("local-ignore-row", selectedKeys.includes(entry.key) && "local-ignore-row--selected")}
              onClick={(event) => onSelect(entry.key, event, orderedKeys)}
              onContextMenu={(event) => onOpenContextMenu(entry, event)}
            >
              <span title={entry.label}>{entry.label}</span>
              <button className="ghost-button" onClick={(event) => {
                event.stopPropagation();
                onRestoreOne(entry.key);
              }}>
                Restore
              </button>
            </div>
          )) : <p className="muted">No locally hidden changes.</p>}
        </div>
      </div>
    </div>
  );
}