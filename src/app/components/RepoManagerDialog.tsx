import { FolderPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RepositoryConfig } from "../../features/repositories/api";
import { formatRepoLabel } from "../utils/formatters";
import clsx from "clsx";

export type RepoManagerDialogProps = {
  repositories: string[];
  selectedRepository: string | null;
  onSelectRepository: (path: string | null) => void;
  onAddExistingRepository: () => void;
  onRemoveRepository: (path: string) => void;
  onClose: () => void;
  canClose: boolean;
  cloneUrl: string;
  onCloneUrlChange: (value: string) => void;
  cloneDestination: string;
  onCloneDestinationChange: (value: string) => void;
  onPickCloneDestination: () => void;
  onClone: () => void;
  cloneDisabled: boolean;
  repoConfig: RepositoryConfig | null;
  repoConfigLoading: boolean;
  repoConfigError: string | null;
  onSaveRemote: (originalName: string | null, name: string, fetchUrl: string, pushUrl: string) => void;
  onDeleteRemote: (name: string) => void;
  settingsDisabled: boolean;
};

export function RepoManagerDialog({
  repositories,
  selectedRepository,
  onSelectRepository,
  onAddExistingRepository,
  onRemoveRepository,
  onClose,
  canClose,
  cloneUrl,
  onCloneUrlChange,
  cloneDestination,
  onCloneDestinationChange,
  onPickCloneDestination,
  onClone,
  cloneDisabled,
  repoConfig,
  repoConfigLoading,
  repoConfigError,
  onSaveRemote,
  onDeleteRemote,
  settingsDisabled,
}: RepoManagerDialogProps) {
  const [draftRemotes, setDraftRemotes] = useState<Array<{ originalName: string | null; name: string; fetchUrl: string; pushUrl: string }>>([]);

  useEffect(() => {
    if (!repoConfig) {
      setDraftRemotes([]);
      return;
    }

    setDraftRemotes(
      repoConfig.remotes.map((remote) => ({
        originalName: remote.name,
        name: remote.name,
        fetchUrl: remote.fetchUrl ?? "",
        pushUrl: remote.pushUrl ?? remote.fetchUrl ?? "",
      })),
    );
  }, [repoConfig]);

  return (
    <div className="dialog-backdrop">
      <section className="panel repo-manager-dialog">
        <div className="repo-manager-dialog__header">
          <div>
            <p className="eyebrow">Repositories</p>
            <h2>Repository manager</h2>
          </div>
          {canClose ? (
            <button className="icon-button" onClick={onClose}>
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="repo-manager-dialog__body">
          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Loaded repositories</h3>
              <button className="ghost-button" onClick={onAddExistingRepository}>
                <FolderPlus size={15} />
                Open existing
              </button>
            </div>

            <div className="repo-manager-list panel-scroll">
              {repositories.length ? repositories.map((repo) => (
                <div key={repo} className={clsx("repo-manager-row", selectedRepository === repo && "repo-manager-row--selected")}>
                  <button className="repo-manager-row__main" onClick={() => onSelectRepository(repo)}>
                    <strong>{formatRepoLabel(repo)}</strong>
                    <span>{repo}</span>
                  </button>
                  <button className="ghost-button ghost-button--danger" onClick={() => onRemoveRepository(repo)}>
                    Remove
                  </button>
                </div>
              )) : <p className="muted">No repositories loaded yet. Clone one or open an existing local checkout.</p>}
            </div>
          </section>

          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Clone repository</h3>
            </div>

            <div className="repo-clone-form">
              <label className="repo-form-field">
                <span>Remote URL</span>
                <input
                  className="changes-filter"
                  placeholder="git@github.com:owner/repo.git or https://..."
                  value={cloneUrl}
                  onChange={(event) => onCloneUrlChange(event.target.value)}
                />
              </label>

              <label className="repo-form-field">
                <span>Destination path</span>
                <div className="repo-form-field__row">
                  <input
                    className="changes-filter"
                    placeholder="C:/Code/MyRepo"
                    value={cloneDestination}
                    onChange={(event) => onCloneDestinationChange(event.target.value)}
                  />
                  <button className="ghost-button" onClick={onPickCloneDestination}>
                    Browse
                  </button>
                </div>
              </label>

              <button className="primary-button" disabled={cloneDisabled} onClick={onClone}>
                Clone repository
              </button>
            </div>
          </section>

          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>Repository settings</h3>
            </div>

            {repoConfigLoading ? <p className="muted">Loading repository settings...</p> : null}
            {repoConfigError ? <p className="muted">{repoConfigError}</p> : null}

            {!repoConfigLoading && !repoConfigError && repoConfig ? (
              <div className="repo-config-card">
                <dl className="repo-config-grid">
                  <div>
                    <dt>Name</dt>
                    <dd>{repoConfig.repoName}</dd>
                  </div>
                  <div>
                    <dt>Path</dt>
                    <dd>{repoConfig.repoPath}</dd>
                  </div>
                  <div>
                    <dt>Branch</dt>
                    <dd>{repoConfig.detachedHead ? `Detached at ${repoConfig.currentBranch}` : repoConfig.currentBranch}</dd>
                  </div>
                </dl>

                <div className="repo-config-remotes">
                  <div className="preview-panel__header">
                    <strong>Remotes</strong>
                    <div className="repo-config-remotes__actions">
                      <span className="preview-panel__meta">{draftRemotes.length}</span>
                      <button
                        className="ghost-button"
                        disabled={settingsDisabled}
                        onClick={() => setDraftRemotes((current) => [...current, { originalName: null, name: "", fetchUrl: "", pushUrl: "" }])}
                      >
                        Add remote
                      </button>
                    </div>
                  </div>
                  {draftRemotes.length ? draftRemotes.map((remote, index) => (
                    <div key={`${remote.originalName ?? "new"}-${index}`} className="repo-remote-row">
                      <label className="repo-form-field">
                        <span>Name</span>
                        <input
                          className="changes-filter"
                          value={remote.name}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, name: event.target.value } : entry))}
                        />
                      </label>
                      <label className="repo-form-field">
                        <span>Fetch URL</span>
                        <input
                          className="changes-filter"
                          value={remote.fetchUrl}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, fetchUrl: event.target.value } : entry))}
                        />
                      </label>
                      <label className="repo-form-field">
                        <span>Push URL</span>
                        <input
                          className="changes-filter"
                          value={remote.pushUrl}
                          onChange={(event) => setDraftRemotes((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, pushUrl: event.target.value } : entry))}
                        />
                      </label>
                      <div className="repo-remote-row__actions">
                        <button
                          className="ghost-button"
                          disabled={settingsDisabled || !remote.name.trim() || !remote.fetchUrl.trim()}
                          onClick={() => onSaveRemote(remote.originalName, remote.name.trim(), remote.fetchUrl.trim(), remote.pushUrl.trim())}
                        >
                          Save remote
                        </button>
                        <button
                          className="ghost-button ghost-button--danger"
                          disabled={settingsDisabled || !remote.originalName}
                          onClick={() => {
                            if (remote.originalName) {
                              onDeleteRemote(remote.originalName);
                            } else {
                              setDraftRemotes((current) => current.filter((_, entryIndex) => entryIndex !== index));
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  )) : <p className="muted">No remotes configured yet. Add one here.</p>}
                </div>
              </div>
            ) : null}

            {!repoConfigLoading && !repoConfigError && !repoConfig ? (
              <p className="muted">Select a loaded repository to inspect its settings.</p>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}