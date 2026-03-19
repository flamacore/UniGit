use std::{
    collections::BTreeMap,
    env,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use tauri::command;
use thiserror::Error;
use tokio::process::Command;

use super::models::{
    AssetDetail, AssetSummary, BranchEntry, CloneResult, CommitDetail, CommitFileEntry,
    CommitGraphPage, CommitGraphRow, CommitMessageContext, CommitSummary, FileChange,
    FileHistoryEntry, FilePreview, ImageComparisonPreset, ImagePreviewSource, MergeBranchResult,
    ModelPreviewResource, ModelPreviewSource,
    RepositoryConfig, RepositoryCounts, RepositoryRemote, RepositorySnapshot, RepositorySshConfigHost,
    RepositorySshDiscovery, RepositorySshKeyOption, RepositorySshSettings, UnityColorValue,
    UnityMaterialPreviewSource, UnityMaterialTexturePreview,
};

const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INLINE_MODEL_BYTES: u64 = 24 * 1024 * 1024;
const LOG_DETAIL_LIMIT: usize = 6_000;
const COMMIT_MESSAGE_DIFF_LIMIT: usize = 30_000;
const COMMIT_MESSAGE_UPSTREAM_LIMIT: usize = 8;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Error)]
enum GitServiceError {
    #[error("Repository path is missing or invalid.")]
    InvalidRepository,
    #[error("Selected file is missing or outside the repository root.")]
    InvalidFileSelection,
    #[error("Git executable was not found on PATH.")]
    GitUnavailable,
    #[error("Git command failed: {0}")]
    GitCommandFailed(String),
    #[error("File preview failed: {0}")]
    FilePreviewFailed(String),
}

#[derive(Debug, Clone, Copy)]
enum PreviewBlobSource {
    WorkingTree,
    Staged,
    Head,
}

#[derive(Debug, Clone)]
struct ParsedUnityMaterial {
    material_name: String,
    shader_guid: Option<String>,
    shader_file_id: Option<String>,
    float_values: std::collections::HashMap<String, f32>,
    color_values: std::collections::HashMap<String, UnityColorValue>,
    texture_slots: Vec<ParsedUnityTextureSlot>,
}

