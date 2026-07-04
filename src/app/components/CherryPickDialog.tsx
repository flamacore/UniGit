import { X } from "lucide-react";

type CherryPickDialogProps = {
  shortHash: string;
  subject: string;
  parentHashes: string[];
  mainlineParent: number;
  disabled: boolean;
  onChangeMainlineParent: (value: number) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function CherryPickDialog({
  shortHash,
  subject,
  parentHashes,
  mainlineParent,
  disabled,
  onChangeMainlineParent,
  onClose,
  onSubmit,
}: CherryPickDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Cherry-pick Merge Commit</p>
            <h3>Choose mainline parent for {shortHash}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close cherry-pick dialog" title="Close cherry-pick dialog">
            <X size={14} />
          </button>
        </div>

        <div className="preview-frame preview-frame--placeholder">
          <strong>{shortHash}</strong>
          <p>{subject}</p>
          <p className="muted">Git needs a mainline parent for merge commits. UniGit will run `git cherry-pick -m &lt;parent&gt;` using the parent you choose below.</p>
        </div>

        <label className="repo-form-field">
          <span className="muted">Mainline parent</span>
          <select
            className="changes-select"
            value={String(mainlineParent)}
            onChange={(event) => onChangeMainlineParent(Number(event.target.value))}
          >
            {parentHashes.map((hash, index) => (
              <option key={`${hash}-${index + 1}`} value={index + 1}>
                {`Parent ${index + 1} (${hash.slice(0, 7)})`}
              </option>
            ))}
          </select>
        </label>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={disabled} onClick={onSubmit}>
            Cherry-pick merge
          </button>
        </div>
      </section>
    </div>
  );
}