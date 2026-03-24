import { X } from "lucide-react";
import type { ConditionalBranchPruneInput } from "../../features/repositories/api";

export type BranchPruneDialogValue = {
  ageEnabled: boolean;
  ageValue: string;
  ageUnit: "days" | "months" | "years";
  mergedEnabled: boolean;
  mergedIntoMain: boolean;
  mergedIntoMaster: boolean;
  mergedIntoDev: boolean;
  folderEnabled: boolean;
  folderPrefixesText: string;
  regexEnabled: boolean;
  regexPattern: string;
  target: ConditionalBranchPruneInput["target"];
};

type BranchPruneDialogProps = {
  value: BranchPruneDialogValue;
  disabled: boolean;
  onChange: (value: BranchPruneDialogValue) => void;
  onClose: () => void;
  onConfirm: () => void;
};

export function BranchPruneDialog({ value, disabled, onChange, onClose, onConfirm }: BranchPruneDialogProps) {
  const hasRuleEnabled = (
    value.ageEnabled && Boolean(value.ageValue.trim())
  ) || (
    value.mergedEnabled && (value.mergedIntoMain || value.mergedIntoMaster || value.mergedIntoDev)
  ) || (
    value.folderEnabled && Boolean(value.folderPrefixesText.trim())
  ) || (
    value.regexEnabled && Boolean(value.regexPattern.trim())
  );

  const update = (patch: Partial<BranchPruneDialogValue>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog branch-prune-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Prune Conditional...</p>
            <h3>Branch cleanup rules</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close conditional prune dialog" title="Close conditional prune dialog">
            <X size={14} />
          </button>
        </div>

        <p className="muted">
          Enabled rules are combined together. Only branches matching every enabled rule will be removed.
        </p>

        <div className="branch-prune-dialog__body">
          <label className="branch-action-dialog__checkbox branch-prune-dialog__rule">
            <input
              type="checkbox"
              checked={value.ageEnabled}
              onChange={(event) => update({ ageEnabled: event.target.checked })}
            />
            <span>Remove branches older than</span>
          </label>
          <div className="branch-prune-dialog__inline">
            <input
              className="changes-filter"
              inputMode="numeric"
              placeholder="90"
              value={value.ageValue}
              disabled={!value.ageEnabled}
              onChange={(event) => update({ ageValue: event.target.value.replace(/[^\d]/g, "") })}
            />
            <select
              className="changes-select"
              value={value.ageUnit}
              disabled={!value.ageEnabled}
              onChange={(event) => update({ ageUnit: event.target.value as BranchPruneDialogValue["ageUnit"] })}
            >
              <option value="days">Days</option>
              <option value="months">Months</option>
              <option value="years">Years</option>
            </select>
          </div>

          <label className="branch-action-dialog__checkbox branch-prune-dialog__rule">
            <input
              type="checkbox"
              checked={value.mergedEnabled}
              onChange={(event) => update({ mergedEnabled: event.target.checked })}
            />
            <span>Remove branches merged into</span>
          </label>
          <div className="branch-prune-dialog__targets">
            <label className="branch-action-dialog__checkbox">
              <input
                type="checkbox"
                checked={value.mergedIntoMain}
                disabled={!value.mergedEnabled}
                onChange={(event) => update({ mergedIntoMain: event.target.checked })}
              />
              <span>Main</span>
            </label>
            <label className="branch-action-dialog__checkbox">
              <input
                type="checkbox"
                checked={value.mergedIntoMaster}
                disabled={!value.mergedEnabled}
                onChange={(event) => update({ mergedIntoMaster: event.target.checked })}
              />
              <span>Master</span>
            </label>
            <label className="branch-action-dialog__checkbox">
              <input
                type="checkbox"
                checked={value.mergedIntoDev}
                disabled={!value.mergedEnabled}
                onChange={(event) => update({ mergedIntoDev: event.target.checked })}
              />
              <span>Dev</span>
            </label>
          </div>

          <label className="branch-action-dialog__checkbox branch-prune-dialog__rule">
            <input
              type="checkbox"
              checked={value.folderEnabled}
              onChange={(event) => update({ folderEnabled: event.target.checked })}
            />
            <span>Remove branches under folders</span>
          </label>
          <input
            className="changes-filter"
            placeholder="feature, task, bug"
            value={value.folderPrefixesText}
            disabled={!value.folderEnabled}
            onChange={(event) => update({ folderPrefixesText: event.target.value })}
          />

          <label className="branch-action-dialog__checkbox branch-prune-dialog__rule">
            <input
              type="checkbox"
              checked={value.regexEnabled}
              onChange={(event) => update({ regexEnabled: event.target.checked })}
            />
            <span>Remove branches matching regex</span>
          </label>
          <input
            className="changes-filter"
            placeholder="^(feature|task|bug)/"
            value={value.regexPattern}
            disabled={!value.regexEnabled}
            onChange={(event) => update({ regexPattern: event.target.value })}
          />

          <label className="repo-form-field">
            <span>Remove from</span>
            <select
              className="changes-select"
              value={value.target}
              onChange={(event) => update({ target: event.target.value as BranchPruneDialogValue["target"] })}
            >
              <option value="local">Local only</option>
              <option value="remote">Remote only</option>
              <option value="both">Local and remote</option>
            </select>
          </label>
        </div>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button className="ghost-button ghost-button--danger" disabled={disabled || !hasRuleEnabled} onClick={onConfirm}>
            Run conditional prune
          </button>
        </div>
      </section>
    </div>
  );
}
