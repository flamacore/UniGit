import { X } from "lucide-react";

type DetachHeadDialogProps = {
  shortHash: string;
  subject: string;
  createBranch: boolean;
  branchName: string;
  disabled: boolean;
  onChangeCreateBranch: (value: boolean) => void;
  onChangeBranchName: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function DetachHeadDialog({
  shortHash,
  subject,
  createBranch,
  branchName,
  disabled,
  onChangeCreateBranch,
  onChangeBranchName,
  onClose,
  onSubmit,
}: DetachHeadDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Detach HEAD</p>
            <h3>Checkout commit {shortHash}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close detach head dialog" title="Close detach head dialog">
            <X size={14} />
          </button>
        </div>

        <div className="preview-frame preview-frame--placeholder">
          <strong>{shortHash}</strong>
          <p>{subject}</p>
          <p className="muted">Checkout this commit in detached HEAD state, or create a branch first if you want to keep working from it.</p>
        </div>

        <label className="branch-action-dialog__checkbox">
          <input
            type="checkbox"
            checked={createBranch}
            onChange={(event) => onChangeCreateBranch(event.target.checked)}
          />
          <span>Create and switch to a branch at this commit instead</span>
        </label>

        {createBranch ? (
          <label className="repo-form-field">
            <span className="muted">Branch name</span>
            <input
              className="changes-filter"
              value={branchName}
              onChange={(event) => onChangeBranchName(event.target.value)}
              placeholder="feature/from-detached-commit"
            />
          </label>
        ) : null}

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={disabled || (createBranch && !branchName.trim())} onClick={onSubmit}>
            {createBranch ? "Create branch" : "Detach HEAD"}
          </button>
        </div>
      </section>
    </div>
  );
}