#[derive(Debug, Clone)]
struct ParsedUnityTextureSlot {
    property_name: String,
    guid: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRepositorySshSettings {
    mode: String,
    use_user_ssh_config: bool,
    private_key_path: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRepositorySshSettingsStore {
    repositories: BTreeMap<String, StoredRepositorySshSettings>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRepositorySshSettingsInput {
    mode: String,
    use_user_ssh_config: bool,
    private_key_path: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedSshConfigHostAccumulator {
    alias: String,
    host_name: Option<String>,
    user: Option<String>,
    identity_files: Vec<String>,
    identities_only: bool,
}

#[derive(Debug, Clone)]
struct GitRemoteEnvironment {
    env_pairs: Vec<(String, String)>,
    log_detail: Option<String>,
}

type GitResult<T> = Result<T, GitServiceError>;

#[command]
pub async fn inspect_repository(repo_path: String) -> Result<RepositorySnapshot, String> {
    inspect_repository_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn inspect_repository_config(repo_path: String) -> Result<RepositoryConfig, String> {
    inspect_repository_config_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn clone_repository(remote_url: String, destination_path: String) -> Result<CloneResult, String> {
    clone_repository_inner(remote_url, destination_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn save_repository_remote(
    repo_path: String,
    original_name: Option<String>,
    name: String,
    fetch_url: String,
    push_url: Option<String>,
) -> Result<RepositoryRemote, String> {
    save_repository_remote_inner(repo_path, original_name, name, fetch_url, push_url)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn delete_repository_remote(repo_path: String, name: String) -> Result<String, String> {
    delete_repository_remote_inner(repo_path, name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn save_repository_ssh_settings(
    repo_path: String,
    settings: SaveRepositorySshSettingsInput,
) -> Result<RepositorySshSettings, String> {
    save_repository_ssh_settings_inner(repo_path, settings)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn log_client_event(scope: String, message: String, detail: Option<String>) -> Result<(), String> {
    append_log("frontend", &scope, &message, detail.as_deref())
        .map_err(|error| error.to_string())
}

#[command]
pub async fn get_log_file_path() -> Result<String, String> {
    resolve_log_path()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|error| error.to_string())
}

#[command]
pub async fn clear_git_index_lock(repo_path: String) -> Result<String, String> {
    clear_git_index_lock_inner(repo_path)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn export_file_from_commit(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
    destination_path: String,
) -> Result<(), String> {
    export_file_from_commit_inner(repo_path, commit_hash, relative_path, destination_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn restore_file_from_commit(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
) -> Result<(), String> {
    restore_file_from_commit_inner(repo_path, commit_hash, relative_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn apply_commit_file_patch(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
    reverse: bool,
) -> Result<(), String> {
    apply_commit_file_patch_inner(repo_path, commit_hash, relative_path, reverse)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn inspect_file_preview(repo_path: String, relative_path: String) -> Result<FilePreview, String> {
    inspect_file_preview_inner(repo_path, relative_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn list_commit_history(repo_path: String, limit: usize) -> Result<Vec<CommitSummary>, String> {
    list_commit_history_inner(repo_path, limit)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn list_file_history(repo_path: String, relative_path: String, limit: usize) -> Result<Vec<FileHistoryEntry>, String> {
    list_file_history_inner(repo_path, relative_path, limit)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn list_commit_graph(repo_path: String, limit: usize, skip: usize) -> Result<CommitGraphPage, String> {
    list_commit_graph_inner(repo_path, limit, skip)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn inspect_commit_detail(repo_path: String, commit_hash: String) -> Result<CommitDetail, String> {
    inspect_commit_detail_inner(repo_path, commit_hash)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn inspect_commit_message_context(repo_path: String) -> Result<CommitMessageContext, String> {
    inspect_commit_message_context_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn list_branches(repo_path: String) -> Result<Vec<BranchEntry>, String> {
    list_branches_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn switch_branch(repo_path: String, full_name: String) -> Result<String, String> {
    switch_branch_inner(repo_path, full_name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn force_switch_branch(repo_path: String, full_name: String) -> Result<String, String> {
    force_switch_branch_inner(repo_path, full_name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn create_branch(repo_path: String, name: String, start_point: Option<String>, discard_changes: bool) -> Result<String, String> {
    create_branch_inner(repo_path, name, start_point, discard_changes)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn rename_branch(repo_path: String, current_name: String, next_name: String) -> Result<String, String> {
    rename_branch_inner(repo_path, current_name, next_name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn delete_branch(repo_path: String, full_name: String) -> Result<String, String> {
    delete_branch_inner(repo_path, full_name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn merge_branch(repo_path: String, full_name: String, discard_local_changes: bool) -> Result<MergeBranchResult, String> {
    merge_branch_inner(repo_path, full_name, discard_local_changes)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn resolve_conflicted_files(repo_path: String, paths: Vec<String>, strategy: String) -> Result<String, String> {
    resolve_conflicted_files_inner(repo_path, paths, strategy)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn stage_files(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    apply_path_operation(repo_path, paths, false)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn unstage_files(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    apply_path_operation(repo_path, paths, true)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn discard_paths(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    discard_paths_inner(repo_path, paths)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn add_paths_to_gitignore(repo_path: String, paths: Vec<String>) -> Result<(), String> {
    add_paths_to_gitignore_inner(repo_path, paths)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn push_repository(repo_path: String) -> Result<String, String> {
    push_repository_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn fetch_repository(repo_path: String) -> Result<String, String> {
    fetch_repository_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn pull_repository(repo_path: String) -> Result<String, String> {
    pull_repository_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn force_pull_repository(repo_path: String) -> Result<String, String> {
    force_pull_repository_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn create_commit(repo_path: String, message: String) -> Result<(), String> {
    let path = validate_repository_path(&repo_path).map_err(|error| error.to_string())?;
    let trimmed = message.trim();

    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    run_git(path, ["commit", "-m", trimmed])
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn inspect_repository_inner(repo_path: String) -> GitResult<RepositorySnapshot> {
    let path = validate_repository_path(&repo_path)?;
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1", "--untracked-files=all"])
        .await?;

    let (current_branch, detached_head, ahead, behind, files, counts) = parse_status_output(&branch_output);

    Ok(RepositorySnapshot {
        repo_path: repo_path.clone(),
        repo_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Repository")
            .to_string(),
        current_branch,
        detached_head,
        ahead,
        behind,
        last_refreshed_at: chrono_like_timestamp(),
        files,
        counts,
    })
}

async fn inspect_repository_config_inner(repo_path: String) -> GitResult<RepositoryConfig> {
    let path = validate_repository_path(&repo_path)?;
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1", "--untracked-files=all"])
        .await?;
    let (current_branch, detached_head, _, _, _, _) = parse_status_output(&branch_output);

    let remote_output = run_git_owned(path, vec!["remote".into(), "-v".into()]).await?;
    let mut remotes: Vec<RepositoryRemote> = Vec::new();

    for line in remote_output.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = line.split_whitespace();
        let Some(name) = parts.next() else { continue; };
        let Some(url) = parts.next() else { continue; };
        let Some(kind) = parts.next() else { continue; };

        let remote = if let Some(existing) = remotes.iter_mut().find(|remote| remote.name == name) {
            existing
        } else {
            remotes.push(RepositoryRemote {
                name: name.to_string(),
                fetch_url: None,
                push_url: None,
            });
            remotes.last_mut().expect("remote entry inserted")
        };

        match kind {
            "(fetch)" => remote.fetch_url = Some(url.to_string()),
            "(push)" => remote.push_url = Some(url.to_string()),
            _ => {}
        }
    }

    let ssh_settings = load_repository_ssh_settings(path)?;
    let ssh_discovery = discover_repository_ssh_support()?;

    Ok(RepositoryConfig {
        repo_path: repo_path.clone(),
        repo_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Repository")
            .to_string(),
        current_branch,
        detached_head,
        remotes,
        ssh_settings,
        ssh_discovery,
    })
}

async fn clone_repository_inner(remote_url: String, destination_path: String) -> GitResult<CloneResult> {
    let trimmed_url = remote_url.trim();
    let trimmed_destination = destination_path.trim();

    if trimmed_url.is_empty() || trimmed_destination.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Clone URL and destination path are required.".to_string()));
    }

    let destination = PathBuf::from(trimmed_destination);
    let parent = destination.parent().ok_or_else(|| {
        GitServiceError::GitCommandFailed("Destination path must include a parent directory.".to_string())
    })?;

    if !parent.exists() {
        return Err(GitServiceError::GitCommandFailed("Destination parent directory does not exist.".to_string()));
    }

    run_git_global_owned(vec!["clone".into(), trimmed_url.to_string(), trimmed_destination.to_string()]).await?;

    Ok(CloneResult {
        repo_path: trimmed_destination.to_string(),
        repo_name: destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("Repository")
            .to_string(),
    })
}

async fn save_repository_remote_inner(
    repo_path: String,
    original_name: Option<String>,
    name: String,
    fetch_url: String,
    push_url: Option<String>,
) -> GitResult<RepositoryRemote> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_name = name.trim();
    let trimmed_fetch = fetch_url.trim();
    let trimmed_original = original_name.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let trimmed_push = push_url.as_deref().map(str::trim).filter(|value| !value.is_empty());

    if trimmed_name.is_empty() || trimmed_fetch.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Remote name and fetch URL are required.".to_string()));
    }

    if let Some(existing_name) = trimmed_original {
        if existing_name != trimmed_name {
          run_git_owned(
              path,
              vec!["remote".into(), "rename".into(), existing_name.to_string(), trimmed_name.to_string()],
          )
          .await?;
        }

        run_git_owned(
            path,
            vec!["remote".into(), "set-url".into(), trimmed_name.to_string(), trimmed_fetch.to_string()],
        )
        .await?;
    } else {
        run_git_owned(
            path,
            vec!["remote".into(), "add".into(), trimmed_name.to_string(), trimmed_fetch.to_string()],
        )
        .await?;
    }

    let effective_push = trimmed_push.unwrap_or(trimmed_fetch);
    run_git_owned(
        path,
        vec!["remote".into(), "set-url".into(), "--push".into(), trimmed_name.to_string(), effective_push.to_string()],
    )
    .await?;

    Ok(RepositoryRemote {
        name: trimmed_name.to_string(),
        fetch_url: Some(trimmed_fetch.to_string()),
        push_url: Some(effective_push.to_string()),
    })
}

async fn delete_repository_remote_inner(repo_path: String, name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_name = name.trim();

    if trimmed_name.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Remote name is required.".to_string()));
    }

    run_git_owned(
        path,
        vec!["remote".into(), "remove".into(), trimmed_name.to_string()],
    )
    .await?;

    Ok(format!("Removed remote {trimmed_name}."))
}

async fn save_repository_ssh_settings_inner(
    repo_path: String,
    settings: SaveRepositorySshSettingsInput,
) -> GitResult<RepositorySshSettings> {
    let path = validate_repository_path(&repo_path)?;
    let normalized = normalize_repository_ssh_settings(settings)?;
    persist_repository_ssh_settings(path, &normalized)?;
    Ok(normalized)
}

fn normalize_repository_ssh_settings(settings: SaveRepositorySshSettingsInput) -> GitResult<RepositorySshSettings> {
    let mode = normalize_ssh_mode(&settings.mode);
    let private_key_path = sanitize_optional_string(settings.private_key_path);
    let username = sanitize_optional_string(settings.username);
    let password = sanitize_optional_string(settings.password);

    if let Some(key_path) = private_key_path.as_ref() {
        let key_candidate = expand_home_prefix(key_path);
        if !key_candidate.exists() || !key_candidate.is_file() {
            return Err(GitServiceError::GitCommandFailed(format!(
                "SSH key '{}' does not exist.",
                key_candidate.display()
            )));
        }
    }

    Ok(RepositorySshSettings {
        mode,
        use_user_ssh_config: settings.use_user_ssh_config,
        private_key_path,
        username,
        password,
    })
}

fn default_repository_ssh_settings() -> RepositorySshSettings {
    RepositorySshSettings {
        mode: "auto".to_string(),
        use_user_ssh_config: true,
        private_key_path: None,
        username: None,
        password: None,
    }
}

fn normalize_ssh_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "openssh" => "openssh".to_string(),
        "putty" => "putty".to_string(),
        _ => "auto".to_string(),
    }
}

fn sanitize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn discover_repository_ssh_support() -> GitResult<RepositorySshDiscovery> {
    let ssh_directory = dirs_next::home_dir().map(|path| path.join(".ssh"));
    let user_config_path = ssh_directory
        .as_ref()
        .map(|path| path.join("config"))
        .filter(|path| path.is_file());

    let config_hosts = match user_config_path.as_ref() {
        Some(path) => parse_user_ssh_config(path)?,
        None => Vec::new(),
    };

    let private_keys = match ssh_directory.as_ref() {
        Some(path) => discover_private_key_options(path),
        None => Vec::new(),
    };

    Ok(RepositorySshDiscovery {
        ssh_directory: ssh_directory.map(|path| path.to_string_lossy().into_owned()),
        user_config_path: user_config_path.map(|path| path.to_string_lossy().into_owned()),
        config_hosts,
        private_keys,
        open_ssh_command: find_executable_path("ssh.exe", &[PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe")])
            .map(|path| path.to_string_lossy().into_owned()),
        putty_command: find_executable_path(
            "plink.exe",
            &[
                PathBuf::from(r"C:\Program Files\PuTTY\plink.exe"),
                PathBuf::from(r"C:\Program Files (x86)\PuTTY\plink.exe"),
            ],
        )
        .map(|path| path.to_string_lossy().into_owned()),
        pageant_supported: cfg!(windows),
    })
}

fn parse_user_ssh_config(config_path: &Path) -> GitResult<Vec<RepositorySshConfigHost>> {
    let content = fs::read_to_string(config_path).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to read SSH config '{}': {}",
            config_path.display(),
            error
        ))
    })?;

    let mut hosts: Vec<ParsedSshConfigHostAccumulator> = Vec::new();
    let mut active_indexes: Vec<usize> = Vec::new();

    for raw_line in content.lines() {
        let line = raw_line
            .split('#')
            .next()
            .map(str::trim)
            .unwrap_or_default();

        if line.is_empty() {
            continue;
        }

        let mut parts = line.split_whitespace();
        let Some(keyword) = parts.next() else { continue; };
        let remainder = parts.collect::<Vec<_>>().join(" ").trim().to_string();

        if remainder.is_empty() {
            continue;
        }

        match keyword.to_ascii_lowercase().as_str() {
            "host" => {
                active_indexes.clear();
                for alias in remainder.split_whitespace() {
                    let trimmed_alias = alias.trim();
                    if trimmed_alias.is_empty() || trimmed_alias.contains('*') || trimmed_alias.contains('?') {
                        continue;
                    }

                    hosts.push(ParsedSshConfigHostAccumulator {
                        alias: trimmed_alias.to_string(),
                        host_name: None,
                        user: None,
                        identity_files: Vec::new(),
                        identities_only: false,
                    });
                    active_indexes.push(hosts.len() - 1);
                }
            }
            "hostname" => {
                for index in &active_indexes {
                    hosts[*index].host_name = Some(remainder.clone());
                }
            }
            "user" => {
                for index in &active_indexes {
                    hosts[*index].user = Some(remainder.clone());
                }
            }
            "identityfile" => {
                let expanded = expand_home_prefix(&remainder).to_string_lossy().into_owned();
                for index in &active_indexes {
                    hosts[*index].identity_files.push(expanded.clone());
                }
            }
            "identitiesonly" => {
                let enabled = matches!(remainder.to_ascii_lowercase().as_str(), "yes" | "true" | "on" | "1");
                for index in &active_indexes {
                    hosts[*index].identities_only = enabled;
                }
            }
            _ => {}
        }
    }

    Ok(hosts
        .into_iter()
        .map(|entry| RepositorySshConfigHost {
            alias: entry.alias,
            host_name: entry.host_name,
            user: entry.user,
            identity_files: entry.identity_files,
            identities_only: entry.identities_only,
        })
        .collect())
}

fn discover_private_key_options(ssh_directory: &Path) -> Vec<RepositorySshKeyOption> {
    let Ok(entries) = fs::read_dir(ssh_directory) else {
        return Vec::new();
    };

    let mut keys = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| is_private_key_candidate(path))
        .map(|path| {
            let path_string = path.to_string_lossy().into_owned();
            let key_kind = if path.extension().and_then(|value| value.to_str()).is_some_and(|value| value.eq_ignore_ascii_case("ppk")) {
                "putty"
            } else {
                "openssh"
            };

            RepositorySshKeyOption {
                label: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&path_string)
                    .to_string(),
                path: path_string,
                key_kind: key_kind.to_string(),
            }
        })
        .collect::<Vec<_>>();

    keys.sort_by(|left, right| left.label.cmp(&right.label));
    keys
}

fn is_private_key_candidate(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
    if file_name.ends_with(".pub") {
        return false;
    }

    match path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()) {
        Some(extension) => matches!(extension.as_str(), "ppk" | "pem" | "key" | "rsa" | "ed25519"),
        None => matches!(file_name, "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa" | "identity"),
    }
}

fn load_repository_ssh_settings(repo_path: &Path) -> GitResult<RepositorySshSettings> {
    let store = load_repository_ssh_settings_store()?;
    let key = normalize_repository_settings_key(repo_path);

    Ok(store
        .repositories
        .get(&key)
        .cloned()
        .map(repository_ssh_settings_from_stored)
        .unwrap_or_else(default_repository_ssh_settings))
}

fn persist_repository_ssh_settings(repo_path: &Path, settings: &RepositorySshSettings) -> GitResult<()> {
    let mut store = load_repository_ssh_settings_store()?;
    let key = normalize_repository_settings_key(repo_path);
    store.repositories.insert(key, stored_repository_ssh_settings_from_public(settings));
    save_repository_ssh_settings_store(&store)
}

fn repository_ssh_settings_from_stored(settings: StoredRepositorySshSettings) -> RepositorySshSettings {
    RepositorySshSettings {
        mode: normalize_ssh_mode(&settings.mode),
        use_user_ssh_config: settings.use_user_ssh_config,
        private_key_path: settings.private_key_path,
        username: settings.username,
        password: settings.password,
    }
}

fn stored_repository_ssh_settings_from_public(settings: &RepositorySshSettings) -> StoredRepositorySshSettings {
    StoredRepositorySshSettings {
        mode: normalize_ssh_mode(&settings.mode),
        use_user_ssh_config: settings.use_user_ssh_config,
        private_key_path: settings.private_key_path.clone(),
        username: settings.username.clone(),
        password: settings.password.clone(),
    }
}

fn load_repository_ssh_settings_store() -> GitResult<StoredRepositorySshSettingsStore> {
    let path = resolve_repository_ssh_settings_store_path();
    if !path.exists() {
        return Ok(StoredRepositorySshSettingsStore::default());
    }

    let raw = fs::read_to_string(&path).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to read repository SSH settings '{}': {}",
            path.display(),
            error
        ))
    })?;

    serde_json::from_str::<StoredRepositorySshSettingsStore>(&raw).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to parse repository SSH settings '{}': {}",
            path.display(),
            error
        ))
    })
}

fn save_repository_ssh_settings_store(store: &StoredRepositorySshSettingsStore) -> GitResult<()> {
    let path = resolve_repository_ssh_settings_store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            GitServiceError::GitCommandFailed(format!(
                "Failed to create settings directory '{}': {}",
                parent.display(),
                error
            ))
        })?;
    }

    let serialized = serde_json::to_string_pretty(store).map_err(|error| {
        GitServiceError::GitCommandFailed(format!("Failed to serialize repository SSH settings: {error}"))
    })?;

    fs::write(&path, serialized).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to save repository SSH settings '{}': {}",
            path.display(),
            error
        ))
    })
}

fn normalize_repository_settings_key(repo_path: &Path) -> String {
    let canonical = fs::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
    let mut value = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.make_ascii_lowercase();
    }
    value
}

fn resolve_repository_ssh_settings_store_path() -> PathBuf {
    let base = dirs_next::data_local_dir().unwrap_or_else(env::temp_dir);
    base.join("UniGit").join("settings").join("repository-ssh.json")
}

fn resolve_runtime_support_dir() -> PathBuf {
    let base = dirs_next::data_local_dir().unwrap_or_else(env::temp_dir);
    base.join("UniGit").join("runtime")
}

fn expand_home_prefix(value: &str) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        if let Some(home) = dirs_next::home_dir() {
            return home.join(stripped);
        }
    }

    if value == "~" {
        if let Some(home) = dirs_next::home_dir() {
            return home;
        }
    }

    PathBuf::from(value)
}

fn find_executable_path(file_name: &str, fallbacks: &[PathBuf]) -> Option<PathBuf> {
    if let Some(path_value) = env::var_os("PATH") {
        for directory in env::split_paths(&path_value) {
            let candidate = directory.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    fallbacks.iter().find(|candidate| candidate.is_file()).cloned()
}

fn quote_cmd_argument(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }

    let needs_quotes = value.chars().any(|character| {
        matches!(
            character,
            ' ' | '\t' | '&' | '(' | ')' | '[' | ']' | '{' | '}' | '^' | '=' | ';' | '!' | '\'' | '+' | ',' | '`' | '~'
        )
    });

    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\""))
    } else {
        value.to_string()
    }
}

fn build_wrapper_command(executable: &Path, arguments: &[String]) -> String {
    let mut parts = Vec::with_capacity(arguments.len() + 2);
    parts.push(quote_cmd_argument(&executable.to_string_lossy()));
    parts.extend(arguments.iter().map(|value| quote_cmd_argument(value)));
    parts.push("%*".to_string());
    parts.join(" ")
}

fn ensure_wrapper_script(path: &Path, command_line: &str) -> GitResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            GitServiceError::GitCommandFailed(format!(
                "Failed to create runtime directory '{}': {}",
                parent.display(),
                error
            ))
        })?;
    }

    let script = format!("@echo off\r\nsetlocal\r\n{command_line}\r\n");
    fs::write(path, script).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to write SSH wrapper '{}': {}",
            path.display(),
            error
        ))
    })
}

fn ensure_ssh_askpass_script() -> GitResult<PathBuf> {
    let path = resolve_runtime_support_dir().join("ssh-askpass.cmd");
    let command_line = r#"powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::Out.Write($env:UNIGIT_SSH_PASSWORD)""#;
    ensure_wrapper_script(&path, command_line)?;
    Ok(path)
}

fn infer_ssh_client_mode(settings: &RepositorySshSettings) -> &'static str {
    match settings.mode.as_str() {
        "openssh" => "openssh",
        "putty" => "putty",
        _ => {
            if settings
                .private_key_path
                .as_deref()
                .and_then(|value| Path::new(value).extension().and_then(|ext| ext.to_str()))
                .is_some_and(|value| value.eq_ignore_ascii_case("ppk"))
            {
                "putty"
            } else {
                "openssh"
            }
        }
    }
}

fn build_git_remote_environment(repo_path: &Path) -> GitResult<Option<GitRemoteEnvironment>> {
    let settings = load_repository_ssh_settings(repo_path)?;
    let has_overrides = settings.private_key_path.is_some() || settings.username.is_some() || settings.password.is_some();

    if settings.mode == "auto" && !has_overrides {
        return Ok(None);
    }

    let client_mode = infer_ssh_client_mode(&settings);
    let runtime_dir = resolve_runtime_support_dir();
    let repo_key = normalize_repository_settings_key(repo_path);
    let repo_hash = format!("{:016x}", seahash_like(&repo_key));
    let mut env_pairs = vec![("GIT_TERMINAL_PROMPT".to_string(), "0".to_string())];

    if client_mode == "putty" {
        let executable = find_executable_path(
            "plink.exe",
            &[
                PathBuf::from(r"C:\Program Files\PuTTY\plink.exe"),
                PathBuf::from(r"C:\Program Files (x86)\PuTTY\plink.exe"),
            ],
        )
        .ok_or_else(|| GitServiceError::GitCommandFailed("PuTTY plink.exe was not found on PATH or in the default install locations.".to_string()))?;

        let mut arguments = vec!["-batch".to_string(), "-agent".to_string()];

        if let Some(username) = settings.username.as_deref() {
            arguments.push("-l".to_string());
            arguments.push(username.to_string());
        }

        if let Some(key_path) = settings.private_key_path.as_deref() {
            arguments.push("-i".to_string());
            arguments.push(expand_home_prefix(key_path).to_string_lossy().into_owned());
        }

        if settings.password.is_some() {
            arguments.push("-pw".to_string());
            arguments.push("%UNIGIT_SSH_PASSWORD%".to_string());
            env_pairs.push((
                "UNIGIT_SSH_PASSWORD".to_string(),
                settings.password.clone().unwrap_or_default(),
            ));
        }

        let wrapper_path = runtime_dir.join(format!("plink-{repo_hash}.cmd"));
        ensure_wrapper_script(&wrapper_path, &build_wrapper_command(&executable, &arguments))?;

        env_pairs.push(("GIT_SSH".to_string(), wrapper_path.to_string_lossy().into_owned()));
        env_pairs.push(("GIT_SSH_VARIANT".to_string(), "plink".to_string()));

        return Ok(Some(GitRemoteEnvironment {
            env_pairs,
            log_detail: Some(format!(
                "sshMode=putty config={} key={} user={}",
                settings.use_user_ssh_config,
                settings.private_key_path.as_deref().unwrap_or("<default>"),
                settings.username.as_deref().unwrap_or("<default>")
            )),
        }));
    }

    let executable = find_executable_path("ssh.exe", &[PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe")])
        .ok_or_else(|| GitServiceError::GitCommandFailed("OpenSSH ssh.exe was not found on PATH or in C:\\Windows\\System32\\OpenSSH.".to_string()))?;
    let mut arguments = Vec::new();

    if settings.use_user_ssh_config {
        let config_path = dirs_next::home_dir().map(|path| path.join(".ssh").join("config"));
        if let Some(path) = config_path.filter(|path| path.is_file()) {
            arguments.push("-F".to_string());
            arguments.push(path.to_string_lossy().into_owned());
        }
    }

    if let Some(username) = settings.username.as_deref() {
        arguments.push("-o".to_string());
        arguments.push(format!("User={username}"));
    }

    if let Some(key_path) = settings.private_key_path.as_deref() {
        arguments.push("-i".to_string());
        arguments.push(expand_home_prefix(key_path).to_string_lossy().into_owned());
        arguments.push("-o".to_string());
        arguments.push("IdentitiesOnly=yes".to_string());
    }

    if settings.password.is_some() {
        let askpass_path = ensure_ssh_askpass_script()?;
        env_pairs.push(("SSH_ASKPASS".to_string(), askpass_path.to_string_lossy().into_owned()));
        env_pairs.push(("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()));
        env_pairs.push((
            "UNIGIT_SSH_PASSWORD".to_string(),
            settings.password.clone().unwrap_or_default(),
        ));
    } else {
        arguments.push("-o".to_string());
        arguments.push("BatchMode=yes".to_string());
    }

    let wrapper_path = runtime_dir.join(format!("openssh-{repo_hash}.cmd"));
    ensure_wrapper_script(&wrapper_path, &build_wrapper_command(&executable, &arguments))?;
    env_pairs.push(("GIT_SSH".to_string(), wrapper_path.to_string_lossy().into_owned()));

    Ok(Some(GitRemoteEnvironment {
        env_pairs,
        log_detail: Some(format!(
            "sshMode=openssh config={} key={} user={}",
            settings.use_user_ssh_config,
            settings.private_key_path.as_deref().unwrap_or("<default>"),
            settings.username.as_deref().unwrap_or("<default>")
        )),
    }))
}

fn seahash_like(value: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

async fn list_commit_history_inner(repo_path: String, limit: usize) -> GitResult<Vec<CommitSummary>> {
    let path = validate_repository_path(&repo_path)?;
    let format = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D";
    let log_output = run_git(
        path,
        [
            "log",
            &format!("--max-count={limit}"),
            "--date=iso-strict",
            &format!("--pretty=format:{format}"),
        ],
    )
    .await?;

    let commits = log_output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            let hash = parts.next()?.to_string();
            let short_hash = parts.next()?.to_string();
            let author_name = parts.next()?.to_string();
            let authored_at = parts.next()?.to_string();
            let subject = parts.next()?.to_string();
            let decorations = parts.next().unwrap_or_default().to_string();

            Some(CommitSummary {
                hash,
                short_hash,
                author_name,
                authored_at,
                subject,
                decorations,
            })
        })
        .collect();

    Ok(commits)
}

async fn list_file_history_inner(repo_path: String, relative_path: String, limit: usize) -> GitResult<Vec<FileHistoryEntry>> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_path = relative_path.trim();
    let max_count = limit.clamp(1, 100);

    if trimmed_path.is_empty() {
        return Err(GitServiceError::InvalidFileSelection);
    }

    let format = "%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%D";
    let output = run_git_owned(
        path,
        vec![
            "log".into(),
            format!("--max-count={max_count}"),
            "--follow".into(),
            "--date=iso-strict".into(),
            format!("--pretty=format:{format}"),
            "--".into(),
            trimmed_path.to_string(),
        ],
    )
    .await?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\u{1f}');
            Some(FileHistoryEntry {
                hash: parts.next()?.to_string(),
                short_hash: parts.next()?.to_string(),
                author_name: parts.next()?.to_string(),
                authored_at: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                decorations: parts.next().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

async fn list_branches_inner(repo_path: String) -> GitResult<Vec<BranchEntry>> {
    let path = validate_repository_path(&repo_path)?;
    let output = run_git_owned(
        path,
        vec![
            "for-each-ref".into(),
            "--sort=-committerdate".into(),
            "--format=%(refname)	%(refname:short)	%(objectname:short)	%(subject)	%(upstream:short)	%(upstream:trackshort)	%(HEAD)".into(),
            "refs/heads".into(),
            "refs/remotes".into(),
        ],
    )
    .await?;

    Ok(output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let full_name = parts.next()?.to_string();
            let name = parts.next()?.to_string();

            if full_name.ends_with("/HEAD") {
                return None;
            }

            let commit_hash = parts.next().unwrap_or_default().to_string();
            let subject = parts.next().unwrap_or_default().to_string();
            let tracking_name = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let tracking_state = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let is_current = parts.next().unwrap_or_default().trim() == "*";

            let (branch_kind, remote_name) = if let Some(rest) = full_name.strip_prefix("refs/remotes/") {
                let remote = rest.split('/').next().map(ToString::to_string);
                ("remote".to_string(), remote)
            } else {
                ("local".to_string(), None)
            };

            Some(BranchEntry {
                full_name,
                name,
                branch_kind,
                remote_name,
                tracking_name,
                tracking_state,
                is_current,
                commit_hash,
                subject,
            })
        })
        .collect())
}

async fn list_commit_graph_inner(repo_path: String, limit: usize, skip: usize) -> GitResult<CommitGraphPage> {
    let path = validate_repository_path(&repo_path)?;
    let page_limit = limit.clamp(40, 2_000);
    let format = "%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D";
    let log_output = run_git(
        path,
        [
            "log",
            "--date-order",
            &format!("--max-count={}", page_limit + 1),
            &format!("--skip={skip}"),
            "--date=iso-strict",
            &format!("--pretty=format:{format}"),
        ],
    )
    .await?;

    let mut parsed_rows = Vec::new();

    for line in log_output.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = line.split('\u{1f}');
        let hash = match parts.next() {
            Some(value) => value.to_string(),
            None => continue,
        };

        let short_hash = parts.next().unwrap_or_default().to_string();
        let parent_hashes = parts
            .next()
            .unwrap_or_default()
            .split_whitespace()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let author_name = parts.next().unwrap_or_default().to_string();
        let authored_at = parts.next().unwrap_or_default().to_string();
        let subject = parts.next().unwrap_or_default().to_string();
        let decorations = parts.next().unwrap_or_default().to_string();

        parsed_rows.push((
            hash,
            short_hash,
            parent_hashes,
            author_name,
            authored_at,
            subject,
            decorations,
        ));
    }

    let has_more = parsed_rows.len() > page_limit;

    if has_more {
        parsed_rows.truncate(page_limit);
    }

    let branch_labels = resolve_branch_labels(path, &parsed_rows).await?;

    let mut active_lanes: Vec<Option<String>> = Vec::new();
    let mut rows = Vec::with_capacity(parsed_rows.len());

    for (hash, short_hash, parent_hashes, author_name, authored_at, subject, decorations) in parsed_rows {
        let display_branch = branch_labels
            .get(&hash)
            .cloned()
            .unwrap_or_else(|| branch_label_from_decorations(&decorations));
        let lane = if let Some(index) = active_lanes
            .iter()
            .position(|entry| entry.as_deref() == Some(hash.as_str()))
        {
            index
        } else if let Some(index) = active_lanes.iter().position(Option::is_none) {
            active_lanes[index] = Some(hash.clone());
            index
        } else {
            active_lanes.push(Some(hash.clone()));
            active_lanes.len() - 1
        };

        let active_lane_set = active_lanes
            .iter()
            .enumerate()
            .filter_map(|(index, value)| value.as_ref().map(|_| index))
            .collect::<Vec<_>>();

        if let Some(first_parent) = parent_hashes.first() {
            active_lanes[lane] = Some(first_parent.clone());
        } else {
            active_lanes[lane] = None;
        }

        for parent in parent_hashes.iter().skip(1) {
            if active_lanes.iter().any(|entry| entry.as_deref() == Some(parent.as_str())) {
                continue;
            }

            if let Some(index) = active_lanes.iter().position(Option::is_none) {
                active_lanes[index] = Some(parent.clone());
            } else {
                active_lanes.push(Some(parent.clone()));
            }
        }

        while active_lanes.last().is_some_and(Option::is_none) {
            active_lanes.pop();
        }

        rows.push(CommitGraphRow {
            hash,
            short_hash,
            parent_hashes: parent_hashes.clone(),
            display_branch,
            author_name,
            authored_at,
            subject,
            decorations,
            lane,
            active_lanes: active_lane_set,
            merge_commit: parent_hashes.len() > 1,
        });
    }

    Ok(CommitGraphPage {
        next_skip: skip + rows.len(),
        has_more,
        rows,
    })
}

fn branch_label_from_decorations(decorations: &str) -> String {
    for ref_name in decorations
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let cleaned = ref_name
            .strip_prefix("HEAD -> ")
            .unwrap_or(ref_name)
            .trim();

        if cleaned.starts_with("tag: ") {
            continue;
        }

        if cleaned == "HEAD" {
            continue;
        }

        return cleaned.to_string();
    }

    "history".to_string()
}

async fn resolve_branch_labels(
    repo_root: &Path,
    parsed_rows: &[(String, String, Vec<String>, String, String, String, String)],
) -> GitResult<std::collections::HashMap<String, String>> {
    use std::collections::HashMap;

    if parsed_rows.is_empty() {
        return Ok(HashMap::new());
    }

    let mut args = vec![
        "name-rev".to_string(),
        "--name-only".to_string(),
        "--refs=refs/heads/*".to_string(),
    ];

    args.extend(parsed_rows.iter().map(|row| row.0.clone()));

    let output = run_git_owned(repo_root, args).await?;
    let mut labels = HashMap::new();

    for ((hash, _, _, _, _, _, decorations), raw_label) in parsed_rows.iter().zip(output.lines()) {
        let label = sanitize_branch_label(raw_label)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| branch_label_from_decorations(decorations));
        labels.insert(hash.clone(), label);
    }

    Ok(labels)
}

fn sanitize_branch_label(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if trimmed.is_empty() || trimmed == "undefined" {
        return None;
    }

    let normalized = trimmed
        .strip_prefix("remotes/")
        .unwrap_or(trimmed)
        .replace("refs/heads/", "")
        .replace("refs/remotes/", "");

    Some(normalized)
}

async fn inspect_file_preview_inner(repo_path: String, relative_path: String) -> GitResult<FilePreview> {
    let repo_root = validate_repository_path(&repo_path)?;
    let resolved_path = resolve_repo_file(repo_root, &relative_path)?;
    let metadata = fs::metadata(&resolved_path)
        .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;

    if !metadata.is_file() {
        return Err(GitServiceError::InvalidFileSelection);
    }

    let extension = resolved_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_name = resolved_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_secs());
    let file_size_bytes = metadata.len();
    let mime_type = infer_mime_type(&extension);
    let mut image_data_url = None;
    let mut text_excerpt = None;
    let mut staged_diff = None;
    let mut unstaged_diff = None;
    let mut asset_summary = None;
    let mut image_sources = Vec::new();
    let mut image_comparison_presets = Vec::new();
    let mut default_image_comparison_preset_key = None;
    let mut unity_material_sources = Vec::new();
    let mut unity_material_comparison_presets = Vec::new();
    let mut default_unity_material_comparison_preset_key = None;
    let mut model_sources = Vec::new();
    let mut model_comparison_presets = Vec::new();
    let mut default_model_comparison_preset_key = None;

    let preview_kind = if extension == "mat" {
        let bytes = fs::read(&resolved_path)
            .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
        let preview_bytes = &bytes[..bytes.len().min(12_000)];
        text_excerpt = Some(String::from_utf8_lossy(preview_bytes).to_string());
        unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
        staged_diff = git_diff(repo_root, &relative_path, true).await?;
        unity_material_sources = collect_unity_material_preview_sources(repo_root, &resolved_path, &relative_path).await?;
        unity_material_comparison_presets = build_image_comparison_presets(
            &unity_material_sources
                .iter()
                .map(|source| ImagePreviewSource {
                    key: source.key.clone(),
                    label: source.label.clone(),
                    source_kind: source.source_kind.clone(),
                    mime_type: "application/x-unity-material".to_string(),
                    byte_size: 0,
                    encoded_bytes_base64: String::new(),
                    is_psd: false,
                })
                .collect::<Vec<_>>(),
            staged_diff.is_some(),
            unstaged_diff.is_some(),
        );
        default_unity_material_comparison_preset_key = unity_material_comparison_presets.first().map(|preset| preset.key.clone());
        asset_summary = unity_material_sources.first().map(build_unity_material_asset_summary);
        if unity_material_sources.is_empty() { "text" } else { "material" }
    } else if is_previewable_model_extension(&extension) {
        unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
        staged_diff = git_diff(repo_root, &relative_path, true).await?;
        model_sources = collect_model_preview_sources(repo_root, &resolved_path, &relative_path, &extension, mime_type).await?;
        model_comparison_presets = build_image_comparison_presets(
            &model_sources
                .iter()
                .map(|source| ImagePreviewSource {
                    key: source.key.clone(),
                    label: source.label.clone(),
                    source_kind: source.source_kind.clone(),
                    mime_type: source.mime_type.clone(),
                    byte_size: 0,
                    encoded_bytes_base64: String::new(),
                    is_psd: false,
                })
                .collect::<Vec<_>>(),
            staged_diff.is_some(),
            unstaged_diff.is_some(),
        );
        default_model_comparison_preset_key = model_comparison_presets.first().map(|preset| preset.key.clone());
        asset_summary = build_asset_summary(&resolved_path, &extension)?;

        if model_sources.is_empty() {
            "asset"
        } else {
            "model"
        }
    } else if is_previewable_image_extension(&extension) {
        if file_size_bytes <= MAX_INLINE_IMAGE_BYTES {
            let bytes = fs::read(&resolved_path)
                .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            image_data_url = Some(format!("data:{mime_type};base64,{}", BASE64.encode(bytes)));
        }

        unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
        staged_diff = git_diff(repo_root, &relative_path, true).await?;

        if extension == "psd" {
            asset_summary = build_asset_summary(&resolved_path, &extension)?;
        }

        image_sources = collect_image_preview_sources(repo_root, &resolved_path, &relative_path, &extension, mime_type).await?;
        image_comparison_presets = build_image_comparison_presets(&image_sources, staged_diff.is_some(), unstaged_diff.is_some());
        default_image_comparison_preset_key = image_comparison_presets.first().map(|preset| preset.key.clone());

        "image"
    } else if is_text_extension(&extension) || looks_like_text(&resolved_path)? {
        let bytes = fs::read(&resolved_path)
            .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
        let preview_bytes = &bytes[..bytes.len().min(12_000)];
        text_excerpt = Some(String::from_utf8_lossy(preview_bytes).to_string());
        unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
        staged_diff = git_diff(repo_root, &relative_path, true).await?;
        "text"
    } else if is_known_asset_extension(&extension) {
        asset_summary = build_asset_summary(&resolved_path, &extension)?;
        "asset"
    } else {
        "binary"
    }
    .to_string();

    let support_hint = match preview_kind.as_str() {
        "image" if extension == "psd" && !image_sources.is_empty() => "PSD preview, channel inspection, and compare views are active in this slice.".to_string(),
        "image" if !image_sources.is_empty() => "Image preview, channel inspection, and compare views are active in this slice.".to_string(),
        "image" => "Image preview is recognized, but available sources are too large for inline transfer in the current slice.".to_string(),
        "material" if !unity_material_sources.is_empty() => "Unity material preview, compare view, and mesh controls are active in this slice.".to_string(),
        "model" if !model_sources.is_empty() => "3D model preview, compare view, and orbit controls are active in this slice.".to_string(),
        "text" => "Inline text preview is active for quick inspection.".to_string(),
        "asset" => "Asset preview foundation is live. Deep PSD, FBX, and GLTF rendering is the next worker-backed slice.".to_string(),
        _ => "Binary preview is not decoded yet. Metadata is shown while the dedicated pipeline is built.".to_string(),
    };

    Ok(FilePreview {
        relative_path,
        file_name,
        extension,
        preview_kind,
        mime_type: mime_type.to_string(),
        file_size_bytes,
        modified_at,
        image_data_url,
        text_excerpt,
        staged_diff,
        unstaged_diff,
        asset_summary,
        image_sources,
        image_comparison_presets,
        default_image_comparison_preset_key,
        unity_material_sources,
        unity_material_comparison_presets,
        default_unity_material_comparison_preset_key,
        model_sources,
        model_comparison_presets,
        default_model_comparison_preset_key,
        support_hint,
    })
}

async fn inspect_commit_detail_inner(repo_path: String, commit_hash: String) -> GitResult<CommitDetail> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_hash = commit_hash.trim();

    if trimmed_hash.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Commit hash cannot be empty.".to_string()));
    }

    let metadata_format = "%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%s%x1f%b%x1f%D";
    let metadata_output = run_git(
        path,
        [
            "show",
            "--no-patch",
            "--date=iso-strict",
            &format!("--format={metadata_format}"),
            trimmed_hash,
        ],
    )
    .await?;

    let metadata_line = metadata_output.lines().next().unwrap_or_default();
    let mut parts = metadata_line.split('\u{1f}');
    let hash = parts.next().unwrap_or_default().to_string();
    let short_hash = parts.next().unwrap_or_default().to_string();
    let parent_hashes = parts
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let author_name = parts.next().unwrap_or_default().to_string();
    let author_email = parts.next().unwrap_or_default().to_string();
    let authored_at = parts.next().unwrap_or_default().to_string();
    let committer_name = parts.next().unwrap_or_default().to_string();
    let committed_at = parts.next().unwrap_or_default().to_string();
    let subject = parts.next().unwrap_or_default().to_string();
    let body = parts.next().unwrap_or_default().trim().to_string();
    let decorations = parts.next().unwrap_or_default().to_string();

    let status_output = run_git_owned(
        path,
        vec![
            "show".into(),
            "--format=".into(),
            "--first-parent".into(),
            "--find-renames".into(),
            "--name-status".into(),
            trimmed_hash.to_string(),
        ],
    )
    .await?;

    let numstat_output = run_git_owned(
        path,
        vec![
            "show".into(),
            "--format=".into(),
            "--first-parent".into(),
            "--find-renames".into(),
            "--numstat".into(),
            trimmed_hash.to_string(),
        ],
    )
    .await?;

    let mut stat_map = std::collections::HashMap::<String, (Option<usize>, Option<usize>)>::new();

    for line in numstat_output.lines().filter(|line| !line.trim().is_empty()) {
        let segments = line.split('\t').collect::<Vec<_>>();

        if segments.len() < 3 {
            continue;
        }

        let path = segments.last().unwrap_or(&"").to_string();
        let additions = if segments[0] == "-" { None } else { segments[0].parse().ok() };
        let deletions = if segments[1] == "-" { None } else { segments[1].parse().ok() };
        stat_map.insert(path, (additions, deletions));
    }

    let files = status_output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let segments = line.split('\t').collect::<Vec<_>>();
            let status = segments.first().copied().unwrap_or("M").to_string();
            let path = segments.last().copied().unwrap_or_default().to_string();
            let (additions, deletions) = stat_map.remove(&path).unwrap_or((None, None));

            CommitFileEntry {
                path,
                status,
                additions,
                deletions,
            }
        })
        .collect::<Vec<_>>();

    Ok(CommitDetail {
        hash,
        short_hash,
        parent_hashes,
        author_name,
        author_email,
        authored_at,
        committer_name,
        committed_at,
        subject,
        body,
        decorations,
        files,
    })
}

