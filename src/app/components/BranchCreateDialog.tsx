import { X } from "lucide-react";

type BranchCreateDialogProps = {
  baseLabel: string;
  value: string;
  discardChanges: boolean;
  disabled: boolean;
  onChangeValue: (value: string) => void;
  onChangeDiscard: (value: boolean) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function BranchCreateDialog({
  baseLabel,
  value,
  discardChanges,
  disabled,
  onChangeValue,
  onChangeDiscard,
  onClose,
  onSubmit,
}: BranchCreateDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Create branch</p>
            <h3>New branch from {baseLabel}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close create branch dialog" title="Close create branch dialog">
            <X size={14} />
          </button>
        </div>

        <label className="repo-form-field">
          <span className="muted">Branch name</span>
          <input
            className="changes-filter"
            autoFocus
            value={value}
            onChange={(event) => onChangeValue(event.target.value)}
            placeholder="feature/my-branch"
          />
        </label>

        <label className="branch-action-dialog__checkbox">
          <input
            type="checkbox"
            checked={discardChanges}
            onChange={(event) => onChangeDiscard(event.target.checked)}
          />
          <span>Discard all local changes before switching to the new branch</span>
        </label>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={disabled || !value.trim()} onClick={onSubmit}>Create branch</button>
        </div>
      </section>
    </div>
  );
}