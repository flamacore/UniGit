import { X } from "lucide-react";

export type BranchCommandInfoKind = "soft-prune" | "local-hard-prune" | "conditional-prune";

type CommandSection = {
  title: string;
  detail: string;
  commands: string[];
  tone?: "default" | "danger";
};

type BranchCommandInfo = {
  eyebrow: string;
  title: string;
  intro: string;
  reassurance: string;
  commandSections: CommandSection[];
  notes: string[];
};

type BranchCommandInfoDialogProps = {
  kind: BranchCommandInfoKind;
  onClose: () => void;
};

const REF_LIST_COMMAND = "git for-each-ref --sort=-committerdate --format=%(refname)\\t%(refname:short)\\t%(objectname)\\t%(committerdate:unix)\\t%(upstream:short)\\t%(HEAD) refs/heads refs/remotes";

const BRANCH_COMMAND_INFO: Record<BranchCommandInfoKind, BranchCommandInfo> = {
  "soft-prune": {
    eyebrow: "Prune safety",
    title: "Soft prune",
    intro: "Refreshes remote-tracking refs and tags so the branch list matches the server, without touching your local branches.",
    reassurance: "This is the safest prune option in UniGit. It only syncs metadata Git already gets from the remote.",
    commandSections: [
      {
        title: "Command UniGit runs",
        detail: "Soft prune is a single remote fetch with prune and tag refresh enabled.",
        commands: ["git fetch --prune --tags"],
      },
    ],
    notes: [
      "It does not delete local branches.",
      "It removes stale refs under refs/remotes/* when the remote no longer advertises them.",
      "Use this first when the branch list looks outdated but you do not want local cleanup.",
    ],
  },
  "local-hard-prune": {
    eyebrow: "Prune safety",
    title: "Local hard prune",
    intro: "Finds local branches whose matching remote branch no longer exists, then force-removes those local refs.",
    reassurance: "This never deletes remote branches, but it is aggressive about deleting stale local branches once they are identified.",
    commandSections: [
      {
        title: "Discovery pass",
        detail: "UniGit first refreshes remote state, then lists every local and remote ref so it can compare them.",
        commands: [
          "git fetch --prune --tags",
          REF_LIST_COMMAND,
        ],
      },
      {
        title: "If the current branch is stale",
        detail: "Only when you are currently on a branch that UniGit is about to prune. The fallback lines run only if the earlier move does not succeed.",
        tone: "danger",
        commands: [
          "git reset --hard HEAD",
          "git clean -fd",
          "git rev-parse --verify refs/heads/<current-branch>",
          "git checkout --detach -f <commit>",
          "git checkout -f <fallback-branch>",
          "git symbolic-ref HEAD refs/heads/<fallback-branch>",
        ],
      },
      {
        title: "Local branch deletion",
        detail: "UniGit tries a direct ref delete first, then falls back to Git's force-delete branch command if needed.",
        tone: "danger",
        commands: [
          "git update-ref -d refs/heads/<stale-branch>",
          "git branch -D <stale-branch>",
        ],
      },
    ],
    notes: [
      "Remote branches are never deleted by this action.",
      "A local branch is only a candidate after UniGit can no longer match it to a remote-tracking branch.",
      "If your current branch is one of those stale branches, UniGit may hard-reset and clean the worktree before moving HEAD away from it.",
    ],
  },
  "conditional-prune": {
    eyebrow: "Prune safety",
    title: "Conditional prune",
    intro: "Builds a candidate list from the rules you enabled, then deletes only the branches that match every enabled rule.",
    reassurance: "This is more targeted than local hard prune because UniGit filters branches before it deletes anything.",
    commandSections: [
      {
        title: "Discovery pass",
        detail: "UniGit refreshes remotes and lists refs before checking your enabled rules.",
        commands: [
          "git fetch --prune --tags",
          REF_LIST_COMMAND,
        ],
      },
      {
        title: "Merged-into checks",
        detail: "Only when you enabled a merged-into rule. UniGit checks whether each candidate is already merged into one of the protected base branches.",
        commands: [
          "git merge-base --is-ancestor <candidate-ref> <base-ref>",
        ],
      },
      {
        title: "Local branch deletion",
        detail: "For matching local branches, UniGit uses the same force-delete path as hard prune.",
        tone: "danger",
        commands: [
          "git update-ref -d refs/heads/<matching-branch>",
          "git branch -D <matching-branch>",
        ],
      },
      {
        title: "Remote branch deletion",
        detail: "Only when your target includes remote branches.",
        tone: "danger",
        commands: [
          "git push <remote> --delete <matching-branch>",
        ],
      },
    ],
    notes: [
      "Every enabled rule is ANDed together.",
      "The current local branch is skipped, so this action does not prune the branch you are currently on.",
      "Remote deletes only happen when you choose a target that includes remote branches.",
    ],
  },
};

export function BranchCommandInfoDialog({ kind, onClose }: BranchCommandInfoDialogProps) {
  const info = BRANCH_COMMAND_INFO[kind];

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <section className="panel branch-action-dialog branch-command-info-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="branch-action-dialog__header">
          <div>
            <p className="eyebrow">{info.eyebrow}</p>
            <h3>{info.title}</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close branch command info dialog" title="Close branch command info dialog">
            <X size={14} />
          </button>
        </div>

        <div className="branch-command-info-dialog__body panel-scroll">
          <div className="branch-command-info-dialog__section">
            <p>{info.intro}</p>
            <p className="muted">{info.reassurance}</p>
          </div>

          <div className="branch-command-info-dialog__section">
            <h4>Commands UniGit runs</h4>
            {info.commandSections.map((section) => (
              <div key={section.title} className="branch-command-info-dialog__command-group">
                <div>
                  <strong>{section.title}</strong>
                  <p className="muted">{section.detail}</p>
                </div>
                <pre className={section.tone === "danger" ? "branch-command-info-dialog__code branch-command-info-dialog__code--danger" : "branch-command-info-dialog__code"}>
                  {section.commands.join("\n")}
                </pre>
              </div>
            ))}
          </div>

          <div className="branch-command-info-dialog__section">
            <h4>Before you run it</h4>
            <ul className="branch-command-info-dialog__notes">
              {info.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="branch-action-dialog__actions">
          <button className="ghost-button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}