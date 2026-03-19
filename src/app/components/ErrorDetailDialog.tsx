import { X } from "lucide-react";
import type { AppErrorState } from "../types";
import { formatRelativeTime } from "../utils/formatters";

type ErrorDetailDialogProps = {
  error: AppErrorState;
  onClose: () => void;
  onRunRecoveryAction?: () => void;
  recoveryBusy?: boolean;
};

export function ErrorDetailDialog({ error, onClose, onRunRecoveryAction, recoveryBusy = false }: ErrorDetailDialogProps) {
  return (
    <div className="dialog-backdrop dialog-backdrop--error-detail" onClick={onClose}>
      <section className="panel error-detail-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="error-detail-dialog__header">
          <div>
            <p className="eyebrow">Error details</p>
            <h3>{error.title}</h3>
            <p className="muted">{error.summary}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close error details" title="Close error details">
            <X size={14} />
          </button>
        </div>

        <div className="error-detail-dialog__body panel-scroll">
          <dl className="preview-details">
            <div>
              <dt>Occurred</dt>
              <dd title={error.occurredAt}>{formatRelativeTime(error.occurredAt)}</dd>
            </div>
            {error.logPath ? (
              <div>
                <dt>Log file</dt>
                <dd className="error-detail-dialog__path" title={error.logPath}>{error.logPath}</dd>
              </div>
            ) : null}
          </dl>

          <div className="remote-dialog__detail-block error-detail-dialog__detail-block">
            <span className="remote-dialog__detail-label">Full detail</span>
            <pre className="remote-dialog__detail error-detail-dialog__detail">{error.detail}</pre>
          </div>
        </div>

        {error.recoveryAction && onRunRecoveryAction ? (
          <div className="error-detail-dialog__actions">
            <div className="error-banner__copy">
              <strong>{error.recoveryAction.label}</strong>
              <span>{error.recoveryAction.description}</span>
            </div>
            <button className="ghost-button" disabled={recoveryBusy} onClick={onRunRecoveryAction}>
              {recoveryBusy ? "Fixing..." : error.recoveryAction.label}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}