async fn inspect_commit_message_context_inner(repo_path: String) -> GitResult<CommitMessageContext> {
    let path = validate_repository_path(&repo_path)?;
    let current_branch = current_local_branch_name(path).await.unwrap_or_else(|_| "HEAD".to_string());

    let staged_files_output = run_git_owned(
        path,
        vec!["diff".into(), "--cached".into(), "--name-only".into()],
    )
    .await?;
    let staged_files = staged_files_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    let staged_numstat_output = run_git_owned(
        path,
        vec!["diff".into(), "--cached".into(), "--no-ext-diff".into(), "--numstat".into()],
    )
    .await?;
    let staged_numstat = parse_numstat_map(&staged_numstat_output);

    let diffable_staged_files = staged_files
        .iter()
        .filter(|relative_path| is_ai_commit_diffable_path(relative_path, staged_numstat.get((*relative_path).as_str()).copied()))
        .cloned()
        .collect::<Vec<_>>();
    let omitted_staged_files = staged_files
        .iter()
        .filter(|relative_path| !is_ai_commit_diffable_path(relative_path, staged_numstat.get((*relative_path).as_str()).copied()))
        .cloned()
        .collect::<Vec<_>>();

    let staged_diff_raw = if diffable_staged_files.is_empty() {
        String::new()
    } else {
        let mut args = vec![
            "diff".into(),
            "--cached".into(),
            "--no-ext-diff".into(),
            "--unified=2".into(),
            "--".into(),
        ];
        args.extend(diffable_staged_files.iter().cloned());
        run_git_owned(path, args).await?
    };
    let staged_diff = truncate_commit_message_diff(format_commit_message_diff_context(
        &diffable_staged_files,
        &omitted_staged_files,
        staged_diff_raw,
    ));

    let unpushed_commits = list_unpushed_commit_summaries(path).await?;

    Ok(CommitMessageContext {
        current_branch,
        staged_files,
        staged_diff,
        unpushed_commits,
    })
}

