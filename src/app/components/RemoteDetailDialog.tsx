import { X } from "lucide-react";
import type { RemoteDialogState } from "../types";
import { formatRelativeTime } from "../utils/formatters";

type RemoteDetailDialogProps = {
  dialog: RemoteDialogState;
  onClose: () => void;
};

export function RemoteDetailDialog({ dialog, onClose }: RemoteDetailDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel error-detail-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="error-detail-dialog__header">
          <div>
            <p className="eyebrow">Operation details</p>
            <h3>{dialog.title}</h3>
            <p className="muted">{dialog.summary}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close operation details" title="Close operation details">
            <X size={14} />
          </button>
        </div>

        <dl className="preview-details">
          {dialog.occurredAt ? (
            <div>
              <dt>Occurred</dt>
              <dd title={dialog.occurredAt}>{formatRelativeTime(dialog.occurredAt)}</dd>
            </div>
          ) : null}
          {dialog.logPath ? (
            <div>
              <dt>Log file</dt>
              <dd className="error-detail-dialog__path" title={dialog.logPath}>{dialog.logPath}</dd>
            </div>
          ) : null}
        </dl>

        <div className="remote-dialog__detail-block">
          <span className="remote-dialog__detail-label">Full detail</span>
          <pre className="remote-dialog__detail">{dialog.fullDetail ?? dialog.detail ?? dialog.summary}</pre>
        </div>
      </section>
    </div>
  );
}