import { FolderPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RepositoryConfig } from "../../features/repositories/api";
import { formatRepoLabel } from "../utils/formatters";
import clsx from "clsx";
import type { AiSettings } from "../utils/aiSettings";

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
  aiSettings: AiSettings;
  onAiSettingsChange: (next: AiSettings) => void;
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
  aiSettings,
  onAiSettingsChange,
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
            <button className="icon-button" onClick={onClose} aria-label="Close repository manager" title="Close repository manager">
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

          <section className="repo-manager-section">
            <div className="repo-manager-section__header">
              <h3>AI commit messages</h3>
            </div>

            <div className="repo-config-card">
              <label className="repo-form-field">
                <span>Provider</span>
                <select
                  className="changes-filter"
                  value={aiSettings.provider}
                  disabled={settingsDisabled}
                  onChange={(event) => onAiSettingsChange({ ...aiSettings, provider: event.target.value as AiSettings["provider"] })}
                >
                  <option value="none">Disabled</option>
                  <option value="ollama">Ollama</option>
                  <option value="openai">OpenAI API</option>
                  <option value="claude">Claude API</option>
                </select>
              </label>

              <label className="repo-form-field">
                <span>Request timeout (seconds)</span>
                <input
                  className="changes-filter"
                  type="number"
                  min={5}
                  max={300}
                  disabled={settingsDisabled}
                  value={aiSettings.requestTimeoutSeconds}
                  onChange={(event) => onAiSettingsChange({
                    ...aiSettings,
                    requestTimeoutSeconds: Number.isFinite(Number(event.target.value))
                      ? Math.min(300, Math.max(5, Math.round(Number(event.target.value))))
                      : aiSettings.requestTimeoutSeconds,
                  })}
                />
              </label>

              {aiSettings.provider === "ollama" ? (
                <div className="repo-config-remotes">
                  <label className="repo-form-field">
                    <span>Ollama endpoint</span>
                    <input
                      className="changes-filter"
                      disabled={settingsDisabled}
                      value={aiSettings.ollamaEndpoint}
                      onChange={(event) => onAiSettingsChange({ ...aiSettings, ollamaEndpoint: event.target.value })}
                      placeholder="http://127.0.0.1:11434"
                    />
                  </label>
                  <label className="repo-form-field">
                    <span>Model</span>
                    <input
                      className="changes-filter"
                      disabled={settingsDisabled}
                      value={aiSettings.ollamaModel}
                      onChange={(event) => onAiSettingsChange({ ...aiSettings, ollamaModel: event.target.value })}
                      placeholder="llama3.1"
                    />
                  </label>
                </div>
              ) : null}

              {aiSettings.provider === "openai" ? (
                <div className="repo-config-remotes">
                  <label className="repo-form-field">
                    <span>OpenAI API key</span>
                    <input
                      className="changes-filter"
                      type="password"
                      disabled={settingsDisabled}
                      value={aiSettings.openAiApiKey}
                      onChange={(event) => onAiSettingsChange({ ...aiSettings, openAiApiKey: event.target.value })}
                      placeholder="sk-..."
                    />
                  </label>
                  <p className="muted">UniGit uses {"gpt-4.1-mini"} for generated commit messages.</p>
                </div>
              ) : null}

              {aiSettings.provider === "claude" ? (
                <div className="repo-config-remotes">
                  <label className="repo-form-field">
                    <span>Claude API key</span>
                    <input
                      className="changes-filter"
                      type="password"
                      disabled={settingsDisabled}
                      value={aiSettings.claudeApiKey}
                      onChange={(event) => onAiSettingsChange({ ...aiSettings, claudeApiKey: event.target.value })}
                      placeholder="sk-ant-..."
                    />
                  </label>
                  <p className="muted">UniGit uses {"claude-3-5-haiku-latest"} for generated commit messages.</p>
                </div>
              ) : null}

              {aiSettings.provider === "none" ? (
                <p className="muted">Select a provider to enable AI-generated commit messages from the staged diff and unpushed commits.</p>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}