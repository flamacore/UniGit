import { CheckCircle2, Eye, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ConflictKind, ConflictStrategy, FileChange, RepositoryOperation } from "../../features/repositories/api";

type ConflictResolutionDialogProps = {
  operation: RepositoryOperation | null;
  conflictedFiles: FileChange[];
  disabled: boolean;
  onClose: () => void;
  onResolve: (paths: string[], strategy: ConflictStrategy) => void;
  onInspect: (path: string) => void;
  onAbort: () => void;
  onContinue: () => void;
};

// What happened, and what each button will actually do to the file.
const CONFLICT_COPY: Record<ConflictKind, { label: string; current: string; incoming: string }> = {
  "both-modified": { label: "Changed on both sides", current: "Keep current", incoming: "Take incoming" },
  "both-added": { label: "Added on both sides", current: "Keep current", incoming: "Take incoming" },
  "both-deleted": { label: "Deleted on both sides", current: "Delete", incoming: "Delete" },
  "added-by-us": { label: "Added here", current: "Keep file", incoming: "Delete file" },
  "added-by-them": { label: "Added in incoming", current: "Delete file", incoming: "Keep file" },
  "deleted-by-us": { label: "Deleted here, changed in incoming", current: "Keep deleted", incoming: "Restore incoming" },
  "deleted-by-them": { label: "Changed here, deleted in incoming", current: "Keep current", incoming: "Delete file" },
};

const OPERATION_NOUN: Record<RepositoryOperation["kind"], string> = {
  merge: "merge",
  "cherry-pick": "cherry-pick",
  revert: "revert",
  rebase: "rebase",
};

export function ConflictResolutionDialog({
  operation,
  conflictedFiles,
  disabled,
  onClose,
  onResolve,
  onInspect,
  onAbort,
  onContinue,
}: ConflictResolutionDialogProps) {
  const allPaths = useMemo(() => conflictedFiles.map((file) => file.path), [conflictedFiles]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const noun = operation ? OPERATION_NOUN[operation.kind] : "merge";

  // Drop selections for files that have been resolved since the last refresh.
  useEffect(() => {
    setSelectedPaths((current) => current.filter((path) => allPaths.includes(path)));
  }, [allPaths]);

  const allSelected = allPaths.length > 0 && selectedPaths.length === allPaths.length;
  const targetPaths = selectedPaths.length > 0 ? selectedPaths : allPaths;
  const scopeLabel = selectedPaths.length > 0 ? `${selectedPaths.length} selected` : "all";

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
            <p className="eyebrow">{noun} in progress</p>
            <h3 className="title-truncate" title={operation?.label}>{operation?.label ?? "Unresolved conflicts"}</h3>
            <p className="muted">
              {conflictedFiles.length > 0
                ? "Pick which version of each file to keep. Nothing is committed until you complete the " + noun + "."
                : "Every conflict is resolved. Complete the " + noun + " to record it."}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close conflict dialog" title="Close (you can come back later)">
            <X size={14} />
          </button>
        </div>

        {conflictedFiles.length > 0 ? (
          <>
            <div className="conflict-dialog__bulk">
              <label className="conflict-dialog__select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelectedPaths(allSelected ? [] : allPaths)}
                />
                <span>{conflictedFiles.length} conflict{conflictedFiles.length === 1 ? "" : "s"} left</span>
              </label>
              <span className="conflict-dialog__bulk-actions">
                <span className="muted">Apply to {scopeLabel}:</span>
                <button className="ghost-button" disabled={disabled} onClick={() => onResolve(targetPaths, "ours")}>Keep current</button>
                <button className="ghost-button" disabled={disabled} onClick={() => onResolve(targetPaths, "theirs")}>Take incoming</button>
                <button
                  className="ghost-button"
                  disabled={disabled}
                  title="Use the file as it is on disk now, after fixing it by hand in your editor"
                  onClick={() => onResolve(targetPaths, "manual")}
                >
                  Mark as resolved
                </button>
              </span>
            </div>

            <div className="conflict-dialog__list panel-scroll">
              {conflictedFiles.map((file) => {
                const copy = CONFLICT_COPY[file.conflictKind ?? "both-modified"];
                const separator = file.path.lastIndexOf("/");
                const directory = separator >= 0 ? file.path.slice(0, separator + 1) : "";
                const fileName = file.path.slice(separator + 1);

                return (
                  <div key={file.path} className="conflict-dialog__row">
                    <input
                      type="checkbox"
                      aria-label={`Select ${file.path}`}
                      checked={selectedPaths.includes(file.path)}
                      onChange={() => togglePath(file.path)}
                    />
                    <div className="conflict-dialog__file" title={file.path}>
                      <strong>{fileName}</strong>
                      <small>{directory || "./"} · {copy.label}</small>
                    </div>
                    <button className="icon-button" title="Preview this file" aria-label={`Preview ${file.path}`} onClick={() => onInspect(file.path)}>
                      <Eye size={14} />
                    </button>
                    <button className="ghost-button" disabled={disabled} onClick={() => onResolve([file.path], "ours")}>{copy.current}</button>
                    <button className="ghost-button" disabled={disabled} onClick={() => onResolve([file.path], "theirs")}>{copy.incoming}</button>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p className="merge-dialog__verdict merge-dialog__verdict--success">
            <CheckCircle2 size={15} />
            All conflicts resolved.
          </p>
        )}

        <div className="branch-action-dialog__actions conflict-dialog__footer">
          {operation ? (
            <button
              className="ghost-button ghost-button--danger"
              disabled={disabled}
              title={`Cancel the ${noun} and return the branch to how it was`}
              onClick={onAbort}
            >
              Abort {noun}
            </button>
          ) : <span />}
          <span className="conflict-dialog__bulk-actions">
            <button className="ghost-button" onClick={onClose}>Close</button>
            {operation ? (
              <button className="primary-button" disabled={disabled || conflictedFiles.length > 0} onClick={onContinue}>
                Complete {noun}
              </button>
            ) : null}
          </span>
        </div>
      </section>
    </div>
  );
}