async fn export_file_from_commit_inner(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
    destination_path: String,
) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_hash = commit_hash.trim();
    let destination = PathBuf::from(destination_path.trim());

    if trimmed_hash.is_empty() || relative_path.trim().is_empty() || destination.as_os_str().is_empty() {
        return Err(GitServiceError::InvalidFileSelection);
    }

    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
    }

    let git_object = format!("{}:{}", trimmed_hash, relative_path);
    let bytes = run_git_bytes_owned(path, vec!["show".into(), git_object]).await?;

    fs::write(destination, bytes)
        .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;

    Ok(())
}

async fn restore_file_from_commit_inner(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_hash = commit_hash.trim();
    let trimmed_path = relative_path.trim();

    if trimmed_hash.is_empty() || trimmed_path.is_empty() {
        return Err(GitServiceError::InvalidFileSelection);
    }

    run_git_owned(
        path,
        vec![
            "restore".into(),
            format!("--source={trimmed_hash}"),
            "--worktree".into(),
            "--".into(),
            trimmed_path.to_string(),
        ],
    )
    .await
    .map(|_| ())
}

async fn apply_commit_file_patch_inner(
    repo_path: String,
    commit_hash: String,
    relative_path: String,
    reverse: bool,
) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed_hash = commit_hash.trim();
    let trimmed_path = relative_path.trim();

    if trimmed_hash.is_empty() || trimmed_path.is_empty() {
        return Err(GitServiceError::InvalidFileSelection);
    }

    let parents_output = run_git_owned(
        path,
        vec!["show".into(), "--no-patch".into(), "--format=%P".into(), trimmed_hash.to_string()],
    )
    .await?;
    let first_parent = parents_output.split_whitespace().next().map(ToString::to_string);
    let base = first_parent.unwrap_or_else(|| "4b825dc642cb6eb9a060e54bf8d69288fbee4904".to_string());

    let patch = run_git_bytes_owned(
        path,
        vec![
            "diff".into(),
            "--binary".into(),
            base,
            trimmed_hash.to_string(),
            "--".into(),
            trimmed_path.to_string(),
        ],
    )
    .await?;

    if patch.is_empty() {
        return Ok(());
    }

    let mut args = vec![
        "apply".into(),
        "--3way".into(),
        "--reject".into(),
        "--whitespace=nowarn".into(),
    ];

    if reverse {
        args.push("--reverse".into());
    }

    run_git_owned_with_input(path, args, patch).await.map(|_| ())
}

async fn apply_path_operation(repo_path: String, paths: Vec<String>, unstage: bool) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;

    if paths.is_empty() {
        return Ok(());
    }

    let mut args: Vec<String> = if unstage {
        vec!["reset".into(), "HEAD".into(), "--".into()]
    } else {
        vec!["add".into(), "--".into()]
    };

    args.extend(paths);

    run_git_owned(path, args).await.map(|_| ())
}

async fn discard_paths_inner(repo_path: String, paths: Vec<String>) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let normalized_paths = sanitize_path_list(paths);

    if normalized_paths.is_empty() {
        return Ok(());
    }

    let untracked_output = run_git_owned(
        path,
        {
            let mut args = vec!["ls-files".into(), "--others".into(), "--exclude-standard".into(), "--".into()];
            args.extend(normalized_paths.iter().cloned());
            args
        },
    )
    .await?;

    let untracked_paths = untracked_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect::<std::collections::HashSet<_>>();

    let tracked_paths = normalized_paths
        .iter()
        .filter(|path_value| !untracked_paths.contains(path_value.as_str()))
        .cloned()
        .collect::<Vec<_>>();

    if !tracked_paths.is_empty() {
        let mut restore_args = vec![
            "restore".into(),
            "--source=HEAD".into(),
            "--staged".into(),
            "--worktree".into(),
            "--".into(),
        ];
        restore_args.extend(tracked_paths);
        run_git_owned(path, restore_args).await?;
    }

    if !untracked_paths.is_empty() {
        let mut clean_args = vec!["clean".into(), "-fd".into(), "--".into()];
        clean_args.extend(untracked_paths.into_iter());
        run_git_owned(path, clean_args).await?;
    }

    Ok(())
}

async fn add_paths_to_gitignore_inner(repo_path: String, paths: Vec<String>) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let normalized_paths = sanitize_path_list(paths);

    if normalized_paths.is_empty() {
        return Ok(());
    }

    let gitignore_path = path.join(".gitignore");
    let existing = fs::read_to_string(&gitignore_path).unwrap_or_default();
    let mut lines = existing.lines().map(ToString::to_string).collect::<Vec<_>>();
    let mut existing_set = lines
        .iter()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect::<std::collections::HashSet<_>>();

    for path_value in normalized_paths {
        if !existing_set.contains(path_value.as_str()) {
            existing_set.insert(path_value.clone());
            lines.push(path_value);
        }
    }

    let mut next = lines.join("\n");
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }

    fs::write(gitignore_path, next)
        .map_err(|error| GitServiceError::GitCommandFailed(error.to_string()))?;

    Ok(())
}

async fn switch_branch_inner(repo_path: String, full_name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    switch_branch_to_target(path, full_name.trim(), false).await
}

async fn force_switch_branch_inner(repo_path: String, full_name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    switch_branch_to_target(path, full_name.trim(), true).await
}

async fn create_branch_inner(repo_path: String, name: String, start_point: Option<String>, discard_changes: bool) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let branch_name = name.trim();

    if branch_name.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Branch name cannot be empty.".to_string()));
    }

    if discard_changes {
        discard_all_local_state(path).await?;
    }

    let preferred_remote = infer_branch_creation_remote(path, start_point.as_deref()).await?;

    let mut args = vec!["switch".into(), "-c".into(), branch_name.to_string()];

    if let Some(start) = start_point.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        args.push(resolve_branch_specifier(start)?);
    }

    run_git_owned(path, args).await?;

    let mut result = if let Some(start) = start_point.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        format!("Created branch {branch_name} from {} and switched to it.", pretty_branch_label(start))
    } else {
        format!("Created branch {branch_name} and switched to it.")
    };

    if let Some(remote_name) = preferred_remote {
        match push_branch_with_upstream(path, &remote_name, branch_name).await {
            Ok(message) => {
                result.push(' ');
                result.push_str(&message);
            }
            Err(error) => {
                result.push_str(&format!(" Local branch creation succeeded, but automatic remote publish failed: {error}"));
            }
        }
    }

    Ok(result)
}

async fn switch_branch_to_target(repo_path: &Path, full_name: &str, force: bool) -> GitResult<String> {
    let trimmed = full_name.trim();

    if force {
        discard_all_local_state(repo_path).await?;
    }

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        run_git_owned(repo_path, vec!["switch".into(), local_name.to_string()]).await?;
        return Ok(format!("Switched to {local_name}."));
    }

    if let Some(remote_branch) = trimmed.strip_prefix("refs/remotes/") {
        let mut segments = remote_branch.split('/');
        let remote_name = segments.next().unwrap_or_default();
        let branch_name = segments.collect::<Vec<_>>().join("/");

        if remote_name.is_empty() || branch_name.is_empty() {
            return Err(GitServiceError::GitCommandFailed("Remote branch is malformed.".to_string()));
        }

        let local_exists = !run_git_owned(repo_path, vec!["branch".into(), "--list".into(), branch_name.clone()])
            .await?
            .trim()
            .is_empty();

        if local_exists {
            run_git_owned(repo_path, vec!["switch".into(), branch_name.clone()]).await?;
        } else {
            run_git_owned(
                repo_path,
                vec![
                    "switch".into(),
                    "--track".into(),
                    "-c".into(),
                    branch_name.clone(),
                    format!("{remote_name}/{branch_name}"),
                ],
            )
            .await?;
        }

        return Ok(format!("Switched to {branch_name}."));
    }

    Err(GitServiceError::GitCommandFailed("Unsupported branch reference.".to_string()))
}

