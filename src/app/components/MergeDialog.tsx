import { AlertTriangle, ArrowRight, CheckCircle2, GitMerge, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MergeConflictPreference, MergeLocalChanges, MergePreview } from "../../features/repositories/api";

type MergeDialogProps = {
  branchLabel: string;
  preview: MergePreview | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onClose: () => void;
  onMerge: (localChanges: MergeLocalChanges, conflictPreference: MergeConflictPreference) => void;
};

const VISIBLE_ROWS = 8;

export function MergeDialog({ branchLabel, preview, loading, error, disabled, onClose, onMerge }: MergeDialogProps) {
  const [localChanges, setLocalChanges] = useState<MergeLocalChanges>("keep");
  const [conflictPreference, setConflictPreference] = useState<MergeConflictPreference>("ask");

  useEffect(() => {
    setLocalChanges("keep");
    setConflictPreference("ask");
  }, [branchLabel]);

  const conflicts = preview?.predictedConflicts ?? null;
  const blocked = Boolean(preview?.upToDate || preview?.unrelatedHistories || preview?.operationInProgress);
  const mayConflict = Boolean(preview && !preview.fastForward && !preview.upToDate && (conflicts === null || conflicts.length > 0));

  const verdict = (() => {
    if (!preview) {
      return null;
    }
    if (preview.operationInProgress) {
      return { tone: "danger", text: `A ${preview.operationInProgress} is already in progress. Finish or abort it first.` };
    }
    if (preview.unrelatedHistories) {
      return { tone: "danger", text: "These branches share no history, so git will refuse to merge them." };
    }
    if (preview.upToDate) {
      return { tone: "success", text: `${preview.currentBranch} already contains everything from ${preview.targetLabel}.` };
    }
    if (preview.fastForward) {
      return { tone: "success", text: "Fast-forward: the branch simply moves ahead. No merge commit, no conflicts." };
    }
    if (conflicts === null) {
      return { tone: "mixed", text: "Could not predict conflicts with this git version. You can still merge and resolve as needed." };
    }
    if (conflicts.length === 0) {
      return { tone: "success", text: "Clean merge: both sides changed different things." };
    }
    return {
      tone: "mixed",
      text: `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} changed on both sides and will need a decision.`,
    };
  })();

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel merge-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">Merge</p>
            <h3 className="merge-dialog__route">
              <span title={branchLabel}>{branchLabel}</span>
              <ArrowRight size={16} />
              <span title={preview?.currentBranch}>{preview?.currentBranch ?? "current branch"}</span>
            </h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close merge dialog" title="Close">
            <X size={14} />
          </button>
        </div>

        {loading ? <p className="muted">Checking what this merge will do...</p> : null}
        {error ? <p className="merge-dialog__verdict merge-dialog__verdict--danger"><AlertTriangle size={15} />{error}</p> : null}

        {preview ? (
          <>
            <div className="merge-dialog__stats">
              <div><strong>{preview.incomingCommits}</strong><span>incoming commit{preview.incomingCommits === 1 ? "" : "s"}</span></div>
              <div><strong>{preview.changedFiles}</strong><span>file{preview.changedFiles === 1 ? "" : "s"} changed</span></div>
              <div><strong>{conflicts === null ? "?" : conflicts.length}</strong><span>predicted conflict{conflicts?.length === 1 ? "" : "s"}</span></div>
              <div><strong>{preview.localChanges}</strong><span>uncommitted change{preview.localChanges === 1 ? "" : "s"}</span></div>
            </div>

            {verdict ? (
              <p className={`merge-dialog__verdict merge-dialog__verdict--${verdict.tone}`}>
                {verdict.tone === "success" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                {verdict.text}
              </p>
            ) : null}

            {conflicts && conflicts.length > 0 ? (
              <PathList title="Will conflict" paths={conflicts} />
            ) : null}

            {preview.incomingSubjects.length > 0 ? (
              <div className="merge-dialog__section">
                <p className="eyebrow">Incoming</p>
                <ul className="merge-dialog__list">
                  {preview.incomingSubjects.map((subject) => (
                    <li key={subject} title={subject}>{subject}</li>
                  ))}
                  {preview.incomingCommits > preview.incomingSubjects.length ? (
                    <li className="muted">and {preview.incomingCommits - preview.incomingSubjects.length} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {!blocked && mayConflict ? (
              <fieldset className="merge-dialog__section merge-dialog__choices">
                <legend className="eyebrow">When both sides changed the same file</legend>
                <Choice name="conflict" checked={conflictPreference === "ask"} onChange={() => setConflictPreference("ask")}
                  title="Ask me" detail="Stop and let me pick per file. Recommended." />
                <Choice name="conflict" checked={conflictPreference === "ours"} onChange={() => setConflictPreference("ours")}
                  title={`Keep ${preview.currentBranch}`} detail="The current branch wins every overlapping change." />
                <Choice name="conflict" checked={conflictPreference === "theirs"} onChange={() => setConflictPreference("theirs")}
                  title={`Take ${preview.targetLabel}`} detail="The incoming branch wins every overlapping change." />
              </fieldset>
            ) : null}

            {!blocked && preview.localChanges > 0 ? (
              <fieldset className="merge-dialog__section merge-dialog__choices">
                <legend className="eyebrow">Your {preview.localChanges} uncommitted change{preview.localChanges === 1 ? "" : "s"}</legend>
                <Choice name="local" checked={localChanges === "keep"} onChange={() => setLocalChanges("keep")}
                  title="Keep them" detail="Set aside automatically during the merge and put back afterwards (staged files return as unstaged)." />
                <Choice name="local" checked={localChanges === "discard"} onChange={() => setLocalChanges("discard")}
                  title="Discard them" detail="Permanently delete all uncommitted work, including new files." danger />
                {preview.overlappingLocalChanges.length > 0 && localChanges === "keep" ? (
                  <PathList
                    title={preview.overlappingLocalChanges.length === 1
                      ? "1 of them is a file this merge also changes"
                      : `${preview.overlappingLocalChanges.length} of them are files this merge also changes`}
                    paths={preview.overlappingLocalChanges}
                  />
                ) : null}
              </fieldset>
            ) : null}
          </>
        ) : null}

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Cancel</button>
          <button
            className={localChanges === "discard" ? "ghost-button ghost-button--danger" : "primary-button"}
            disabled={disabled || loading || !preview || blocked}
            onClick={() => onMerge(localChanges, conflictPreference)}
          >
            <GitMerge size={15} />
            {localChanges === "discard" ? "Discard and merge" : "Merge"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Choice({ name, checked, onChange, title, detail, danger }: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  detail: string;
  danger?: boolean;
}) {
  return (
    <label className={`merge-dialog__choice${checked ? " merge-dialog__choice--active" : ""}${danger ? " merge-dialog__choice--danger" : ""}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
    </label>
  );
}

function PathList({ title, paths }: { title: string; paths: string[] }) {
  return (
    <div className="merge-dialog__section">
      <p className="eyebrow">{title}</p>
      <ul className="merge-dialog__list merge-dialog__list--paths">
        {paths.slice(0, VISIBLE_ROWS).map((path) => (
          <li key={path} title={path}>{path}</li>
        ))}
        {paths.length > VISIBLE_ROWS ? <li className="muted">and {paths.length - VISIBLE_ROWS} more</li> : null}
      </ul>
    </div>
  );
}
