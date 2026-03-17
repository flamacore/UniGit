import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type ConflictResolutionDialogProps = {
  branchLabel: string;
  conflictedFiles: string[];
  disabled: boolean;
  onClose: () => void;
  onResolve: (paths: string[], strategy: "ours" | "theirs") => void;
};

export function ConflictResolutionDialog({
  branchLabel,
  conflictedFiles,
  disabled,
  onClose,
  onResolve,
}: ConflictResolutionDialogProps) {
  const [selectedPaths, setSelectedPaths] = useState<string[]>(conflictedFiles);

  useEffect(() => {
    setSelectedPaths(conflictedFiles);
  }, [conflictedFiles]);

  const allSelected = useMemo(() => conflictedFiles.length > 0 && selectedPaths.length === conflictedFiles.length, [conflictedFiles.length, selectedPaths.length]);

  const togglePath = (path: string) => {
    setSelectedPaths((current) => current.includes(path)
      ? current.filter((value) => value !== path)
      : [...current, path]);
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel conflict-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Merge conflicts</p>
            <h3>{branchLabel}</h3>
            <p className="muted">Choose conflicted files, then keep your version or the incoming version.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close conflict dialog" title="Close conflict dialog">
            <X size={14} />
          </button>
        </div>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={() => setSelectedPaths(allSelected ? [] : conflictedFiles)}>
            {allSelected ? "Clear selection" : "Select all"}
          </button>
          <span className="muted">{selectedPaths.length} selected</span>
        </div>

        <div className="conflict-dialog__list panel-scroll">
          {conflictedFiles.map((path) => (
            <label key={path} className="conflict-dialog__row">
              <input
                type="checkbox"
                checked={selectedPaths.includes(path)}
                onChange={() => togglePath(path)}
              />
              <span title={path}>{path}</span>
            </label>
          ))}
        </div>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Close</button>
          <button className="ghost-button" disabled={disabled || selectedPaths.length === 0} onClick={() => onResolve(selectedPaths, "ours")}>Keep yours</button>
          <button className="primary-button" disabled={disabled || selectedPaths.length === 0} onClick={() => onResolve(selectedPaths, "theirs")}>Keep theirs</button>
        </div>
      </section>
    </div>
  );
}