async fn rename_branch_inner(repo_path: String, current_name: String, next_name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let current_trimmed = current_name.trim();
    let next_trimmed = next_name.trim();

    if next_trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("New branch name cannot be empty.".to_string()));
    }

    let local_name = current_trimmed
        .strip_prefix("refs/heads/")
        .ok_or_else(|| GitServiceError::GitCommandFailed("Only local branches can be renamed right now.".to_string()))?;

    let upstream_before_rename = run_git_owned(
        path,
        vec![
            "for-each-ref".into(),
            "--format=%(upstream:short)".into(),
            format!("refs/heads/{local_name}"),
        ],
    )
    .await?
    .trim()
    .to_string();

    run_git_owned(
        path,
        vec!["branch".into(), "-m".into(), local_name.to_string(), next_trimmed.to_string()],
    )
    .await?;

    let mut result = format!("Renamed {local_name} to {next_trimmed}.");

    if !upstream_before_rename.is_empty() {
        let mut segments = upstream_before_rename.split('/');
        let remote_name = segments.next().unwrap_or_default();
        let remote_branch = segments.collect::<Vec<_>>().join("/");

        if !remote_name.is_empty() && !remote_branch.is_empty() {
            let remote_sync_result = async {
                run_git_remote_owned(
                    path,
                    vec![
                        "push".into(),
                        remote_name.to_string(),
                        format!("refs/heads/{next_trimmed}:refs/heads/{next_trimmed}"),
                    ],
                )
                .await?;

                let _ = run_git_remote_owned(
                    path,
                    vec!["push".into(), remote_name.to_string(), "--delete".into(), remote_branch.clone()],
                )
                .await;

                run_git_owned(
                    path,
                    vec![
                        "branch".into(),
                        "--set-upstream-to".into(),
                        format!("{remote_name}/{next_trimmed}"),
                        next_trimmed.to_string(),
                    ],
                )
                .await?;

                Ok::<(), GitServiceError>(())
            }
            .await;

            match remote_sync_result {
                Ok(()) => {
                    result.push_str(&format!(" Updated remote branch on {remote_name} as well."));
                }
                Err(error) => {
                    result.push_str(&format!(" Local rename succeeded, but remote rename sync failed: {error}"));
                }
            }
        }
    }

    Ok(result)
}

async fn delete_branch_inner(repo_path: String, full_name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed = full_name.trim();

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        run_git_owned(path, vec!["branch".into(), "-D".into(), local_name.to_string()]).await?;
        return Ok(format!("Deleted local branch {local_name}."));
    }

    if let Some(remote_branch) = trimmed.strip_prefix("refs/remotes/") {
        let mut segments = remote_branch.split('/');
        let remote_name = segments.next().unwrap_or_default();
        let branch_name = segments.collect::<Vec<_>>().join("/");

        if remote_name.is_empty() || branch_name.is_empty() {
            return Err(GitServiceError::GitCommandFailed("Remote branch is malformed.".to_string()));
        }

        run_git_remote_owned(
            path,
            vec!["push".into(), remote_name.to_string(), "--delete".into(), branch_name.clone()],
        )
        .await?;

        return Ok(format!("Deleted remote branch {remote_name}/{branch_name}."));
    }

    Err(GitServiceError::GitCommandFailed("Unsupported branch reference.".to_string()))
}

async fn merge_branch_inner(repo_path: String, full_name: String, discard_local_changes: bool) -> GitResult<MergeBranchResult> {
    let path = validate_repository_path(&repo_path)?;
    let target = resolve_branch_specifier(full_name.trim())?;
    let target_label = pretty_branch_label(full_name.trim());

    if discard_local_changes {
        discard_all_local_state(path).await?;
    }

    let output = run_git_capture_owned(path, vec!["merge".into(), "--no-edit".into(), target.clone()]).await?;
    let detail = combine_command_output(&output.stdout, &output.stderr);

    if output.success {
        return Ok(MergeBranchResult {
            status: "merged".to_string(),
            message: if detail.is_empty() {
                format!("Merged {target_label} into the current branch.")
            } else {
                detail
            },
            conflicted_files: Vec::new(),
        });
    }

    if !discard_local_changes && is_local_change_merge_block(detail.as_str()) {
        return Err(GitServiceError::GitCommandFailed(detail));
    }

    let conflicted_files = list_conflicted_files(path).await?;

    if !conflicted_files.is_empty() {
        return Ok(MergeBranchResult {
            status: "conflicts".to_string(),
            message: if detail.is_empty() {
                format!("Merge with {target_label} produced conflicts.")
            } else {
                detail
            },
            conflicted_files,
        });
    }

    Err(GitServiceError::GitCommandFailed(if detail.is_empty() {
        format!("Merge with {target_label} failed.")
    } else {
        detail
    }))
}

async fn resolve_conflicted_files_inner(repo_path: String, paths: Vec<String>, strategy: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let sanitized_paths = sanitize_path_list(paths);

    if sanitized_paths.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Choose at least one conflicted file to resolve.".to_string()));
    }

    let checkout_flag = match strategy.trim() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => {
            return Err(GitServiceError::GitCommandFailed(
                "Conflict strategy must be either 'ours' or 'theirs'.".to_string(),
            ))
        }
    };

    let mut checkout_args = vec!["checkout".into(), checkout_flag.into(), "--".into()];
    checkout_args.extend(sanitized_paths.iter().cloned());
    run_git_owned(path, checkout_args).await?;

    let mut add_args = vec!["add".into(), "--".into()];
    add_args.extend(sanitized_paths.iter().cloned());
    run_git_owned(path, add_args).await?;

    let remaining = list_conflicted_files(path).await?;

    Ok(format!(
        "Resolved {} conflicted file(s) using {}. Remaining conflicted files: {}.",
        sanitized_paths.len(),
        if checkout_flag == "--ours" { "yours" } else { "theirs" },
        remaining.len()
    ))
}

async fn push_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let output = match run_git_remote_owned(path, vec!["push".into()]).await {
        Ok(output) => output,
        Err(GitServiceError::GitCommandFailed(message)) if is_missing_upstream_error(&message) => {
            let branch_name = current_local_branch_name(path).await?;
            let remote_name = infer_preferred_remote(path).await?
                .ok_or_else(|| GitServiceError::GitCommandFailed(format!(
                    "{message}\n\nUniGit could not infer which remote should track {branch_name}."
                )))?;

            let auto_result = push_branch_with_upstream(path, &remote_name, &branch_name).await?;
            return Ok(format!("{auto_result} Auto-configured upstream after detecting a new local branch without remote tracking."));
        }
        Err(error) => return Err(error),
    };
    let trimmed = output.trim();

    if trimmed.is_empty() {
        Ok("Push completed.".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

async fn infer_branch_creation_remote(repo_path: &Path, start_point: Option<&str>) -> GitResult<Option<String>> {
    if let Some(start) = start_point.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(remote_branch) = start.strip_prefix("refs/remotes/") {
            let remote_name = remote_branch.split('/').next().unwrap_or_default().trim();
            if !remote_name.is_empty() {
                return Ok(Some(remote_name.to_string()));
            }
        }

        if let Some(local_branch) = start.strip_prefix("refs/heads/") {
            if let Some(remote_name) = branch_upstream_remote(repo_path, local_branch).await? {
                return Ok(Some(remote_name));
            }
        }
    }

    infer_preferred_remote(repo_path).await
}

async fn infer_preferred_remote(repo_path: &Path) -> GitResult<Option<String>> {
    if let Ok(branch_name) = current_local_branch_name(repo_path).await {
        if let Some(remote_name) = branch_upstream_remote(repo_path, &branch_name).await? {
            return Ok(Some(remote_name));
        }
    }

    let remotes_output = run_git_owned(repo_path, vec!["remote".into()]).await?;
    let remotes = remotes_output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();

    if remotes.iter().any(|remote| remote == "origin") {
        return Ok(Some("origin".to_string()));
    }

    Ok(remotes.into_iter().next())
}

async fn branch_upstream_remote(repo_path: &Path, branch_name: &str) -> GitResult<Option<String>> {
    let upstream = run_git_owned(
        repo_path,
        vec![
            "for-each-ref".into(),
            "--format=%(upstream:short)".into(),
            format!("refs/heads/{branch_name}"),
        ],
    )
    .await?
    .trim()
    .to_string();

    if upstream.is_empty() {
        return Ok(None);
    }

    let remote_name = upstream.split('/').next().unwrap_or_default().trim();

    if remote_name.is_empty() {
        Ok(None)
    } else {
        Ok(Some(remote_name.to_string()))
    }
}

async fn current_local_branch_name(repo_path: &Path) -> GitResult<String> {
    let branch_name = run_git_owned(repo_path, vec!["branch".into(), "--show-current".into()]).await?
        .trim()
        .to_string();

    if branch_name.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Current HEAD is detached, so no local branch name is available.".to_string()));
    }

    Ok(branch_name)
}

async fn push_branch_with_upstream(repo_path: &Path, remote_name: &str, branch_name: &str) -> GitResult<String> {
    let output = run_git_remote_owned(
        repo_path,
        vec!["push".into(), "--set-upstream".into(), remote_name.to_string(), branch_name.to_string()],
    )
    .await?;

    let trimmed = output.trim();

    if trimmed.is_empty() {
        Ok(format!("Published {branch_name} to {remote_name} and set upstream."))
    } else {
        Ok(format!("Published {branch_name} to {remote_name} and set upstream.\n{trimmed}"))
    }
}

fn is_missing_upstream_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("has no upstream branch") || normalized.contains("no upstream branch")
}

async fn fetch_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let output = run_git_remote_owned(path, vec!["fetch".into(), "--prune".into(), "--tags".into()]).await?;
    let trimmed = output.trim();

    if trimmed.is_empty() {
        Ok("Fetch completed.".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

async fn pull_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let (ahead, behind) = resolve_upstream_divergence(path).await?;
    let output = if ahead > 0 && behind > 0 {
        run_git_remote_owned(path, vec!["pull".into(), "--no-rebase".into()]).await?
    } else {
        run_git_remote_owned(path, vec!["pull".into(), "--ff-only".into()]).await?
    };
    let trimmed = output.trim();

    if trimmed.is_empty() {
        if ahead > 0 && behind > 0 {
            Ok("Pull completed with merge because local and remote history had diverged.".to_string())
        } else {
            Ok("Pull completed.".to_string())
        }
    } else {
        if ahead > 0 && behind > 0 {
            Ok(format!("Pull completed with merge because local and remote history had diverged.\n{trimmed}"))
        } else {
            Ok(trimmed.to_string())
        }
    }
}

async fn force_pull_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let upstream = run_git_owned(
        path,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "--symbolic-full-name".into(), "@{u}".into()],
    )
    .await?
    .trim()
    .to_string();

    if upstream.is_empty() {
        return Err(GitServiceError::GitCommandFailed("No upstream branch is configured for the current branch.".to_string()));
    }

    run_git_remote_owned(path, vec!["fetch".into(), "--prune".into(), "--tags".into()]).await?;
    let overlapping_paths = list_upstream_touched_paths(path, &upstream).await?;

    if !overlapping_paths.is_empty() {
        let mut restore_args = vec![
            "restore".into(),
            "--source=HEAD".into(),
            "--staged".into(),
            "--worktree".into(),
            "--".into(),
        ];
        restore_args.extend(overlapping_paths.iter().cloned());
        run_git_owned(path, restore_args).await?;

        let mut clean_args = vec!["clean".into(), "-fd".into(), "--".into()];
        clean_args.extend(overlapping_paths.iter().cloned());
        run_git_owned(path, clean_args).await?;
    }

    run_git_owned(
        path,
        vec!["merge".into(), "--no-edit".into(), "-X".into(), "theirs".into(), upstream.clone()],
    )
    .await?;

    Ok(format!(
        "Force pull completed from {upstream}. Discarded local state for {} upstream-touched path(s) and kept unrelated local-only changes.",
        overlapping_paths.len()
    ))
}

async fn discard_all_local_state(repo_path: &Path) -> GitResult<()> {
    run_git_owned(repo_path, vec!["reset".into(), "--hard".into(), "HEAD".into()]).await?;
    run_git_owned(repo_path, vec!["clean".into(), "-fd".into()]).await?;
    Ok(())
}

