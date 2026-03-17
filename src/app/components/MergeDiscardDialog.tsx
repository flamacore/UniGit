import { X } from "lucide-react";

type MergeDiscardDialogProps = {
  branchLabel: string;
  disabled: boolean;
  onClose: () => void;
  onConfirm: () => void;
};

export function MergeDiscardDialog({ branchLabel, disabled, onClose, onConfirm }: MergeDiscardDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Merge blocked</p>
            <h3>Discard local changes and merge?</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close merge prompt" title="Close merge prompt">
            <X size={14} />
          </button>
        </div>

        <p className="muted">
          Local changes would be overwritten while merging {branchLabel}. If you continue, local changes will be discarded before the merge retries.
        </p>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="ghost-button ghost-button--danger" disabled={disabled} onClick={onConfirm}>Discard and merge</button>
        </div>
      </section>
    </div>
  );
}