import { FolderPlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RepositoryConfig, RepositorySshSettings } from "../../features/repositories/api";
import { formatRepoLabel } from "../utils/formatters";
import clsx from "clsx";
import type { AiSettings } from "../utils/aiSettings";
import {
  defaultThemeSettings,
  presetThemeOptions,
  themeOptions,
  type ThemeSettings,
} from "../utils/themeSettings";

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
  onSaveSshSettings: (settings: RepositorySshSettings) => void;
  onPickSshPrivateKey: () => Promise<string | null> | string | null;
  settingsDisabled: boolean;
  aiSettings: AiSettings;
  onAiSettingsChange: (next: AiSettings) => void;
  themeSettings: ThemeSettings;
  onThemeSettingsChange: (next: ThemeSettings) => void;
  themeValidationError: string | null;
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
  onSaveSshSettings,
  onPickSshPrivateKey,
  settingsDisabled,
  aiSettings,
  onAiSettingsChange,
  themeSettings,
  onThemeSettingsChange,
  themeValidationError,
}: RepoManagerDialogProps) {
  const [draftRemotes, setDraftRemotes] = useState<Array<{ originalName: string | null; name: string; fetchUrl: string; pushUrl: string }>>([]);
  const [draftSshSettings, setDraftSshSettings] = useState<RepositorySshSettings | null>(null);

  useEffect(() => {
    if (!repoConfig) {
      setDraftRemotes([]);
      setDraftSshSettings(null);
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

    setDraftSshSettings({ ...repoConfig.sshSettings });
  }, [repoConfig]);

  const sshKeyListId = `repo-ssh-keys-${(selectedRepository ?? "none").replace(/[^a-z0-9_-]/gi, "-")}`;

  return (
    <div className="dialog-backdrop dialog-backdrop--repo-manager">
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
          <section className="repo-manager-section repo-manager-section--stretch">
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

          <section className="repo-manager-section repo-manager-section--stretch">
            <div className="repo-manager-section__header">
              <h3>Clone repository</h3>
            </div>

            <div className="repo-clone-form repo-pane-scroll panel-scroll">
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

          <section className="repo-manager-section repo-manager-section--stretch">
            <div className="repo-manager-section__header">
              <h3>Repository settings</h3>
            </div>

            {repoConfigLoading ? <p className="muted">Loading repository settings...</p> : null}
            {repoConfigError ? <p className="muted">{repoConfigError}</p> : null}

            {!repoConfigLoading && !repoConfigError && repoConfig ? (
              <div className="repo-config-card repo-config-card--stretch panel-scroll">
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

                <div className="repo-config-remotes repo-config-remotes--scroll panel-scroll">
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

          <section className="repo-manager-section repo-manager-section--stretch">
            <div className="repo-manager-section__header">
              <h3>SSH</h3>
            </div>

            {repoConfigLoading ? <p className="muted">Loading SSH settings...</p> : null}
            {repoConfigError ? <p className="muted">SSH settings are unavailable until repository settings load successfully.</p> : null}

            {!repoConfigLoading && !repoConfigError && repoConfig && draftSshSettings ? (
              <div className="repo-config-card repo-config-card--stretch panel-scroll">
                <label className="repo-form-field">
                  <span>SSH client</span>
                  <select
                    className="changes-filter"
                    disabled={settingsDisabled}
                    value={draftSshSettings.mode}
                    onChange={(event) => setDraftSshSettings((current) => current ? { ...current, mode: event.target.value as RepositorySshSettings["mode"] } : current)}
                  >
                    <option value="auto">Auto</option>
                    <option value="openssh">OpenSSH</option>
                    <option value="putty">PuTTY / Pageant</option>
                  </select>
                </label>

                <label className="repo-form-field repo-form-field--checkbox">
                  <input
                    type="checkbox"
                    checked={draftSshSettings.useUserSshConfig}
                    disabled={settingsDisabled}
                    onChange={(event) => setDraftSshSettings((current) => current ? { ...current, useUserSshConfig: event.target.checked } : current)}
                  />
                  <span>Use local .ssh/config when OpenSSH is active</span>
                </label>

                <label className="repo-form-field">
                  <span>Username override</span>
                  <input
                    className="changes-filter"
                    disabled={settingsDisabled}
                    value={draftSshSettings.username ?? ""}
                    onChange={(event) => setDraftSshSettings((current) => current ? { ...current, username: event.target.value || null } : current)}
                    placeholder="git"
                  />
                </label>

                <label className="repo-form-field">
                  <span>Private key</span>
                  <div className="repo-form-field__row">
                    <input
                      className="changes-filter"
                      list={sshKeyListId}
                      disabled={settingsDisabled}
                      value={draftSshSettings.privateKeyPath ?? ""}
                      onChange={(event) => setDraftSshSettings((current) => current ? { ...current, privateKeyPath: event.target.value || null } : current)}
                      placeholder="Leave empty to use agent or default identity"
                    />
                    <button
                      className="ghost-button"
                      disabled={settingsDisabled}
                      onClick={() => {
                        void Promise.resolve(onPickSshPrivateKey()).then((selectedPath) => {
                          if (!selectedPath) {
                            return;
                          }

                          setDraftSshSettings((current) => current ? { ...current, privateKeyPath: selectedPath } : current);
                        });
                      }}
                    >
                      Browse
                    </button>
                  </div>
                </label>

                <label className="repo-form-field">
                  <span>Password / passphrase</span>
                  <input
                    className="changes-filter"
                    type="password"
                    disabled={settingsDisabled}
                    value={draftSshSettings.password ?? ""}
                    onChange={(event) => setDraftSshSettings((current) => current ? { ...current, password: event.target.value || null } : current)}
                    placeholder="Optional. Stored locally for this repository."
                  />
                </label>

                <div className="repo-ssh-discovery">
                  <p className="muted">
                    OpenSSH: {repoConfig.sshDiscovery.openSshCommand ?? "Not found"}
                  </p>
                  <p className="muted">
                    PuTTY / plink: {repoConfig.sshDiscovery.puttyCommand ?? "Not found"}
                  </p>
                  <p className="muted">
                    .ssh/config: {repoConfig.sshDiscovery.userConfigPath ?? "Not detected"}
                  </p>
                  <p className="muted">
                    Use remote URLs like git@personal:owner/repo.git when you want OpenSSH host aliases from .ssh/config to select a different GitHub account.
                  </p>
                </div>

                {repoConfig.sshDiscovery.configHosts.length ? (
                  <div className="repo-ssh-meta-block">
                    <strong>Detected config hosts</strong>
                    <div className="repo-ssh-chip-list">
                      {repoConfig.sshDiscovery.configHosts.map((host) => (
                        <span key={host.alias} className="repo-ssh-chip" title={host.hostName ?? host.alias}>
                          {host.alias}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {repoConfig.sshDiscovery.privateKeys.length ? (
                  <>
                    <datalist id={sshKeyListId}>
                      {repoConfig.sshDiscovery.privateKeys.map((keyOption) => (
                        <option key={keyOption.path} value={keyOption.path} label={`${keyOption.label} (${keyOption.keyKind})`} />
                      ))}
                    </datalist>
                    <div className="repo-ssh-meta-block">
                      <strong>Detected local keys</strong>
                      <div className="repo-ssh-chip-list">
                        {repoConfig.sshDiscovery.privateKeys.map((keyOption) => (
                          <button
                            key={keyOption.path}
                            type="button"
                            className={clsx(
                              "repo-ssh-chip repo-ssh-chip--button",
                              draftSshSettings.privateKeyPath === keyOption.path && "repo-ssh-chip--active",
                            )}
                            disabled={settingsDisabled}
                            onClick={() => setDraftSshSettings((current) => current ? { ...current, privateKeyPath: keyOption.path } : current)}
                            title={keyOption.path}
                          >
                            {keyOption.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                <div className="repo-remote-row__actions">
                  <button className="ghost-button" disabled={settingsDisabled} onClick={() => setDraftSshSettings({ ...repoConfig.sshSettings })}>
                    Reset
                  </button>
                  <button className="ghost-button" disabled={settingsDisabled} onClick={() => onSaveSshSettings(draftSshSettings)}>
                    Save SSH settings
                  </button>
                </div>
              </div>
            ) : null}

            {!repoConfigLoading && !repoConfigError && (!repoConfig || !draftSshSettings) ? (
              <p className="muted">Select a loaded repository to configure SSH for it.</p>
            ) : null}
          </section>

          <section className="repo-manager-section repo-manager-section--stretch">
            <div className="repo-manager-section__header">
              <h3>Appearance</h3>
            </div>

            <div className="repo-config-card repo-config-card--stretch panel-scroll">
              <label className="repo-form-field">
                <span>Theme</span>
                <select
                  className="changes-filter"
                  disabled={settingsDisabled}
                  value={themeSettings.selectedThemeId}
                  onChange={(event) => onThemeSettingsChange({
                    ...themeSettings,
                    selectedThemeId: event.target.value as ThemeSettings["selectedThemeId"],
                  })}
                >
                  {themeOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.id === "custom" ? `Custom${themeSettings.customThemeName.trim() ? ` (${themeSettings.customThemeName.trim()})` : ""}` : option.label}
                    </option>
                  ))}
                </select>
              </label>

              <p className="muted">
                {themeOptions.find((option) => option.id === themeSettings.selectedThemeId)?.description}
              </p>

              {themeSettings.selectedThemeId === "custom" ? (
                <div className="repo-theme-editor">
                  <label className="repo-form-field">
                    <span>Custom theme name</span>
                    <input
                      className="changes-filter"
                      disabled={settingsDisabled}
                      value={themeSettings.customThemeName}
                      onChange={(event) => onThemeSettingsChange({
                        ...themeSettings,
                        customThemeName: event.target.value,
                      })}
                      placeholder="My theme"
                    />
                  </label>

                  <label className="repo-form-field">
                    <span>Base preset</span>
                    <select
                      className="changes-filter"
                      disabled={settingsDisabled}
                      value={themeSettings.customBaseThemeId}
                      onChange={(event) => onThemeSettingsChange({
                        ...themeSettings,
                        customBaseThemeId: event.target.value as ThemeSettings["customBaseThemeId"],
                      })}
                    >
                      {presetThemeOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <label className="repo-form-field">
                    <span>CSS variable overrides (JSON)</span>
                    <textarea
                      className="changes-filter repo-theme-editor__code"
                      disabled={settingsDisabled}
                      rows={10}
                      value={themeSettings.customVariablesText}
                      onChange={(event) => onThemeSettingsChange({
                        ...themeSettings,
                        customVariablesText: event.target.value,
                      })}
                      placeholder={defaultThemeSettings.customVariablesText}
                    />
                  </label>

                  <div className="repo-theme-hints">
                    <p className="muted">Use CSS variable names such as --accent, --panel-bg-start, --text-1, or --app-background.</p>
                    <p className="muted">Values must be valid CSS strings, for example "#0ea5e9", "rgba(255,255,255,0.55)", or "linear-gradient(...)".</p>
                    {themeValidationError ? <p className="repo-theme-error">{themeValidationError}</p> : null}
                  </div>

                  <div className="repo-remote-row__actions">
                    <button
                      className="ghost-button"
                      disabled={settingsDisabled}
                      onClick={() => onThemeSettingsChange({
                        ...themeSettings,
                        customThemeName: defaultThemeSettings.customThemeName,
                        customBaseThemeId: defaultThemeSettings.customBaseThemeId,
                        customVariablesText: defaultThemeSettings.customVariablesText,
                      })}
                    >
                      Reset custom theme
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="repo-manager-section repo-manager-section--stretch">
            <div className="repo-manager-section__header">
              <h3>AI commit messages</h3>
            </div>

            <div className="repo-config-card repo-config-card--stretch panel-scroll">
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