async fn list_conflicted_files(repo_path: &Path) -> GitResult<Vec<String>> {
    let output = run_git_owned(
        repo_path,
        vec!["diff".into(), "--name-only".into(), "--diff-filter=U".into()],
    )
    .await?;

    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

async fn list_unpushed_commit_summaries(repo_path: &Path) -> GitResult<Vec<String>> {
    let maybe_upstream = run_git_owned(
        repo_path,
        vec!["rev-parse".into(), "--abbrev-ref".into(), "--symbolic-full-name".into(), "@{u}".into()],
    )
    .await;

    let output = match maybe_upstream {
        Ok(upstream) if !upstream.trim().is_empty() => run_git_owned(
            repo_path,
            vec![
                "log".into(),
                format!("--max-count={COMMIT_MESSAGE_UPSTREAM_LIMIT}"),
                "--date=short".into(),
                "--pretty=format:%h %ad %s".into(),
                format!("{}..HEAD", upstream.trim()),
            ],
        )
        .await?,
        _ => run_git_owned(
            repo_path,
            vec![
                "log".into(),
                "--max-count=6".into(),
                "--date=short".into(),
                "--pretty=format:%h %ad %s".into(),
                "HEAD".into(),
            ],
        )
        .await?,
    };

    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn truncate_commit_message_diff(diff: String) -> String {
    if diff.len() <= COMMIT_MESSAGE_DIFF_LIMIT {
        return diff;
    }

    format!(
        "{}\n\n[diff truncated by UniGit after {} characters for AI commit message generation]",
        &diff[..COMMIT_MESSAGE_DIFF_LIMIT],
        COMMIT_MESSAGE_DIFF_LIMIT,
    )
}

fn format_commit_message_diff_context(
    diffable_staged_files: &[String],
    omitted_staged_files: &[String],
    staged_diff_raw: String,
) -> String {
    let mut sections = Vec::new();

    sections.push(if diffable_staged_files.is_empty() {
        "Diffable staged files:\n- none".to_string()
    } else {
        format!(
            "Diffable staged files:\n{}",
            diffable_staged_files
                .iter()
                .map(|file| format!("- {file}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    });

    if !omitted_staged_files.is_empty() {
        sections.push(format!(
            "Omitted binary/image files:\n{}",
            omitted_staged_files
                .iter()
                .map(|file| format!("- {file}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    sections.push(if staged_diff_raw.trim().is_empty() {
        "Staged text diff:\n(empty)".to_string()
    } else {
        format!("Staged text diff:\n{}", staged_diff_raw.trim())
    });

    sections.join("\n\n")
}

fn parse_numstat_map(output: &str) -> std::collections::HashMap<String, (Option<usize>, Option<usize>)> {
    let mut stat_map = std::collections::HashMap::new();

    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let segments = line.split('\t').collect::<Vec<_>>();

        if segments.len() < 3 {
            continue;
        }

        let path = segments.last().unwrap_or(&"").to_string();
        let additions = if segments[0] == "-" { None } else { segments[0].parse().ok() };
        let deletions = if segments[1] == "-" { None } else { segments[1].parse().ok() };
        stat_map.insert(path, (additions, deletions));
    }

    stat_map
}

fn is_ai_commit_diffable_path(relative_path: &str, stat: Option<(Option<usize>, Option<usize>)>) -> bool {
    let normalized = relative_path.replace('\\', "/");
    let extension = Path::new(&normalized)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if is_previewable_image_extension(&extension) || is_known_asset_extension(&extension) {
        return false;
    }

    !matches!(stat, Some((None, None)))
}

fn resolve_branch_specifier(full_name: &str) -> GitResult<String> {
    let trimmed = full_name.trim();

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        return Ok(local_name.to_string());
    }

    if let Some(remote_branch) = trimmed.strip_prefix("refs/remotes/") {
        return Ok(remote_branch.to_string());
    }

    if trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Branch reference cannot be empty.".to_string()));
    }

    Ok(trimmed.to_string())
}

fn pretty_branch_label(full_name: &str) -> String {
    if let Some(local_name) = full_name.trim().strip_prefix("refs/heads/") {
        return local_name.to_string();
    }

    if let Some(remote_name) = full_name.trim().strip_prefix("refs/remotes/") {
        return remote_name.to_string();
    }

    full_name.trim().to_string()
}

fn is_local_change_merge_block(message: &str) -> bool {
    let normalized = message.to_lowercase();
    normalized.contains("would be overwritten by merge")
        || normalized.contains("please commit your changes or stash them before you merge")
}

fn combine_command_output(stdout: &str, stderr: &str) -> String {
    let trimmed_stdout = stdout.trim();
    let trimmed_stderr = stderr.trim();

    match (trimmed_stdout.is_empty(), trimmed_stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => trimmed_stdout.to_string(),
        (true, false) => trimmed_stderr.to_string(),
        (false, false) => format!("{trimmed_stdout}\n{trimmed_stderr}"),
    }
}

async fn resolve_upstream_divergence(repo_path: &Path) -> GitResult<(usize, usize)> {
    let output = run_git_owned(
        repo_path,
        vec!["rev-list".into(), "--left-right".into(), "--count".into(), "HEAD...@{u}".into()],
    )
    .await?;
    let mut parts = output.split_whitespace();
    let ahead = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    let behind = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    Ok((ahead, behind))
}

async fn list_upstream_touched_paths(repo_path: &Path, upstream: &str) -> GitResult<Vec<String>> {
    let merge_base = run_git_owned(
        repo_path,
        vec!["merge-base".into(), "HEAD".into(), upstream.to_string()],
    )
    .await?
    .trim()
    .to_string();

    if merge_base.is_empty() {
        return Ok(Vec::new());
    }

    let output = run_git_owned(
        repo_path,
        vec![
            "diff".into(),
            "--name-only".into(),
            format!("{merge_base}..{upstream}"),
        ],
    )
    .await?;

    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn sanitize_path_list(paths: Vec<String>) -> Vec<String> {
    let mut unique = std::collections::BTreeSet::new();

    for path in paths {
        let trimmed = path.trim().replace('\\', "/");
        if !trimmed.is_empty() {
            unique.insert(trimmed);
        }
    }

    unique.into_iter().collect()
}

fn validate_repository_path(repo_path: &str) -> GitResult<&Path> {
    let path = Path::new(repo_path);

    if !path.exists() || !path.is_dir() {
        return Err(GitServiceError::InvalidRepository);
    }

    Ok(path)
}

fn resolve_repo_file(repo_root: &Path, relative_path: &str) -> GitResult<PathBuf> {
    let root = repo_root
        .canonicalize()
        .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
    let candidate = root.join(relative_path);
    let resolved = candidate
        .canonicalize()
        .map_err(|_| GitServiceError::InvalidFileSelection)?;

    if !resolved.starts_with(&root) {
        return Err(GitServiceError::InvalidFileSelection);
    }

    Ok(resolved)
}

async fn git_diff(repo_root: &Path, relative_path: &str, cached: bool) -> GitResult<Option<String>> {
    let mut args = vec!["diff".to_string(), "--no-ext-diff".to_string(), "--unified=3".to_string()];

    if cached {
        args.push("--cached".to_string());
    }

    args.push("--".to_string());
    args.push(relative_path.to_string());

    let output = run_git_owned(repo_root, args).await?;
    let trimmed = output.trim();

    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed.to_string()))
    }
}

async fn run_git<I, S>(repo_path: &Path, args: I) -> GitResult<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let owned_args = args.into_iter().map(|value| value.as_ref().to_string()).collect();
    run_git_owned(repo_path, owned_args).await
}

async fn run_git_remote_owned(repo_path: &Path, args: Vec<String>) -> GitResult<String> {
    let overrides = build_git_remote_environment(repo_path)?;
    run_git_owned_with_env(repo_path, args, overrides).await
}

async fn run_git_global_owned(args: Vec<String>) -> GitResult<String> {
    let command_preview = args.join(" ");
    let _ = append_log("backend", "git.command.start", &format!("git {command_preview}"), None);

    let output = Command::new("git")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitServiceError::GitUnavailable,
            _ => GitServiceError::GitCommandFailed(error.to_string()),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = append_log("backend", "git.command.error", &format!("git {command_preview}"), Some(&stderr));
        return Err(GitServiceError::GitCommandFailed(stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let _ = append_log("backend", "git.command.success", &format!("git {command_preview}"), Some(&stdout));
    Ok(stdout)
}

async fn run_git_owned(repo_path: &Path, args: Vec<String>) -> GitResult<String> {
    run_git_owned_with_env(repo_path, args, None).await
}

async fn run_git_owned_with_env(
    repo_path: &Path,
    args: Vec<String>,
    overrides: Option<GitRemoteEnvironment>,
) -> GitResult<String> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let log_detail = overrides
        .as_ref()
        .and_then(|value| value.log_detail.as_deref())
        .map(ToString::to_string);
    let _ = append_log(
        "backend",
        "git.command.start",
        &format!("git -C {repo_display} {command_preview}"),
        log_detail.as_deref(),
    );

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(value) = overrides {
        for (key, env_value) in value.env_pairs {
            command.env(key, env_value);
        }
    }

    let output = command.output().await.map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => GitServiceError::GitUnavailable,
        _ => GitServiceError::GitCommandFailed(error.to_string()),
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = append_log(
            "backend",
            "git.command.error",
            &format!("git -C {repo_display} {command_preview}"),
            Some(&stderr),
        );
        return Err(GitServiceError::GitCommandFailed(
            stderr,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let _ = append_log(
        "backend",
        "git.command.success",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&stdout),
    );

    Ok(stdout)
}

struct GitCommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

async fn run_git_capture_owned(repo_path: &Path, args: Vec<String>) -> GitResult<GitCommandOutput> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let _ = append_log("backend", "git.command.start", &format!("git -C {repo_display} {command_preview}"), None);

    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitServiceError::GitUnavailable,
            _ => GitServiceError::GitCommandFailed(error.to_string()),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    let _ = append_log(
        "backend",
        if output.status.success() { "git.command.success" } else { "git.command.error" },
        &format!("git -C {repo_display} {command_preview}"),
        Some(&combine_command_output(&stdout, &stderr)),
    );

    Ok(GitCommandOutput {
        success: output.status.success(),
        stdout,
        stderr,
    })
}

async fn run_git_bytes_owned(repo_path: &Path, args: Vec<String>) -> GitResult<Vec<u8>> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let _ = append_log("backend", "git.command.start", &format!("git -C {repo_display} {command_preview}"), Some("binary stdout expected"));

    let output = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitServiceError::GitUnavailable,
            _ => GitServiceError::GitCommandFailed(error.to_string()),
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = append_log(
            "backend",
            "git.command.error",
            &format!("git -C {repo_display} {command_preview}"),
            Some(&stderr),
        );
        return Err(GitServiceError::GitCommandFailed(
            stderr,
        ));
    }

    let _ = append_log(
        "backend",
        "git.command.success",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&format!("{} binary bytes returned", output.stdout.len())),
    );

    Ok(output.stdout)
}

async fn run_git_owned_with_input(repo_path: &Path, args: Vec<String>, input: Vec<u8>) -> GitResult<String> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let _ = append_log(
        "backend",
        "git.command.start",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&format!("stdin bytes={}", input.len())),
    );

    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => GitServiceError::GitUnavailable,
            _ => GitServiceError::GitCommandFailed(error.to_string()),
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        stdin
            .write_all(&input)
            .await
            .map_err(|error| GitServiceError::GitCommandFailed(error.to_string()))?;
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|error| GitServiceError::GitCommandFailed(error.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = append_log(
            "backend",
            "git.command.error",
            &format!("git -C {repo_display} {command_preview}"),
            Some(&stderr),
        );
        return Err(GitServiceError::GitCommandFailed(
            stderr,
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let _ = append_log(
        "backend",
        "git.command.success",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&stdout),
    );

    Ok(stdout)
}

fn append_log(source: &str, scope: &str, message: &str, detail: Option<&str>) -> std::io::Result<()> {
    let _guard = LOG_LOCK.get_or_init(|| Mutex::new(())).lock().expect("log mutex poisoned");
    let log_path = resolve_log_path()?;

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;

    writeln!(
        file,
        "[{}] [{}] [{}] {}",
        chrono_like_timestamp(),
        source,
        scope,
        message
    )?;

    if let Some(value) = detail.filter(|value| !value.trim().is_empty()) {
        let truncated = truncate_for_log(value);
        writeln!(file, "  {}", truncated.replace('\n', "\n  "))?;
    }

    Ok(())
}

fn clear_git_index_lock_inner(repo_path: String) -> GitResult<String> {
    let repo_root = PathBuf::from(repo_path.trim());

    if repo_root.as_os_str().is_empty() || !repo_root.is_dir() {
        return Err(GitServiceError::InvalidRepository);
    }

    let lock_path = repo_root.join(".git").join("index.lock");

    if !lock_path.exists() {
        return Ok("No index.lock file was present.".to_string());
    }

    if !lock_path.is_file() {
        return Err(GitServiceError::GitCommandFailed(format!(
            "Expected a file at '{}' but found something else.",
            lock_path.display()
        )));
    }

    fs::remove_file(&lock_path).map_err(|error| {
        GitServiceError::GitCommandFailed(format!(
            "Failed to remove '{}': {}",
            lock_path.display(),
            error
        ))
    })?;

    let _ = append_log(
        "backend",
        "git.index-lock.clear",
        &format!("Removed stale lock file at {}", lock_path.display()),
        Some(&format!("Repository: {}", repo_root.display())),
    );

    Ok(format!("Removed stale git index lock at {}.", lock_path.display()))
}

fn resolve_log_path() -> std::io::Result<PathBuf> {
    let base = dirs_next::data_local_dir().unwrap_or_else(std::env::temp_dir);
    Ok(base.join("UniGit").join("logs").join("unigit.log"))
}

fn truncate_for_log(value: &str) -> String {
    if value.len() <= LOG_DETAIL_LIMIT {
        return value.to_string();
    }

    format!("{}\n...[truncated {} chars]", &value[..LOG_DETAIL_LIMIT], value.len() - LOG_DETAIL_LIMIT)
}

fn parse_status_output(output: &str) -> (String, bool, usize, usize, Vec<FileChange>, RepositoryCounts) {
    let mut current_branch = "Unknown".to_string();
    let mut detached_head = false;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut counts = RepositoryCounts::default();

    for line in output.lines() {
        if let Some(branch_line) = line.strip_prefix("## ") {
            let branch_segment = branch_line.split_whitespace().next().unwrap_or("Unknown");

            if branch_segment == "HEAD" || branch_segment == "No" {
                detached_head = true;
                current_branch = branch_line.to_string();
            } else {
                current_branch = branch_segment
                    .split("...")
                    .next()
                    .unwrap_or(branch_segment)
                    .to_string();
            }

            if let Some(start) = branch_line.find('[') {
                if let Some(end) = branch_line.find(']') {
                    let tracking = &branch_line[start + 1..end];
                    for part in tracking.split(',') {
                        let trimmed = part.trim();
                        if let Some(value) = trimmed.strip_prefix("ahead ") {
                            ahead = value.parse().unwrap_or(0);
                        }
                        if let Some(value) = trimmed.strip_prefix("behind ") {
                            behind = value.parse().unwrap_or(0);
                        }
                    }
                }
            }

            continue;
        }

        if line.len() < 3 {
            continue;
        }

        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let raw_path = &line[3..];
        let path = raw_path.rsplit(" -> ").next().unwrap_or(raw_path).to_string();

        let untracked = index_status == '?' && worktree_status == '?';
        let ignored = index_status == '!' && worktree_status == '!';
        let conflicted = matches!(index_status, 'U' | 'A' | 'D') && matches!(worktree_status, 'U' | 'A' | 'D')
            || index_status == 'U'
            || worktree_status == 'U';
        let staged = !untracked && !ignored && index_status != ' ';
        let unstaged = !untracked && !ignored && worktree_status != ' ';
        let staged_modified = staged && unstaged;

        if staged {
            counts.staged += 1;
        }
        if unstaged {
            counts.unstaged += 1;
        }
        if conflicted {
            counts.conflicted += 1;
        }
        if untracked {
            counts.untracked += 1;
        }
        if ignored {
            counts.ignored += 1;
        }
        if staged_modified {
            counts.staged_modified += 1;
        }

        let display_status = if conflicted {
            "Conflict".to_string()
        } else if staged_modified {
            "Staged then changed again".to_string()
        } else if untracked {
            "Untracked".to_string()
        } else if staged {
            format!("Staged ({})", map_status_code(index_status))
        } else if unstaged {
            format!("Unstaged ({})", map_status_code(worktree_status))
        } else if ignored {
            "Ignored".to_string()
        } else {
            "Changed".to_string()
        };

        files.push(FileChange {
            path,
            index_status: map_status_code(index_status).to_string(),
            worktree_status: map_status_code(worktree_status).to_string(),
            staged,
            unstaged,
            conflicted,
            untracked,
            ignored,
            staged_modified,
            display_status,
        });
    }

    (current_branch, detached_head, ahead, behind, files, counts)
}

fn map_status_code(code: char) -> &'static str {
    match code {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "unmerged",
        '?' => "untracked",
        '!' => "ignored",
        _ => "clean",
    }
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    now.to_string()
}

fn infer_mime_type(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "txt" | "md" | "json" | "toml" | "yaml" | "yml" | "py" | "ts" | "tsx" | "js" | "jsx" | "rs" | "cs" | "shader" | "cginc" | "hlsl" | "glsl" => "text/plain",
        "psd" => "image/vnd.adobe.photoshop",
        "fbx" => "model/vnd.fbx",
        "obj" => "model/obj",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "blend" => "application/x-blender",
        _ => "application/octet-stream",
    }
}

