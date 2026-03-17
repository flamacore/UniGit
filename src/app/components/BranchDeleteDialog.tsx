import { X } from "lucide-react";
import type { BranchEntry } from "../../features/repositories/api";

type BranchDeleteDialogProps = {
  branch: BranchEntry;
  deleteRemote: boolean;
  remoteLabel: string | null;
  disabled: boolean;
  onChangeDeleteRemote: (value: boolean) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function BranchDeleteDialog({
  branch,
  deleteRemote,
  remoteLabel,
  disabled,
  onChangeDeleteRemote,
  onClose,
  onConfirm,
}: BranchDeleteDialogProps) {
  const isLocal = branch.branchKind === "local";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Delete branch</p>
            <h3>{branch.name}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close delete branch dialog" title="Close delete branch dialog">
            <X size={14} />
          </button>
        </div>

        <p className="muted">
          {isLocal
            ? "Delete the local branch now."
            : "Delete the remote branch now."}
        </p>

        {isLocal && remoteLabel ? (
          <label className="branch-action-dialog__checkbox">
            <input
              type="checkbox"
              checked={deleteRemote}
              onChange={(event) => onChangeDeleteRemote(event.target.checked)}
            />
            <span>Also delete remote branch {remoteLabel}</span>
          </label>
        ) : null}

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="ghost-button ghost-button--danger" disabled={disabled} onClick={onConfirm}>
            {isLocal ? "Delete local branch" : "Delete remote branch"}
          </button>
        </div>
      </section>
    </div>
  );
}