fn build_asset_summary(path: &Path, extension: &str) -> GitResult<Option<AssetSummary>> {
    let bytes = fs::read(path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;

    let summary = match extension {
        "psd" => parse_psd_summary(&bytes),
        "fbx" => parse_fbx_summary(&bytes),
        "gltf" => parse_gltf_summary(&bytes),
        "glb" => parse_glb_summary(&bytes),
        "blend" => Some(AssetSummary {
            asset_kind: "Blender scene".to_string(),
            pipeline_state: "External renderer required".to_string(),
            details: vec![AssetDetail {
                label: "Preview route".to_string(),
                value: "Bundle Blender-backed thumbnail worker in a later slice".to_string(),
            }],
        }),
        _ => None,
    };

    Ok(summary)
}

fn parse_psd_summary(bytes: &[u8]) -> Option<AssetSummary> {
    if bytes.len() < 26 || &bytes[0..4] != b"8BPS" {
        return None;
    }

    let version = u16::from_be_bytes([bytes[4], bytes[5]]);
    let channels = u16::from_be_bytes([bytes[12], bytes[13]]);
    let height = u32::from_be_bytes([bytes[14], bytes[15], bytes[16], bytes[17]]);
    let width = u32::from_be_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]);
    let depth = u16::from_be_bytes([bytes[22], bytes[23]]);
    let color_mode = u16::from_be_bytes([bytes[24], bytes[25]]);

    Some(AssetSummary {
        asset_kind: "Photoshop document".to_string(),
        pipeline_state: "Header parsed, flattened renderer pending".to_string(),
        details: vec![
            AssetDetail {
                label: "Version".to_string(),
                value: version.to_string(),
            },
            AssetDetail {
                label: "Dimensions".to_string(),
                value: format!("{} x {}", width, height),
            },
            AssetDetail {
                label: "Channels".to_string(),
                value: channels.to_string(),
            },
            AssetDetail {
                label: "Depth".to_string(),
                value: format!("{} bit", depth),
            },
            AssetDetail {
                label: "Color mode".to_string(),
                value: color_mode.to_string(),
            },
        ],
    })
}

fn parse_fbx_summary(bytes: &[u8]) -> Option<AssetSummary> {
    let ascii_prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_string();

    if ascii_prefix.contains("Kaydara FBX Binary") {
        let version = if bytes.len() >= 27 {
            u32::from_le_bytes([bytes[23], bytes[24], bytes[25], bytes[26]])
        } else {
            0
        };

        return Some(AssetSummary {
            asset_kind: "FBX scene".to_string(),
            pipeline_state: "Binary scene detected, mesh worker pending".to_string(),
            details: vec![AssetDetail {
                label: "Format version".to_string(),
                value: if version > 0 {
                    version.to_string()
                } else {
                    "unknown".to_string()
                },
            }],
        });
    }

    if ascii_prefix.contains("FBXHeaderExtension") || ascii_prefix.contains("Kaydara\\FBX") {
        let version = ascii_prefix
            .lines()
            .find(|line| line.contains("FBXVersion"))
            .map(|line| line.chars().filter(|char| char.is_ascii_digit()).collect::<String>())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string());

        return Some(AssetSummary {
            asset_kind: "FBX scene".to_string(),
            pipeline_state: "ASCII scene detected, mesh worker pending".to_string(),
            details: vec![AssetDetail {
                label: "Format version".to_string(),
                value: version,
            }],
        });
    }

    None
}

fn parse_gltf_summary(bytes: &[u8]) -> Option<AssetSummary> {
    let json = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let scenes = json
        .get("scenes")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    let nodes = json
        .get("nodes")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    let meshes = json
        .get("meshes")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    let animations = json
        .get("animations")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);

    Some(AssetSummary {
        asset_kind: "glTF scene".to_string(),
        pipeline_state: "Scene parsed, viewer embedding pending".to_string(),
        details: vec![
            AssetDetail {
                label: "Scenes".to_string(),
                value: scenes.to_string(),
            },
            AssetDetail {
                label: "Nodes".to_string(),
                value: nodes.to_string(),
            },
            AssetDetail {
                label: "Meshes".to_string(),
                value: meshes.to_string(),
            },
            AssetDetail {
                label: "Animations".to_string(),
                value: animations.to_string(),
            },
        ],
    })
}

fn parse_glb_summary(bytes: &[u8]) -> Option<AssetSummary> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return None;
    }

    let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let length = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);

    Some(AssetSummary {
        asset_kind: "GLB scene".to_string(),
        pipeline_state: "Container parsed, viewer embedding pending".to_string(),
        details: vec![
            AssetDetail {
                label: "Version".to_string(),
                value: version.to_string(),
            },
            AssetDetail {
                label: "Container bytes".to_string(),
                value: length.to_string(),
            },
        ],
    })
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
}

fn is_previewable_image_extension(extension: &str) -> bool {
    is_image_extension(extension) || extension == "psd"
}

fn is_previewable_model_extension(extension: &str) -> bool {
    matches!(extension, "fbx" | "obj" | "gltf" | "glb")
}

fn is_text_extension(extension: &str) -> bool {
    matches!(
        extension,
        "txt"
            | "md"
            | "json"
            | "toml"
            | "yaml"
            | "yml"
            | "py"
            | "ts"
            | "tsx"
            | "js"
            | "jsx"
            | "rs"
            | "cs"
            | "shader"
            | "cginc"
            | "hlsl"
            | "glsl"
            | "gitignore"
            | "gitattributes"
    )
}

fn is_known_asset_extension(extension: &str) -> bool {
    matches!(extension, "psd" | "fbx" | "obj" | "glb" | "gltf" | "blend" | "tga" | "exr")
}

async fn collect_model_preview_sources(
    repo_root: &Path,
    resolved_path: &Path,
    relative_path: &str,
    extension: &str,
    mime_type: &str,
) -> GitResult<Vec<ModelPreviewSource>> {
    let mut sources = Vec::new();

    for (key, label, source_kind) in [
        ("workingTree", "Working tree", PreviewBlobSource::WorkingTree),
        ("staged", "Staged", PreviewBlobSource::Staged),
        ("head", "HEAD", PreviewBlobSource::Head),
    ] {
        let Some(bytes) = read_preview_blob(repo_root, resolved_path, relative_path, source_kind).await? else {
            continue;
        };

        if (bytes.len() as u64) > MAX_INLINE_MODEL_BYTES {
            continue;
        }

        let external_resources = collect_model_preview_resources(repo_root, source_kind, relative_path, extension, &bytes).await?;
        let notes = match extension {
            "fbx" => vec!["FBX preview uses a generic Three.js loader. External texture references may not always resolve.".to_string()],
            "obj" => vec!["OBJ preview loads geometry directly and uses MTL resources when they can be resolved from sidecar files.".to_string()],
            "gltf" => vec!["glTF preview loads referenced buffers and textures when they are available in the same repo state.".to_string()],
            "glb" => Vec::new(),
            _ => Vec::new(),
        };

        sources.push(ModelPreviewSource {
            key: key.to_string(),
            label: label.to_string(),
            source_kind: key.to_string(),
            format: extension.to_string(),
            relative_path: relative_path.to_string(),
            mime_type: mime_type.to_string(),
            encoded_bytes_base64: BASE64.encode(bytes),
            asset_label: match extension {
                "fbx" => "FBX scene".to_string(),
                "obj" => "OBJ mesh".to_string(),
                "gltf" | "glb" => "glTF scene".to_string(),
                _ => "3D model".to_string(),
            },
            notes,
            external_resources,
        });
    }

    Ok(sources)
}

async fn collect_model_preview_resources(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    relative_path: &str,
    extension: &str,
    bytes: &[u8],
) -> GitResult<Vec<ModelPreviewResource>> {
    let referenced_uris = match extension {
        "gltf" => parse_gltf_external_uris(bytes),
        "obj" => parse_obj_external_uris(bytes, repo_root, source_kind, relative_path).await?,
        _ => Vec::new(),
    };

    let mut resources = Vec::new();
    for uri in referenced_uris {
        if uri.starts_with("data:") {
            continue;
        }

        let resolved_relative_path = resolve_relative_asset_path(relative_path, &uri);
        let Some(resource_bytes) = read_model_external_resource_bytes(repo_root, source_kind, &resolved_relative_path).await? else {
            continue;
        };

        if (resource_bytes.len() as u64) > MAX_INLINE_MODEL_BYTES {
            continue;
        }

        let resource_extension = Path::new(&resolved_relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        resources.push(ModelPreviewResource {
            uri,
            mime_type: infer_mime_type(&resource_extension).to_string(),
            encoded_bytes_base64: BASE64.encode(resource_bytes),
        });
    }

    Ok(resources)
}

fn parse_gltf_external_uris(bytes: &[u8]) -> Vec<String> {
    let json = serde_json::from_slice::<serde_json::Value>(bytes).ok();
    let mut uris = Vec::new();

    if let Some(root) = json {
        for key in ["buffers", "images"] {
            if let Some(entries) = root.get(key).and_then(|value| value.as_array()) {
                for entry in entries {
                    if let Some(uri) = entry.get("uri").and_then(|value| value.as_str()) {
                        uris.push(uri.to_string());
                    }
                }
            }
        }
    }

    uris
}

async fn parse_obj_external_uris(
    bytes: &[u8],
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    relative_path: &str,
) -> GitResult<Vec<String>> {
    let source = String::from_utf8_lossy(bytes);
    let mut uris = Vec::new();

    for line in source.lines() {
        let trimmed = line.trim();
        if let Some(uri) = trimmed.strip_prefix("mtllib ") {
            let uri = uri.trim().to_string();
            uris.push(uri.clone());

            let resolved_relative_path = resolve_relative_asset_path(relative_path, &uri);
            let Some(mtl_bytes) = read_model_external_resource_bytes(repo_root, source_kind, &resolved_relative_path).await? else {
                continue;
            };

            let mtl_source = String::from_utf8_lossy(&mtl_bytes);
            for mtl_line in mtl_source.lines() {
                let trimmed_mtl = mtl_line.trim();
                for prefix in ["map_Kd ", "map_Ka ", "map_Bump ", "map_bump ", "bump ", "map_d "] {
                    if let Some(texture_uri) = trimmed_mtl.strip_prefix(prefix) {
                        uris.push(texture_uri.trim().to_string());
                    }
                }
            }
        }
    }

    Ok(uris)
}

fn resolve_relative_asset_path(base_relative_path: &str, uri: &str) -> String {
    let base_path = Path::new(base_relative_path);
    let parent = base_path.parent().unwrap_or_else(|| Path::new(""));
    parent.join(uri).to_string_lossy().replace('\\', "/")
}

async fn read_model_external_resource_bytes(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    relative_path: &str,
) -> GitResult<Option<Vec<u8>>> {
    match source_kind {
        PreviewBlobSource::WorkingTree => {
            let resolved = resolve_repo_file(repo_root, relative_path)?;
            Ok(Some(fs::read(resolved).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?))
        }
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_path}")).await,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}")).await,
    }
}

async fn collect_image_preview_sources(
    repo_root: &Path,
    resolved_path: &Path,
    relative_path: &str,
    extension: &str,
    mime_type: &str,
) -> GitResult<Vec<ImagePreviewSource>> {
    let mut sources = Vec::new();

    let working_tree_bytes = fs::read(resolved_path)
        .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;

    if (working_tree_bytes.len() as u64) <= MAX_INLINE_IMAGE_BYTES {
        sources.push(build_image_preview_source(
            "workingTree",
            "Working tree",
            "workingTree",
            mime_type,
            extension,
            working_tree_bytes,
        ));
    }

    if let Some(staged_bytes) = git_show_optional_bytes(repo_root, format!(":{relative_path}")).await? {
        if (staged_bytes.len() as u64) <= MAX_INLINE_IMAGE_BYTES {
            sources.push(build_image_preview_source(
                "staged",
                "Staged",
                "staged",
                mime_type,
                extension,
                staged_bytes,
            ));
        }
    }

    if let Some(head_bytes) = git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}")).await? {
        if (head_bytes.len() as u64) <= MAX_INLINE_IMAGE_BYTES {
            sources.push(build_image_preview_source(
                "head",
                "HEAD",
                "head",
                mime_type,
                extension,
                head_bytes,
            ));
        }
    }

    Ok(sources)
}

fn build_image_preview_source(
    key: &str,
    label: &str,
    source_kind: &str,
    mime_type: &str,
    extension: &str,
    bytes: Vec<u8>,
) -> ImagePreviewSource {
    ImagePreviewSource {
        key: key.to_string(),
        label: label.to_string(),
        source_kind: source_kind.to_string(),
        mime_type: mime_type.to_string(),
        byte_size: bytes.len() as u64,
        encoded_bytes_base64: BASE64.encode(bytes),
        is_psd: extension == "psd",
    }
}

fn build_image_comparison_presets(
    sources: &[ImagePreviewSource],
    has_staged_diff: bool,
    has_unstaged_diff: bool,
) -> Vec<ImageComparisonPreset> {
    let has_key = |needle: &str| sources.iter().any(|source| source.key == needle);
    let mut presets = Vec::new();

    if has_staged_diff && has_key("head") && has_key("staged") {
        presets.push(ImageComparisonPreset {
            key: "staged-vs-head".to_string(),
            label: "Staged vs HEAD".to_string(),
            left_source_key: "head".to_string(),
            right_source_key: "staged".to_string(),
            description: "Inspect what is currently staged against the last committed version.".to_string(),
        });
    }

    if has_unstaged_diff && has_key("staged") && has_key("workingTree") {
        presets.push(ImageComparisonPreset {
            key: "working-tree-vs-staged".to_string(),
            label: "Working tree vs staged".to_string(),
            left_source_key: "staged".to_string(),
            right_source_key: "workingTree".to_string(),
            description: "Inspect unstaged image changes against the current index state.".to_string(),
        });
    } else if has_unstaged_diff && has_key("head") && has_key("workingTree") {
        presets.push(ImageComparisonPreset {
            key: "working-tree-vs-head".to_string(),
            label: "Working tree vs HEAD".to_string(),
            left_source_key: "head".to_string(),
            right_source_key: "workingTree".to_string(),
            description: "Inspect the current working tree image against the last committed version.".to_string(),
        });
    }

    presets
}

async fn collect_unity_material_preview_sources(
    repo_root: &Path,
    resolved_path: &Path,
    relative_path: &str,
) -> GitResult<Vec<UnityMaterialPreviewSource>> {
    let mut sources = Vec::new();
    let mut guid_cache = std::collections::HashMap::<String, Option<String>>::new();

    for (key, label, source_kind) in [
        ("workingTree", "Working tree", PreviewBlobSource::WorkingTree),
        ("staged", "Staged", PreviewBlobSource::Staged),
        ("head", "HEAD", PreviewBlobSource::Head),
    ] {
        let Some(bytes) = read_preview_blob(repo_root, resolved_path, relative_path, source_kind).await? else {
            continue;
        };

        let text = String::from_utf8_lossy(&bytes).to_string();
        let Some(parsed_material) = parse_unity_material(&text) else {
            continue;
        };

        let textures = resolve_unity_material_textures(repo_root, source_kind, &parsed_material, &mut guid_cache).await?;
        let shader_family = infer_unity_shader_family(&parsed_material, &textures);
        let shader_label = infer_unity_shader_label(&parsed_material, &shader_family);
        let surface_kind = infer_unity_surface_kind(&parsed_material, &shader_family);
        let base_texture_key = select_material_texture_key(&textures, &["_BaseMap", "_MainTex", "_BaseColorMap"]);
        let normal_texture_key = select_material_texture_key(&textures, &["_BumpMap", "_NormalMap", "_NormalTexture"]);
        let emission_texture_key = select_material_texture_key(&textures, &["_EmissionMap", "_EmissiveColorMap"]);

        let notes = if shader_family == "custom" {
            vec!["Custom shader detected. UniGit is falling back to a generic lit material using the first available texture and common scalar properties.".to_string()]
        } else {
            Vec::new()
        };

        sources.push(UnityMaterialPreviewSource {
            key: key.to_string(),
            label: label.to_string(),
            source_kind: key.to_string(),
            material_name: parsed_material.material_name.clone(),
            shader_label,
            shader_family,
            surface_kind,
            base_color: pick_unity_color(&parsed_material, &["_BaseColor", "_Color"]),
            emission_color: pick_unity_color(&parsed_material, &["_EmissionColor", "_EmissiveColor"]),
            metallic: pick_unity_float(&parsed_material, &["_Metallic"]),
            smoothness: pick_unity_float(&parsed_material, &["_Smoothness", "_Glossiness", "_GlossMapScale"]),
            cutoff: pick_unity_float(&parsed_material, &["_Cutoff", "_AlphaClipThreshold"]),
            preview_shape_hint: "sphere".to_string(),
            notes,
            textures,
            base_texture_key,
            normal_texture_key,
            emission_texture_key,
        });
    }

    Ok(sources)
}

async fn read_preview_blob(
    repo_root: &Path,
    resolved_path: &Path,
    relative_path: &str,
    source_kind: PreviewBlobSource,
) -> GitResult<Option<Vec<u8>>> {
    match source_kind {
        PreviewBlobSource::WorkingTree => Ok(Some(
            fs::read(resolved_path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?,
        )),
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_path}")).await,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}")).await,
    }
}

fn parse_unity_material(source: &str) -> Option<ParsedUnityMaterial> {
    enum Section {
        None,
        TexEnvs,
        Floats,
        Colors,
    }

    let mut material_name = "Material".to_string();
    let mut shader_guid = None;
    let mut shader_file_id = None;
    let mut float_values = std::collections::HashMap::new();
    let mut color_values = std::collections::HashMap::new();
    let mut texture_slots = Vec::new();
    let mut section = Section::None;
    let mut current_texture_property: Option<String> = None;

    for raw_line in source.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("m_Name:") {
            material_name = value.trim().to_string();
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("m_Shader:") {
            let inline_fields = parse_inline_object_fields(value.trim());
            shader_guid = inline_fields.get("guid").cloned();
            shader_file_id = inline_fields.get("fileID").cloned();
            continue;
        }

        match trimmed {
            "m_TexEnvs:" => {
                section = Section::TexEnvs;
                current_texture_property = None;
                continue;
            }
            "m_Floats:" => {
                section = Section::Floats;
                current_texture_property = None;
                continue;
            }
            "m_Colors:" => {
                section = Section::Colors;
                current_texture_property = None;
                continue;
            }
            "m_Ints:" => {
                section = Section::None;
                current_texture_property = None;
                continue;
            }
            _ => {}
        }

        match section {
            Section::TexEnvs => {
                if let Some(value) = trimmed.strip_prefix("- ") {
                    if let Some(property_name) = value.strip_suffix(':') {
                        current_texture_property = Some(property_name.trim().to_string());
                    }
                    continue;
                }

                if let Some(property_name) = current_texture_property.as_ref() {
                    if let Some(value) = trimmed.strip_prefix("m_Texture:") {
                        let inline_fields = parse_inline_object_fields(value.trim());
                        texture_slots.push(ParsedUnityTextureSlot {
                            property_name: property_name.clone(),
                            guid: inline_fields.get("guid").cloned().filter(|guid| !guid.is_empty()),
                        });
                    }
                }
            }
            Section::Floats => {
                if let Some((key, value)) = parse_unity_scalar_entry(trimmed) {
                    float_values.insert(key, value);
                }
            }
            Section::Colors => {
                if let Some((key, value)) = parse_unity_color_entry(trimmed) {
                    color_values.insert(key, value);
                }
            }
            Section::None => {}
        }
    }

    Some(ParsedUnityMaterial {
        material_name,
        shader_guid,
        shader_file_id,
        float_values,
        color_values,
        texture_slots,
    })
}

fn parse_inline_object_fields(source: &str) -> std::collections::HashMap<String, String> {
    let mut values = std::collections::HashMap::new();
    let trimmed = source.trim().trim_start_matches('{').trim_end_matches('}');

    for part in trimmed.split(',') {
        let mut segments = part.splitn(2, ':');
        let key = segments.next().unwrap_or_default().trim();
        let value = segments.next().unwrap_or_default().trim();
        if !key.is_empty() {
            values.insert(key.to_string(), value.to_string());
        }
    }

    values
}

fn parse_unity_scalar_entry(trimmed: &str) -> Option<(String, f32)> {
    let entry = trimmed.strip_prefix("- ")?;
    let mut segments = entry.splitn(2, ':');
    let key = segments.next()?.trim().to_string();
    let value = segments.next()?.trim().parse::<f32>().ok()?;
    Some((key, value))
}

fn parse_unity_color_entry(trimmed: &str) -> Option<(String, UnityColorValue)> {
    let entry = trimmed.strip_prefix("- ")?;
    let mut segments = entry.splitn(2, ':');
    let key = segments.next()?.trim().to_string();
    let value = segments.next()?.trim();
    let inline_fields = parse_inline_object_fields(value);

    Some((
        key,
        UnityColorValue {
            r: inline_fields.get("r")?.parse().ok()?,
            g: inline_fields.get("g")?.parse().ok()?,
            b: inline_fields.get("b")?.parse().ok()?,
            a: inline_fields.get("a").and_then(|value| value.parse().ok()).unwrap_or(1.0),
        },
    ))
}

async fn resolve_unity_material_textures(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    material: &ParsedUnityMaterial,
    guid_cache: &mut std::collections::HashMap<String, Option<String>>,
) -> GitResult<Vec<UnityMaterialTexturePreview>> {
    let mut textures = Vec::new();

    for slot in &material.texture_slots {
        let Some(guid) = slot.guid.as_ref() else {
            continue;
        };

        let relative_texture_path = match guid_cache.get(guid) {
            Some(value) => value.clone(),
            None => {
                let resolved = find_repo_asset_path_by_guid(repo_root, guid)?;
                guid_cache.insert(guid.clone(), resolved.clone());
                resolved
            }
        };

        let Some(relative_texture_path) = relative_texture_path else {
            continue;
        };

        let extension = Path::new(&relative_texture_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if !is_previewable_image_extension(&extension) {
            continue;
        }

        let Some(bytes) = read_material_texture_bytes(repo_root, source_kind, &relative_texture_path).await? else {
            continue;
        };

        if (bytes.len() as u64) > MAX_INLINE_IMAGE_BYTES {
            continue;
        }

        textures.push(UnityMaterialTexturePreview {
            key: slot.property_name.clone(),
            property_name: slot.property_name.clone(),
            label: slot.property_name.clone(),
            relative_path: relative_texture_path,
            mime_type: infer_mime_type(&extension).to_string(),
            encoded_bytes_base64: BASE64.encode(bytes),
            is_psd: extension == "psd",
        });
    }

    Ok(textures)
}

async fn read_material_texture_bytes(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    relative_texture_path: &str,
) -> GitResult<Option<Vec<u8>>> {
    match source_kind {
        PreviewBlobSource::WorkingTree => {
            let resolved = resolve_repo_file(repo_root, relative_texture_path)?;
            Ok(Some(fs::read(resolved).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?))
        }
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_texture_path}")).await,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_texture_path}")).await,
    }
}

fn find_repo_asset_path_by_guid(repo_root: &Path, guid: &str) -> GitResult<Option<String>> {
    fn walk(dir: &Path, repo_root: &Path, guid: &str) -> GitResult<Option<String>> {
        for entry in fs::read_dir(dir).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))? {
            let entry = entry.map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            let path = entry.path();
            let file_name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();

            if path.is_dir() {
                if matches!(file_name, ".git" | "node_modules" | "target" | "dist") {
                    continue;
                }

                if let Some(found) = walk(&path, repo_root, guid)? {
                    return Ok(Some(found));
                }
                continue;
            }

            if path.extension().and_then(|value| value.to_str()) != Some("meta") {
                continue;
            }

            let contents = fs::read_to_string(&path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            if !contents.contains(&format!("guid: {guid}")) {
                continue;
            }

            let relative_meta_path = path
                .strip_prefix(repo_root)
                .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            return Ok(Some(relative_meta_path.trim_end_matches(".meta").to_string()));
        }

        Ok(None)
    }

    walk(repo_root, repo_root, guid)
}

fn infer_unity_shader_family(material: &ParsedUnityMaterial, textures: &[UnityMaterialTexturePreview]) -> String {
    let has_base_map = textures.iter().any(|texture| matches!(texture.property_name.as_str(), "_BaseMap" | "_MainTex" | "_BaseColorMap"));
    let has_metallic = material.float_values.contains_key("_Metallic");
    let has_smoothness = material.float_values.contains_key("_Smoothness") || material.float_values.contains_key("_Glossiness");
    let has_emission = material.color_values.contains_key("_EmissionColor") || textures.iter().any(|texture| texture.property_name == "_EmissionMap");

    if has_base_map && has_metallic && has_smoothness {
        return "lit".to_string();
    }

    if has_base_map || has_emission {
        return "unlit".to_string();
    }

    "custom".to_string()
}

fn infer_unity_shader_label(material: &ParsedUnityMaterial, shader_family: &str) -> String {
    match shader_family {
        "lit" => "Unity Lit-compatible".to_string(),
        "unlit" => "Unity Unlit-compatible".to_string(),
        _ => match (&material.shader_guid, &material.shader_file_id) {
            (Some(guid), Some(file_id)) => format!("Custom shader {file_id}:{guid}"),
            _ => "Custom shader".to_string(),
        },
    }
}

fn infer_unity_surface_kind(material: &ParsedUnityMaterial, shader_family: &str) -> String {
    if material.float_values.get("_Surface").copied().unwrap_or(0.0) >= 1.0 || material.float_values.get("_AlphaClip").copied().unwrap_or(0.0) >= 1.0 {
        return "transparent".to_string();
    }

    if shader_family == "unlit" {
        return "unlit".to_string();
    }

    "opaque".to_string()
}

fn pick_unity_color(material: &ParsedUnityMaterial, keys: &[&str]) -> Option<UnityColorValue> {
    keys.iter().find_map(|key| material.color_values.get(*key).cloned())
}

fn pick_unity_float(material: &ParsedUnityMaterial, keys: &[&str]) -> Option<f32> {
    keys.iter().find_map(|key| material.float_values.get(*key).copied())
}

fn select_material_texture_key(textures: &[UnityMaterialTexturePreview], preferred_keys: &[&str]) -> Option<String> {
    for key in preferred_keys {
        if let Some(texture) = textures.iter().find(|texture| texture.property_name == *key) {
            return Some(texture.key.clone());
        }
    }

    textures.first().map(|texture| texture.key.clone())
}

fn build_unity_material_asset_summary(source: &UnityMaterialPreviewSource) -> AssetSummary {
    AssetSummary {
        asset_kind: "Unity material".to_string(),
        pipeline_state: source.shader_label.clone(),
        details: vec![
            AssetDetail {
                label: "Material".to_string(),
                value: source.material_name.clone(),
            },
            AssetDetail {
                label: "Surface".to_string(),
                value: source.surface_kind.clone(),
            },
            AssetDetail {
                label: "Textures".to_string(),
                value: source.textures.len().to_string(),
            },
        ],
    }
}

async fn git_show_optional_bytes(repo_root: &Path, object_spec: String) -> GitResult<Option<Vec<u8>>> {
    match run_git_bytes_owned(repo_root, vec!["show".into(), object_spec]).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(GitServiceError::GitCommandFailed(message)) if is_missing_git_object_error(&message) => Ok(None),
        Err(error) => Err(error),
    }
}

fn is_missing_git_object_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();

    normalized.contains("exists on disk, but not in")
        || normalized.contains("does not exist in")
        || normalized.contains("path '" ) && normalized.contains("exists on disk, but not in 'head'")
        || normalized.contains("fatal: pathspec")
}

fn looks_like_text(path: &Path) -> GitResult<bool> {
    let bytes = fs::read(path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
    let sample = &bytes[..bytes.len().min(4_096)];

    if sample.contains(&0) {
        return Ok(false);
    }

    Ok(std::str::from_utf8(sample).is_ok())
}
