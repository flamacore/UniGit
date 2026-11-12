use std::{
    collections::{BTreeMap, HashMap},
    env,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use regex::Regex;
use serde::{Deserialize, Serialize};

use tauri::command;
use thiserror::Error;
use tokio::process::Command;

use super::models::{
    AssetDetail, AssetSummary, BranchEntry, CloneResult, CommitDetail, CommitFileEntry,
    CommitGraphPage, CommitGraphRow, CommitMessageContext, CommitSummary, FileChange,
    FileHistoryEntry, FilePreview, GitLfsPreparationResult, ImageComparisonPreset, ImagePreviewSource, MergeBranchResult,
    MergePreview, RepositoryOperation,
    ModelPreviewResource, ModelPreviewSource,
    StashEntry,
    RepositoryConfig, RepositoryCounts, RepositoryRemote, RepositorySnapshot, RepositorySshConfigHost,
    RepositorySshDiscovery, RepositorySshKeyOption, RepositorySshSettings, UnityColorValue,
    UnityMaterialPreviewSource, UnityMaterialProperty, UnityMaterialTexturePreview,
};
use super::activity;
use super::unity_shader::{parse_shader, ParsedShader, ShaderProperty, ShaderPropertyKind};

const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_INLINE_MODEL_BYTES: u64 = 24 * 1024 * 1024;
/// Upper bound on what a preview reads from disk; headers and text excerpts need far less.
const MAX_PREVIEW_READ_BYTES: u64 = 64 * 1024 * 1024;
const LARGE_COMMIT_CHUNK_BYTES: u64 = 1024 * 1024 * 1024;
const LARGE_LFS_TRACK_BYTES: u64 = 50 * 1024 * 1024;
const LOG_DETAIL_LIMIT: usize = 6_000;
const MAX_LOG_FILE_BYTES: u64 = 20 * 1024 * 1024;
const COMMIT_MESSAGE_DIFF_LIMIT: usize = 30_000;
const COMMIT_MESSAGE_UPSTREAM_LIMIT: usize = 8;

static LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(windows)]
fn suppress_console_window(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console_window(_command: &mut Command) {}

/// Every git invocation goes through here so path handling is identical everywhere.
fn git_command(repo_path: Option<&Path>) -> Command {
    let mut command = Command::new("git");
    suppress_console_window(&mut command);
    // There is no terminal behind the app: an editor prompt (merge --continue, etc.) would hang
    // forever in a hidden console, so accept git's prepared message instead.
    command.env("GIT_EDITOR", "true");
    // Never wait for a typed answer: there is no terminal, so a prompt would hang forever.
    command.env("GIT_TERMINAL_PROMPT", "0");
    // Emit non-ASCII paths as UTF-8 instead of octal-escaped quoted strings.
    command.args(["-c", "core.quotepath=false"]);

    if let Some(path) = repo_path {
        command.arg("-C").arg(path);
    }

    command
}

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
    /// Floats and ints; Unity stores both as plain numbers.
    float_values: HashMap<String, f32>,
    /// Colors and vectors; Unity stores both as r/g/b/a.
    color_values: HashMap<String, UnityColorValue>,
    texture_slots: Vec<ParsedUnityTextureSlot>,
    keywords: Vec<String>,
    custom_render_queue: Option<i32>,
}

#[derive(Debug, Clone)]
struct ParsedUnityTextureSlot {
    property_name: String,
    guid: Option<String>,
    scale: (f32, f32),
    offset: (f32, f32),
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionalBranchPruneInput {
    age_value: Option<u64>,
    age_unit: Option<String>,
    merged_into_branches: Vec<String>,
    folder_prefixes: Vec<String>,
    regex_pattern: Option<String>,
    target: String,
}

#[derive(Debug, Clone)]
struct BranchPruneCandidate {
    full_name: String,
    name: String,
    branch_kind: String,
    tracking_name: Option<String>,
    is_current: bool,
    comparable_name: String,
    committed_at_unix: Option<u64>,
}

#[derive(Debug, Clone)]
struct NormalizedConditionalBranchPruneInput {
    max_age_seconds: Option<u64>,
    merged_into_branches: Vec<String>,
    folder_prefixes: Vec<String>,
    regex: Option<Regex>,
    target: BranchPruneTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BranchPruneTarget {
    Local,
    Remote,
    Both,
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
pub async fn list_commit_graph(
    repo_path: String,
    limit: usize,
    skip: usize,
    graph_scope: Option<String>,
    graph_order: Option<String>,
) -> Result<CommitGraphPage, String> {
    list_commit_graph_inner(repo_path, limit, skip, graph_scope, graph_order)
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
pub async fn list_stashes(repo_path: String) -> Result<Vec<StashEntry>, String> {
    list_stashes_inner(repo_path)
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
pub async fn stash_paths(repo_path: String, paths: Vec<String>) -> Result<String, String> {
    stash_paths_inner(repo_path, paths)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn apply_stash(repo_path: String, reference: String) -> Result<String, String> {
    apply_stash_inner(repo_path, reference)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn drop_stash(repo_path: String, reference: String) -> Result<String, String> {
    drop_stash_inner(repo_path, reference)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn detach_head_to_commit(repo_path: String, commit_hash: String) -> Result<String, String> {
    detach_head_to_commit_inner(repo_path, commit_hash)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn cherry_pick_commit(
    repo_path: String,
    commit_hash: String,
    mainline_parent: Option<usize>,
) -> Result<MergeBranchResult, String> {
    cherry_pick_commit_inner(repo_path, commit_hash, mainline_parent)
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
pub async fn hard_prune_local_branches(repo_path: String) -> Result<String, String> {
    hard_prune_local_branches_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn conditional_prune_branches(repo_path: String, input: ConditionalBranchPruneInput) -> Result<String, String> {
    conditional_prune_branches_inner(repo_path, input)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn merge_branch(
    repo_path: String,
    full_name: String,
    local_changes: String,
    conflict_preference: String,
) -> Result<MergeBranchResult, String> {
    merge_branch_inner(repo_path, full_name, local_changes, conflict_preference)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn preview_merge(repo_path: String, full_name: String) -> Result<MergePreview, String> {
    preview_merge_inner(repo_path, full_name)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn cancel_git_command(command_id: u64) -> Result<(), String> {
    activity::cancel(command_id).await
}

#[command]
pub async fn abort_operation(repo_path: String) -> Result<String, String> {
    abort_operation_inner(repo_path)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn continue_operation(repo_path: String) -> Result<String, String> {
    continue_operation_inner(repo_path)
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
pub async fn pull_branch(repo_path: String, full_name: String) -> Result<String, String> {
    pull_branch_inner(repo_path, full_name)
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

#[command]
pub async fn create_commit_for_paths(repo_path: String, message: String, paths: Vec<String>) -> Result<String, String> {
    let path = validate_repository_path(&repo_path).map_err(|error| error.to_string())?;
    let trimmed = message.trim();
    let sanitized_paths = sanitize_path_list(paths);

    if trimmed.is_empty() {
        return Err("Commit message cannot be empty.".to_string());
    }

    if sanitized_paths.is_empty() {
        return Err("Commit paths cannot be empty.".to_string());
    }

    // Git refuses a path-limited commit while a merge or cherry-pick is being concluded
    // ("cannot do a partial commit during a merge"), so commit the whole index instead.
    if detect_repository_operation(path).is_some() {
        return run_git(path, ["commit", "-m", trimmed])
            .await
            .map_err(|error| error.to_string());
    }

    let args = vec![
        "commit".to_string(),
        "-m".to_string(),
        trimmed.to_string(),
        "--pathspec-from-file=-".to_string(),
        "--pathspec-file-nul".to_string(),
    ];

    run_git_owned_with_input(path, args, encode_pathspec_input(&sanitized_paths))
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn prepare_git_lfs(repo_path: String, paths: Vec<String>) -> Result<GitLfsPreparationResult, String> {
    prepare_git_lfs_inner(repo_path, paths)
        .await
        .map_err(|error| error.to_string())
}

async fn inspect_repository_inner(repo_path: String) -> GitResult<RepositorySnapshot> {
    let path = validate_repository_path(&repo_path)?;
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1", "-z", "--untracked-files=all"])
        .await?;

    let (current_branch, detached_head, ahead, behind, files, counts) = parse_status_output(&branch_output);
    let files = enrich_file_changes_with_sizes(path, files);

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
        operation: detect_repository_operation(path),
    })
}

fn resolve_git_dir(repo_root: &Path) -> Option<PathBuf> {
    let dot_git = repo_root.join(".git");

    if dot_git.is_dir() {
        return Some(dot_git);
    }

    // Worktrees and submodules keep a `.git` file that points at the real directory.
    let pointer = fs::read_to_string(&dot_git).ok()?;
    let target = pointer.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim();
    let target_path = Path::new(target);

    Some(if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        repo_root.join(target_path)
    })
}

/// Reads git's own state files, so an interrupted merge is still reported after an app restart.
fn detect_repository_operation(repo_root: &Path) -> Option<RepositoryOperation> {
    let git_dir = resolve_git_dir(repo_root)?;
    let first_line = |name: &str| {
        fs::read_to_string(git_dir.join(name))
            .ok()
            .and_then(|contents| contents.lines().next().map(|line| line.trim().to_string()))
            .filter(|line| !line.is_empty())
    };
    let short_hash = |name: &str| first_line(name).map(|hash| hash.chars().take(7).collect::<String>());
    let operation = |kind: &str, label: Option<String>| {
        Some(RepositoryOperation {
            kind: kind.to_string(),
            label: label.unwrap_or_else(|| kind.to_string()),
        })
    };

    if git_dir.join("MERGE_HEAD").exists() {
        return operation("merge", first_line("MERGE_MSG").or_else(|| short_hash("MERGE_HEAD")));
    }

    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return operation("cherry-pick", short_hash("CHERRY_PICK_HEAD"));
    }

    if git_dir.join("REVERT_HEAD").exists() {
        return operation("revert", short_hash("REVERT_HEAD"));
    }

    for directory in ["rebase-merge", "rebase-apply"] {
        if git_dir.join(directory).is_dir() {
            let branch = first_line(&format!("{directory}/head-name"))
                .map(|name| name.trim_start_matches("refs/heads/").to_string());
            return operation("rebase", branch);
        }
    }

    None
}

async fn prepare_git_lfs_inner(repo_path: String, paths: Vec<String>) -> GitResult<GitLfsPreparationResult> {
    let path = validate_repository_path(&repo_path)?;
    let sanitized_paths = sanitize_path_list(paths);
    let gitattributes_path = path.join(".gitattributes");

    if sanitized_paths.is_empty() {
        return Ok(GitLfsPreparationResult {
            transcript: "No staged paths needed git-lfs preparation.".to_string(),
            attributes_changed: false,
            tracked_patterns: Vec::new(),
        });
    }

    let candidates = sanitized_paths
        .iter()
        .filter_map(|relative_path| {
            let resolved = path.join(relative_path);
            let size = fs::metadata(&resolved).ok()?.len();
            if is_git_lfs_candidate_path(relative_path, size) {
                Some((relative_path.clone(), size))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if candidates.is_empty() {
        return Ok(GitLfsPreparationResult {
            transcript: "Staged paths are not large enough for git-lfs preparation.".to_string(),
            attributes_changed: false,
            tracked_patterns: Vec::new(),
        });
    }

    let mut transcript = Vec::new();
    transcript.push(format!("Detected {} git-lfs candidate file(s).", candidates.len()));
    transcript.push("Running `git lfs install --local` to initialize repository hooks.".to_string());
    run_git_owned(path, vec!["lfs".into(), "install".into(), "--local".into()]).await?;

    let tracked_patterns = candidates
        .iter()
        .map(|(relative_path, size)| {
            transcript.push(format!("Tracking {relative_path} via git-lfs ({size} bytes)."));
            relative_path.clone()
        })
        .collect::<Vec<_>>();

    if !tracked_patterns.is_empty() {
        for chunk in split_git_path_argument_batches(&tracked_patterns) {
            let mut track_args = vec!["lfs".into(), "track".into()];
            track_args.extend(chunk.iter().cloned());
            run_git_owned(path, track_args).await?;
        }

        if gitattributes_path.exists() {
            run_git_owned(path, vec!["add".into(), ".gitattributes".into()]).await?;
        }
    }

    let attributes_changed = gitattributes_path.exists();

    if attributes_changed {
        transcript.push("Updated .gitattributes for git-lfs tracking.".to_string());
    }

    Ok(GitLfsPreparationResult {
        transcript: transcript.join("\n"),
        attributes_changed,
        tracked_patterns,
    })
}

fn enrich_file_changes_with_sizes(repo_root: &Path, files: Vec<FileChange>) -> Vec<FileChange> {
    files
        .into_iter()
        .map(|mut file| {
            file.file_size_bytes = resolve_file_size_bytes(repo_root, &file.path);
            file
        })
        .collect()
}

fn resolve_file_size_bytes(repo_root: &Path, relative_path: &str) -> Option<u64> {
    let resolved = repo_root.join(relative_path);
    fs::metadata(resolved).ok().map(|metadata| metadata.len())
}

fn is_git_lfs_candidate_path(relative_path: &str, size_bytes: u64) -> bool {
    if size_bytes >= LARGE_LFS_TRACK_BYTES {
        return true;
    }

    let extension = Path::new(relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    matches!(
        extension.as_str(),
        "psd" | "fbx" | "blend" | "glb" | "gltf" | "png" | "jpg" | "jpeg" | "tga" | "exr" | "bmp"
    )
}

async fn inspect_repository_config_inner(repo_path: String) -> GitResult<RepositoryConfig> {
    let path = validate_repository_path(&repo_path)?;
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1", "-z", "--untracked-files=no"])
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

    let mut private_keys = match ssh_directory.as_ref() {
        Some(path) => discover_private_key_options(path),
        None => Vec::new(),
    };
    merge_config_identity_key_options(&mut private_keys, &config_hosts);

    Ok(RepositorySshDiscovery {
        ssh_directory: ssh_directory.map(|path| path.to_string_lossy().into_owned()),
        user_config_path: user_config_path.map(|path| path.to_string_lossy().into_owned()),
        config_hosts,
        private_keys,
        open_ssh_command: find_openssh_executable()
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
        None => {
            if matches!(file_name, "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa" | "identity") {
                return true;
            }

            fs::read(path)
                .ok()
                .map(|content| {
                    let sample = String::from_utf8_lossy(&content[..content.len().min(256)]).to_ascii_uppercase();
                    sample.contains("PRIVATE KEY")
                })
                .unwrap_or(false)
        }
    }
}

fn merge_config_identity_key_options(
    private_keys: &mut Vec<RepositorySshKeyOption>,
    config_hosts: &[RepositorySshConfigHost],
) {
    let mut deduped = BTreeMap::new();

    for key in private_keys.iter().cloned() {
        deduped.insert(normalize_private_key_option_key(&key.path), key);
    }

    for host in config_hosts {
        for identity_file in &host.identity_files {
            let path = PathBuf::from(identity_file);
            if !path.is_file() {
                continue;
            }

            let path_string = path.to_string_lossy().into_owned();
            let key_kind = if path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("ppk"))
            {
                "putty"
            } else {
                "openssh"
            };

            deduped.entry(normalize_private_key_option_key(&path_string)).or_insert_with(|| RepositorySshKeyOption {
                label: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(&path_string)
                    .to_string(),
                path: path_string,
                key_kind: key_kind.to_string(),
            });
        }
    }

    *private_keys = deduped.into_values().collect();
    private_keys.sort_by(|left, right| left.label.cmp(&right.label));
}

fn normalize_private_key_option_key(path: &str) -> String {
    if cfg!(windows) {
        path.replace('\\', "/").to_ascii_lowercase()
    } else {
        path.to_string()
    }
}

fn to_git_shell_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
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

/// Windows' own OpenSSH is preferred over whatever `ssh.exe` comes first on PATH: only it
/// talks to the Windows ssh-agent service, where passphrase-protected keys are usually loaded.
/// Git's bundled ssh (first on PATH when started from Git Bash) cannot see those keys, so git
/// and git-lfs failed with "Permission denied (publickey)".
fn find_openssh_executable() -> Option<PathBuf> {
    let system_openssh = PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh.exe");
    if cfg!(windows) && system_openssh.is_file() {
        return Some(system_openssh);
    }

    find_executable_path("ssh.exe", &[]).or_else(|| find_executable_path("ssh", &[]))
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

    if settings.mode == "auto" && !has_overrides && !settings.use_user_ssh_config {
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
        env_pairs.push(("GIT_SSH_COMMAND".to_string(), to_git_shell_path(&wrapper_path)));
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

    let executable = find_openssh_executable()
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
    env_pairs.push(("GIT_SSH_COMMAND".to_string(), to_git_shell_path(&wrapper_path)));

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
            literal_pathspec(trimmed_path),
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
    let (current_user_name, current_user_email) = resolve_git_user_identity(path).await;
    let created_remote_refs = resolve_remote_refs_created_by_current_user(
        path,
        current_user_name.as_deref(),
        current_user_email.as_deref(),
    )
    .await?;
    let output = run_git_owned(
        path,
        vec![
            "for-each-ref".into(),
            "--sort=-committerdate".into(),
            "--format=%(refname)	%(refname:short)	%(objectname:short)	%(subject)	%(upstream:short)	%(upstream:trackshort)	%(upstream:track,nobracket)	%(HEAD)	%(authorname)	%(authoremail:trim)".into(),
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
            let tracking_detail = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let is_current = parts.next().unwrap_or_default().trim() == "*";
            let author_name = parts.next().unwrap_or_default().trim().to_string();
            let author_email = parts.next().unwrap_or_default().trim().to_string();
            let (ahead_count, behind_count) = tracking_detail
                .as_deref()
                .map(parse_tracking_counts)
                .unwrap_or((0, 0));

            let (branch_kind, remote_name) = if let Some(rest) = full_name.strip_prefix("refs/remotes/") {
                let remote = rest.split('/').next().map(ToString::to_string);
                ("remote".to_string(), remote)
            } else {
                ("local".to_string(), None)
            };

            let is_owned_by_me = branch_matches_current_user(
                &author_name,
                &author_email,
                current_user_name.as_deref(),
                current_user_email.as_deref(),
            );
            let is_created_by_me = if branch_kind == "remote" {
                created_remote_refs.contains(full_name.as_str())
            } else {
                tracking_name
                    .as_deref()
                    .map(|tracking| format!("refs/remotes/{tracking}"))
                    .map(|tracking_ref| created_remote_refs.contains(tracking_ref.as_str()))
                    .unwrap_or(false)
            };

            Some(BranchEntry {
                full_name,
                name,
                branch_kind,
                remote_name,
                tracking_name,
                tracking_state,
                ahead_count,
                behind_count,
                is_current,
                is_owned_by_me,
                is_created_by_me,
                commit_hash,
                subject,
            })
        })
        .collect())
}

async fn resolve_git_user_identity(repo_path: &Path) -> (Option<String>, Option<String>) {
    let user_name = run_git_owned(
        repo_path,
        vec!["config".into(), "--get".into(), "user.name".into()],
    )
    .await
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    let user_email = run_git_owned(
        repo_path,
        vec!["config".into(), "--get".into(), "user.email".into()],
    )
    .await
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    (user_name, user_email)
}

fn branch_matches_current_user(
    author_name: &str,
    author_email: &str,
    current_user_name: Option<&str>,
    current_user_email: Option<&str>,
) -> bool {
    let normalized_author_email = author_email.trim().to_ascii_lowercase();
    let normalized_current_email = current_user_email
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    if let Some(email) = normalized_current_email.as_deref() {
        if !normalized_author_email.is_empty() && normalized_author_email == email {
            return true;
        }
    }

    let normalized_author_name = author_name.trim().to_ascii_lowercase();
    let normalized_current_name = current_user_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());

    matches!(normalized_current_name.as_deref(), Some(name) if !normalized_author_name.is_empty() && normalized_author_name == name)
}

async fn resolve_remote_refs_created_by_current_user(
    repo_path: &Path,
    current_user_name: Option<&str>,
    current_user_email: Option<&str>,
) -> GitResult<std::collections::HashSet<String>> {
    if current_user_name.is_none() && current_user_email.is_none() {
        return Ok(std::collections::HashSet::new());
    }

    let output = run_git_owned(
        repo_path,
        vec![
            "log".into(),
            "-g".into(),
            "--all".into(),
            "--max-count=2000".into(),
            "--format=%gD%x1f%gs%x1f%gN%x1f%gE".into(),
        ],
    )
    .await?;

    let mut oldest_remote_entries = std::collections::BTreeMap::<String, (String, String, String)>::new();

    for line in output.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.splitn(4, '\u{1f}');
        let selector = match parts.next() {
            Some(value) => value.trim(),
            None => continue,
        };
        let message = parts.next().unwrap_or_default().trim().to_string();
        let actor_name = parts.next().unwrap_or_default().trim().to_string();
        let actor_email = parts.next().unwrap_or_default().trim().to_string();
        let reference = selector.split("@{").next().unwrap_or(selector).trim();

        if !reference.starts_with("refs/remotes/") || reference.ends_with("/HEAD") {
            continue;
        }

        oldest_remote_entries.insert(reference.to_string(), (message, actor_name, actor_email));
    }

    Ok(oldest_remote_entries
        .into_iter()
        .filter_map(|(reference, (message, actor_name, actor_email))| {
            let normalized_message = message.trim().to_ascii_lowercase();
            if normalized_message != "update by push" {
                return None;
            }

            if branch_matches_current_user(
                &actor_name,
                &actor_email,
                current_user_name,
                current_user_email,
            ) {
                return Some(reference);
            }

            None
        })
        .collect())
}

async fn list_stashes_inner(repo_path: String) -> GitResult<Vec<StashEntry>> {
    let path = validate_repository_path(&repo_path)?;
    let output = run_git_owned(
        path,
        vec![
            "stash".into(),
            "list".into(),
            "--date=iso-strict".into(),
            "--format=%gd%x1f%h%x1f%aI%x1f%gs".into(),
        ],
    )
    .await?;

    Ok(output
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }

            let mut parts = trimmed.splitn(4, '\u{1f}');
            let reference = parts.next()?.trim().to_string();
            let short_hash = parts.next().unwrap_or_default().trim().to_string();
            let created_at = parts.next().unwrap_or_default().trim().to_string();
            let message = parts.next().unwrap_or_default().trim().to_string();

            Some(StashEntry {
                reference,
                short_hash,
                created_at,
                message,
            })
        })
        .collect())
}

fn parse_tracking_counts(value: &str) -> (usize, usize) {
    let mut ahead = 0;
    let mut behind = 0;

    for segment in value.split(',').map(str::trim) {
        if let Some(raw) = segment.strip_prefix("ahead ") {
            ahead = raw.parse::<usize>().unwrap_or(0);
        } else if let Some(raw) = segment.strip_prefix("behind ") {
            behind = raw.parse::<usize>().unwrap_or(0);
        }
    }

    (ahead, behind)
}

async fn list_commit_graph_inner(
    repo_path: String,
    limit: usize,
    skip: usize,
    graph_scope: Option<String>,
    graph_order: Option<String>,
) -> GitResult<CommitGraphPage> {
    let path = validate_repository_path(&repo_path)?;
    let page_limit = limit.clamp(40, 2_000);
    let format = "%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D";
    let scope = graph_scope.unwrap_or_else(|| "all".to_string());
    let order = graph_order.unwrap_or_else(|| "date".to_string());
    let mut args = vec!["log".into()];

    match scope.as_str() {
        "current" => {}
        "local" => {
            args.push("--branches".into());
        }
        _ => {
            args.push("--branches".into());
            args.push("--remotes".into());
        }
    }

    match order.as_str() {
        "topo" => args.push("--topo-order".into()),
        "author-date" => args.push("--author-date-order".into()),
        _ => args.push("--date-order".into()),
    }

    args.push(format!("--max-count={}", page_limit + 1));
    args.push(format!("--skip={skip}"));
    args.push("--date=iso-strict".into());
    args.push(format!("--pretty=format:{format}"));

    let log_output = run_git_owned(
        path,
        args,
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
        "--refs=refs/remotes/*".to_string(),
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
    let relative_path = relative_path.replace('\\', "/");
    let stays_inside_repo = !Path::new(&relative_path)
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)));

    // A file deleted from the working tree is still worth previewing from the index or HEAD.
    let resolved_path = match resolve_repo_file(repo_root, &relative_path) {
        Ok(path) => Some(path),
        Err(_) if stays_inside_repo && !repo_root.join(&relative_path).exists() => None,
        Err(error) => return Err(error),
    };

    let (file_size_bytes, modified_at, head_bytes) = match resolved_path.as_ref() {
        Some(path) => {
            let metadata = fs::metadata(path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            if !metadata.is_file() {
                return Err(GitServiceError::InvalidFileSelection);
            }

            let mut head = Vec::new();
            fs::File::open(path)
                .and_then(|file| file.take(MAX_PREVIEW_READ_BYTES).read_to_end(&mut head))
                .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                .map(|value| value.as_secs());
            (metadata.len(), modified_at, head)
        }
        None => {
            let staged = git_show_optional_bytes(repo_root, format!(":{relative_path}"), &relative_path).await?;
            let blob = match staged {
                Some(blob) => Some(blob),
                None => git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}"), &relative_path).await?,
            };
            let Some(blob) = blob else {
                return Err(GitServiceError::InvalidFileSelection);
            };
            (blob.len() as u64, None, blob)
        }
    };
    let missing_from_disk = resolved_path.is_none();
    let resolved_path = resolved_path.as_deref();

    let extension = Path::new(&relative_path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file_name = Path::new(&relative_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("file")
        .to_string();
    let mime_type = infer_mime_type(&extension);
    let text_excerpt_of = |bytes: &[u8]| String::from_utf8_lossy(&bytes[..bytes.len().min(12_000)]).to_string();

    let unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
    let staged_diff = git_diff(repo_root, &relative_path, true).await?;
    let mut text_excerpt = None;
    let mut asset_summary = None;
    let mut image_sources = Vec::new();
    let mut unity_material_sources = Vec::new();
    let mut model_sources = Vec::new();
    // Compare presets only need the source keys, whatever the asset type.
    let presets_for = |keys: Vec<&String>| {
        build_image_comparison_presets(
            &keys
                .into_iter()
                .map(|key| ImagePreviewSource {
                    key: key.clone(),
                    label: String::new(),
                    source_kind: key.clone(),
                    mime_type: String::new(),
                    byte_size: 0,
                    encoded_bytes_base64: String::new(),
                    is_psd: false,
                    format: String::new(),
                })
                .collect::<Vec<_>>(),
            staged_diff.is_some(),
            unstaged_diff.is_some(),
        )
    };

    let preview_kind = if extension == "mat" {
        text_excerpt = Some(text_excerpt_of(&head_bytes));
        unity_material_sources = collect_unity_material_preview_sources(repo_root, resolved_path, &relative_path).await?;
        asset_summary = unity_material_sources.first().map(build_unity_material_asset_summary);
        if unity_material_sources.is_empty() { "text" } else { "material" }
    } else if is_previewable_model_extension(&extension) {
        model_sources = collect_model_preview_sources(repo_root, resolved_path, &relative_path, &extension, mime_type).await?;
        asset_summary = build_asset_summary(&head_bytes, &extension);
        if model_sources.is_empty() { "asset" } else { "model" }
    } else if is_previewable_image_extension(&extension) {
        asset_summary = build_asset_summary(&head_bytes, &extension);
        image_sources = collect_image_preview_sources(repo_root, resolved_path, &relative_path, &extension, mime_type).await?;
        "image"
    } else if is_text_extension(&extension) || looks_like_text(&head_bytes) {
        text_excerpt = Some(text_excerpt_of(&head_bytes));
        "text"
    } else if is_known_asset_extension(&extension) {
        asset_summary = build_asset_summary(&head_bytes, &extension);
        "asset"
    } else {
        "binary"
    }
    .to_string();

    let image_comparison_presets = presets_for(image_sources.iter().map(|source| &source.key).collect());
    let unity_material_comparison_presets = presets_for(unity_material_sources.iter().map(|source| &source.key).collect());
    let model_comparison_presets = presets_for(model_sources.iter().map(|source| &source.key).collect());

    // Unity keeps importer settings for every asset in a sibling .meta file.
    let import_settings = resolved_path
        .and_then(|path| fs::read_to_string(format!("{}.meta", path.display())).ok())
        .and_then(|meta| parse_unity_meta_summary(&meta));
    let lfs_tracked = run_git_owned(repo_root, vec!["check-attr".into(), "filter".into(), "--".into(), relative_path.clone()])
        .await
        .is_ok_and(|output| output.trim_end().ends_with("filter: lfs"));

    let upper_extension = extension.to_ascii_uppercase();
    let mut support_hint = match preview_kind.as_str() {
        "image" if image_sources.is_empty() => format!(
            "This image is too large to preview inline (limit {} MB).",
            MAX_INLINE_IMAGE_BYTES / 1024 / 1024
        ),
        "image" => "Ctrl + scroll to zoom, drag to pan, double-click to reset.".to_string(),
        "material" => "Drag to rotate, Ctrl + scroll to zoom, double-click to reset.".to_string(),
        "model" => "Drag to orbit, Ctrl + scroll to zoom, double-click to reset.".to_string(),
        "text" => "Text preview.".to_string(),
        "asset" if is_previewable_model_extension(&extension) => format!(
            "This model is too large to preview inline (limit {} MB).",
            MAX_INLINE_MODEL_BYTES / 1024 / 1024
        ),
        "asset" => format!("There is no built-in viewer for {upper_extension} files; the details below are read from the file itself."),
        _ => "Binary file. No preview is available for this format.".to_string(),
    };
    if missing_from_disk {
        support_hint = format!("Deleted from the working tree; showing the last version git has. {support_hint}");
    }

    Ok(FilePreview {
        relative_path,
        file_name,
        extension,
        preview_kind,
        mime_type: mime_type.to_string(),
        file_size_bytes,
        modified_at,
        image_data_url: None,
        text_excerpt,
        staged_diff,
        unstaged_diff,
        asset_summary,
        import_settings,
        lfs_tracked,
        missing_from_disk,
        default_image_comparison_preset_key: image_comparison_presets.first().map(|preset| preset.key.clone()),
        image_sources,
        image_comparison_presets,
        default_unity_material_comparison_preset_key: unity_material_comparison_presets.first().map(|preset| preset.key.clone()),
        unity_material_sources,
        unity_material_comparison_presets,
        default_model_comparison_preset_key: model_comparison_presets.first().map(|preset| preset.key.clone()),
        model_sources,
        model_comparison_presets,
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
        args.extend(literal_pathspecs(&diffable_staged_files));
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
            literal_pathspec(trimmed_path),
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
            literal_pathspec(trimmed_path),
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
    let normalized_paths = sanitize_path_list(paths);

    if normalized_paths.is_empty() {
        return Ok(());
    }

    let args: Vec<String> = if unstage {
        vec![
            "reset".into(),
            "--pathspec-from-file=-".into(),
            "--pathspec-file-nul".into(),
            "HEAD".into(),
        ]
    } else {
        vec![
            "add".into(),
            "--pathspec-from-file=-".into(),
            "--pathspec-file-nul".into(),
        ]
    };

    run_git_owned_with_input(path, args, encode_pathspec_input(&normalized_paths))
        .await
        .map(|_| ())
}

/// Marks a path so git matches it byte-for-byte. Unmarked, `[`, `]`, `*`, `?` and a leading
/// `:` are pathspec magic, and a file such as "Enemy [Variant].prefab" fails to stage with
/// "pathspec did not match any files". Done per path rather than via GIT_LITERAL_PATHSPECS
/// because that variable leaks into hooks and breaks `git stash --include-untracked`.
fn literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

fn literal_pathspecs(paths: &[String]) -> Vec<String> {
    paths.iter().map(|path| literal_pathspec(path)).collect()
}

fn encode_pathspec_input(paths: &[String]) -> Vec<u8> {
    let mut bytes = Vec::new();

    for path in paths {
        bytes.extend_from_slice(literal_pathspec(path).as_bytes());
        bytes.push(0);
    }

    bytes
}

async fn discard_paths_inner(repo_path: String, paths: Vec<String>) -> GitResult<()> {
    let path = validate_repository_path(&repo_path)?;
    let normalized_paths = sanitize_path_list(paths);

    if normalized_paths.is_empty() {
        return Ok(());
    }

    let mut untracked_output = String::new();
    for chunk in split_git_path_argument_batches(&normalized_paths) {
        let output = run_git_owned(
            path,
            {
                let mut args = vec!["ls-files".into(), "--others".into(), "--exclude-standard".into(), "--".into()];
                args.extend(literal_pathspecs(chunk));
                args
            },
        )
        .await?;

        if !untracked_output.is_empty() && !output.is_empty() && !untracked_output.ends_with('\n') {
            untracked_output.push('\n');
        }
        untracked_output.push_str(&output);
    }

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
        for chunk in split_git_path_argument_batches(&tracked_paths) {
            let mut restore_args = vec![
                "restore".into(),
                "--source=HEAD".into(),
                "--staged".into(),
                "--worktree".into(),
                "--".into(),
            ];
            restore_args.extend(literal_pathspecs(chunk));
            run_git_owned(path, restore_args).await?;
        }
    }

    if !untracked_paths.is_empty() {
        let untracked_paths = untracked_paths.into_iter().collect::<Vec<_>>();
        for chunk in split_git_path_argument_batches(&untracked_paths) {
            let mut clean_args = vec!["clean".into(), "-fd".into(), "--".into()];
            clean_args.extend(literal_pathspecs(chunk));
            run_git_owned(path, clean_args).await?;
        }
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

    run_git_remote_owned(path, args).await?;

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

async fn stash_paths_inner(repo_path: String, paths: Vec<String>) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let sanitized_paths = sanitize_path_list(paths);

    if sanitized_paths.is_empty() {
        return Err(GitServiceError::GitCommandFailed("No stash paths were provided.".to_string()));
    }

    let mut args = vec![
        "stash".into(),
        "push".into(),
        "--include-untracked".into(),
        "-m".into(),
        format!(
            "UniGit selected changes ({} path{})",
            sanitized_paths.len(),
            if sanitized_paths.len() == 1 { "" } else { "s" }
        ),
        "--".into(),
    ];
    args.extend(literal_pathspecs(&sanitized_paths));

    let output = run_git_owned(path, args).await?;
    let summary = output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            format!(
                "Stashed {} selected path{}.",
                sanitized_paths.len(),
                if sanitized_paths.len() == 1 { "" } else { "s" }
            )
        });

    Ok(summary)
}

async fn apply_stash_inner(repo_path: String, reference: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed = reference.trim();

    if trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Stash reference cannot be empty.".to_string()));
    }

    run_git_owned(
        path,
        vec!["stash".into(), "apply".into(), "--index".into(), trimmed.to_string()],
    )
    .await?;

    Ok(format!("Re-applied {trimmed}."))
}

async fn drop_stash_inner(repo_path: String, reference: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed = reference.trim();

    if trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Stash reference cannot be empty.".to_string()));
    }

    let output = run_git_owned(
        path,
        vec!["stash".into(), "drop".into(), trimmed.to_string()],
    )
    .await?;

    Ok(output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("Removed {trimmed}.")))
}

async fn detach_head_to_commit_inner(repo_path: String, commit_hash: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed = commit_hash.trim();

    if trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Commit hash cannot be empty.".to_string()));
    }

    let resolved = run_git_owned(
        path,
        vec!["rev-parse".into(), "--verify".into(), format!("{trimmed}^{{commit}}")],
    )
    .await?;
    let full_hash = resolved.trim().to_string();

    run_git_remote_owned(
        path,
        vec!["checkout".into(), "--detach".into(), full_hash.clone()],
    )
    .await?;

    let short_hash = run_git_owned(path, vec!["rev-parse".into(), "--short".into(), full_hash])
        .await
        .unwrap_or_else(|_| trimmed.to_string());

    Ok(format!("Detached HEAD at {}.", short_hash.trim()))
}

async fn cherry_pick_commit_inner(
    repo_path: String,
    commit_hash: String,
    mainline_parent: Option<usize>,
) -> GitResult<MergeBranchResult> {
    let path = validate_repository_path(&repo_path)?;
    let trimmed = commit_hash.trim();

    if trimmed.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Commit hash cannot be empty.".to_string()));
    }

    let resolved = run_git_owned(
        path,
        vec!["rev-parse".into(), "--verify".into(), format!("{trimmed}^{{commit}}")],
    )
    .await?;
    let full_hash = resolved.trim().to_string();

    let parent_line = run_git_owned(
        path,
        vec!["rev-list".into(), "--parents".into(), "-n".into(), "1".into(), full_hash.clone()],
    )
    .await?;
    let parent_count = parent_line.split_whitespace().count().saturating_sub(1);

    let selected_mainline = if parent_count > 1 {
        let mainline = mainline_parent.ok_or_else(|| {
            GitServiceError::GitCommandFailed(
                "Merge commits require a mainline parent. Choose a parent and try again.".to_string(),
            )
        })?;

        if mainline == 0 || mainline > parent_count {
            return Err(GitServiceError::GitCommandFailed(format!(
                "Mainline parent must be between 1 and {} for this merge commit.",
                parent_count
            )));
        }

        Some(mainline)
    } else {
        None
    };

    let short_hash = run_git_owned(path, vec!["rev-parse".into(), "--short".into(), full_hash.clone()])
        .await
        .unwrap_or_else(|_| trimmed.to_string());
    let mut args = vec!["cherry-pick".into()];

    if let Some(mainline) = selected_mainline {
        args.push("-m".into());
        args.push(mainline.to_string());
    }

    args.push(full_hash);

    let output = run_git_capture_owned(path, args).await?;
    let detail = combine_command_output(&output.stdout, &output.stderr);

    if output.success {
        return Ok(MergeBranchResult {
            status: "picked".to_string(),
            message: if detail.is_empty() {
                format!("Cherry-picked {} onto the current branch.", short_hash.trim())
            } else {
                detail
            },
            conflicted_files: Vec::new(),
        });
    }

    let conflicted_files = list_conflicted_files(path).await?;

    if !conflicted_files.is_empty() {
        return Ok(MergeBranchResult {
            status: "conflicts".to_string(),
            message: if detail.is_empty() {
                format!("Cherry-pick of {} produced conflicts.", short_hash.trim())
            } else {
                detail
            },
            conflicted_files,
        });
    }

    Err(GitServiceError::GitCommandFailed(if detail.is_empty() {
        format!("Cherry-pick of {} failed.", short_hash.trim())
    } else {
        detail
    }))
}

async fn switch_branch_to_target(repo_path: &Path, full_name: &str, force: bool) -> GitResult<String> {
    let trimmed = full_name.trim();

    if force {
        discard_all_local_state(repo_path).await?;
    }

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        run_git_remote_owned(repo_path, vec!["switch".into(), "--progress".into(), local_name.to_string()]).await?;
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
            run_git_remote_owned(repo_path, vec!["switch".into(), "--progress".into(), branch_name.clone()]).await?;
        } else {
            run_git_remote_owned(
                repo_path,
                vec![
                    "switch".into(),
                    "--progress".into(),
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
    delete_branch_reference(path, full_name.trim()).await
}

async fn delete_branch_reference(repo_path: &Path, full_name: &str) -> GitResult<String> {
    let trimmed = full_name.trim();

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        run_git_owned(repo_path, vec!["branch".into(), "-D".into(), local_name.to_string()]).await?;
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
            repo_path,
            vec!["push".into(), remote_name.to_string(), "--delete".into(), branch_name.clone()],
        )
        .await?;

        return Ok(format!("Deleted remote branch {remote_name}/{branch_name}."));
    }

    Err(GitServiceError::GitCommandFailed("Unsupported branch reference.".to_string()))
}

async fn hard_prune_local_branches_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    fetch_prune_tags(path).await?;

    let branches = list_branch_prune_candidates(path).await?;
    let remote_short_names = branches
        .iter()
        .filter(|branch| branch.branch_kind == "remote")
        .map(|branch| branch.name.clone())
        .collect::<std::collections::HashSet<_>>();
    let remote_comparable_names = branches
        .iter()
        .filter(|branch| branch.branch_kind == "remote")
        .map(|branch| branch.comparable_name.clone())
        .collect::<std::collections::HashSet<_>>();

    let stale_local_branches = branches
        .iter()
        .filter(|branch| branch.branch_kind == "local")
        .filter(|branch| {
            if let Some(tracking_name) = branch.tracking_name.as_deref() {
                !remote_short_names.contains(tracking_name)
            } else {
                !remote_comparable_names.contains(branch.comparable_name.as_str())
            }
        })
        .map(|branch| branch.name.clone())
        .collect::<Vec<_>>();

    if stale_local_branches.is_empty() {
        return Ok("Local hard prune found no local branches that were missing on the remote.".to_string());
    }

    let stale_set = stale_local_branches.iter().cloned().collect::<std::collections::HashSet<_>>();

    if let Some(current_branch_name) = branches
        .iter()
        .find(|branch| branch.branch_kind == "local" && branch.is_current)
        .map(|branch| branch.name.clone())
    {
        if stale_set.contains(current_branch_name.as_str()) {
            move_head_away_from_branch(path, &current_branch_name, &branches, &stale_set).await?;
        }
    }

    for branch_name in &stale_local_branches {
        force_delete_local_branch_ref(path, branch_name).await?;
    }

    Ok(format!(
        "Local hard prune removed {} local branch(es): {}.",
        stale_local_branches.len(),
        summarize_branch_names(&stale_local_branches)
    ))
}

async fn conditional_prune_branches_inner(repo_path: String, input: ConditionalBranchPruneInput) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    fetch_prune_tags(path).await?;

    let normalized = normalize_conditional_prune_input(input)?;
    let branches = list_branch_prune_candidates(path).await?;
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let protected_base_names = normalized
        .merged_into_branches
        .iter()
        .cloned()
        .collect::<std::collections::HashSet<_>>();
    let merge_base_refs = branches
        .iter()
        .filter(|branch| protected_base_names.contains(branch.comparable_name.as_str()))
        .map(|branch| branch.full_name.clone())
        .collect::<Vec<_>>();

    let mut local_matches = Vec::new();
    let mut remote_matches = Vec::new();

    for branch in &branches {
        if branch.branch_kind == "local" && branch.is_current {
            continue;
        }

        if protected_base_names.contains(branch.comparable_name.as_str()) {
            continue;
        }

        let branch_target = if branch.branch_kind == "local" {
            BranchPruneTarget::Local
        } else {
            BranchPruneTarget::Remote
        };

        if !matches_prune_target(normalized.target, branch_target) {
            continue;
        }

        if !branch_matches_non_merge_criteria(branch, &normalized, now_unix) {
            continue;
        }

        if !normalized.merged_into_branches.is_empty()
            && !branch_is_merged_into_any(path, branch, &merge_base_refs).await?
        {
            continue;
        }

        if branch.branch_kind == "local" {
            local_matches.push(branch.name.clone());
        } else {
            remote_matches.push(branch.full_name.clone());
        }
    }

    if local_matches.is_empty() && remote_matches.is_empty() {
        return Ok("Conditional prune matched no branches.".to_string());
    }

    let local_match_set = local_matches.iter().cloned().collect::<std::collections::HashSet<_>>();

    if !local_matches.is_empty() {
        if let Some(current_branch_name) = branches
            .iter()
            .find(|branch| branch.branch_kind == "local" && branch.is_current)
            .map(|branch| branch.name.clone())
        {
            if local_match_set.contains(current_branch_name.as_str()) {
                move_head_away_from_branch(path, &current_branch_name, &branches, &local_match_set).await?;
            }
        }
    }

    for branch_name in &local_matches {
        force_delete_local_branch_ref(path, branch_name).await?;
    }

    for full_name in &remote_matches {
        delete_branch_reference(path, full_name).await?;
    }

    let mut summary_parts = Vec::new();

    if !local_matches.is_empty() {
        summary_parts.push(format!(
            "removed {} local branch(es): {}",
            local_matches.len(),
            summarize_branch_names(&local_matches)
        ));
    }

    if !remote_matches.is_empty() {
        let remote_labels = remote_matches
            .iter()
            .map(|full_name| pretty_branch_label(full_name))
            .collect::<Vec<_>>();
        summary_parts.push(format!(
            "removed {} remote branch(es): {}",
            remote_matches.len(),
            summarize_branch_names(&remote_labels)
        ));
    }

    Ok(format!("Conditional prune {}.", summary_parts.join(" and ")))
}

async fn preview_merge_inner(repo_path: String, full_name: String) -> GitResult<MergePreview> {
    let path = validate_repository_path(&repo_path)?;
    let target = resolve_branch_specifier(full_name.trim())?;
    let target_label = pretty_branch_label(full_name.trim());
    let current_branch = current_local_branch_name(path)
        .await
        .unwrap_or_else(|_| "detached HEAD".to_string());

    let head_hash = run_git_owned(path, vec!["rev-parse".into(), "--verify".into(), "HEAD^{commit}".into()])
        .await?
        .trim()
        .to_string();
    let target_hash = run_git_owned(path, vec!["rev-parse".into(), "--verify".into(), format!("{target}^{{commit}}")])
        .await?
        .trim()
        .to_string();

    let merge_base_output = run_git_capture_owned(path, vec!["merge-base".into(), "HEAD".into(), target.clone()]).await?;
    let merge_base = merge_base_output.stdout.trim().to_string();
    let unrelated_histories = !merge_base_output.success || merge_base.is_empty();
    let up_to_date = !unrelated_histories && merge_base == target_hash;
    let fast_forward = !unrelated_histories && !up_to_date && merge_base == head_hash;

    let incoming_commits = run_git_owned(path, vec!["rev-list".into(), "--count".into(), format!("HEAD..{target}")])
        .await?
        .trim()
        .parse::<usize>()
        .unwrap_or(0);
    let incoming_subjects = run_git_owned(
        path,
        vec!["log".into(), "--format=%h %s".into(), "-n".into(), "8".into(), format!("HEAD..{target}")],
    )
    .await?
    .lines()
    .map(|line| line.trim().to_string())
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>();

    let changed_paths = if unrelated_histories {
        std::collections::HashSet::new()
    } else {
        run_git_owned(
            path,
            vec!["diff".into(), "--name-only".into(), "-z".into(), merge_base.clone(), target.clone()],
        )
        .await?
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(ToString::to_string)
        .collect::<std::collections::HashSet<_>>()
    };

    // `merge-tree --write-tree` (git 2.38+) performs the merge in memory: exit 0 is clean,
    // exit 1 lists the conflicted paths, anything else means it is unavailable.
    let predicted_conflicts = if up_to_date || fast_forward {
        Some(Vec::new())
    } else if unrelated_histories {
        None
    } else {
        let output = run_git_capture_owned(
            path,
            vec![
                "merge-tree".into(),
                "--write-tree".into(),
                "--name-only".into(),
                "-z".into(),
                "--no-messages".into(),
                "HEAD".into(),
                target.clone(),
            ],
        )
        .await?;
        let mut tokens = output.stdout.split('\0').filter(|entry| !entry.is_empty());
        let has_tree = tokens
            .next()
            .is_some_and(|oid| oid.len() >= 40 && oid.chars().all(|ch| ch.is_ascii_hexdigit()));

        if !has_tree {
            None
        } else if output.success {
            Some(Vec::new())
        } else {
            Some(
                tokens
                    .map(ToString::to_string)
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect(),
            )
        }
    };

    let status_output = run_git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
    let (_, _, _, _, local_files, _) = parse_status_output(&status_output);
    let overlapping_local_changes = local_files
        .iter()
        .filter(|file| changed_paths.contains(&file.path))
        .map(|file| file.path.clone())
        .collect::<Vec<_>>();

    Ok(MergePreview {
        target_label,
        current_branch,
        up_to_date,
        fast_forward,
        unrelated_histories,
        incoming_commits,
        incoming_subjects,
        changed_files: changed_paths.len(),
        predicted_conflicts,
        local_changes: local_files.len(),
        overlapping_local_changes,
        operation_in_progress: detect_repository_operation(path).map(|operation| operation.kind),
    })
}

async fn merge_branch_inner(
    repo_path: String,
    full_name: String,
    local_changes: String,
    conflict_preference: String,
) -> GitResult<MergeBranchResult> {
    let path = validate_repository_path(&repo_path)?;
    let target = resolve_branch_specifier(full_name.trim())?;
    let target_label = pretty_branch_label(full_name.trim());

    if let Some(operation) = detect_repository_operation(path) {
        return Err(GitServiceError::GitCommandFailed(format!(
            "A {} is already in progress ({}). Finish or abort it before starting another merge.",
            operation.kind, operation.label
        )));
    }

    let discard_local_changes = local_changes.trim() == "discard";
    if discard_local_changes {
        discard_all_local_state(path).await?;
    }

    let mut merge_args: Vec<String> = vec!["merge".into(), "--no-edit".into()];
    match conflict_preference.trim() {
        "ours" => merge_args.extend(["-X".to_string(), "ours".to_string()]),
        "theirs" => merge_args.extend(["-X".to_string(), "theirs".to_string()]),
        _ => {}
    }

    // `--autostash` shelves tracked local edits, merges, then puts them back (also after
    // the merge is completed or aborted later), so a dirty working tree no longer blocks.
    let mut first_args = merge_args.clone();
    if !discard_local_changes {
        first_args.push("--autostash".into());
    }
    first_args.push(target.clone());

    let mut output = run_git_capture_owned(path, first_args).await?;
    let mut detail = combine_command_output(&output.stdout, &output.stderr);
    let mut notes: Vec<String> = Vec::new();

    // Autostash does not cover untracked files. When one of those is in the way (typically a
    // locally generated .meta that the other branch committed), shelve everything and retry.
    if !output.success
        && !discard_local_changes
        && is_local_change_merge_block(&detail)
        && detect_repository_operation(path).is_none()
    {
        let stash_name = format!("UniGit: local changes before merging {target_label}");
        run_git_owned(
            path,
            vec!["stash".into(), "push".into(), "--include-untracked".into(), "-m".into(), stash_name.clone()],
        )
        .await?;

        let mut retry_args = merge_args.clone();
        retry_args.push(target.clone());
        output = run_git_capture_owned(path, retry_args).await?;
        detail = combine_command_output(&output.stdout, &output.stderr);

        let merge_pending = detect_repository_operation(path).is_some();
        if merge_pending {
            notes.push(format!(
                "Your local changes are parked in the stash \"{stash_name}\". Re-apply it from Stashes after finishing the merge."
            ));
        } else {
            let restore = run_git_capture_owned(path, vec!["stash".into(), "pop".into()]).await?;
            notes.push(if restore.success {
                "Your local changes were put back after the merge.".to_string()
            } else {
                format!(
                    "Some local changes could not be put back automatically and are kept in the stash \"{stash_name}\"."
                )
            });
        }
    }

    let with_notes = |message: String| {
        if notes.is_empty() {
            message
        } else {
            format!("{message}\n\n{}", notes.join("\n"))
        }
    };

    if output.success {
        return Ok(MergeBranchResult {
            status: "merged".to_string(),
            message: with_notes(if detail.is_empty() {
                format!("Merged {target_label} into the current branch.")
            } else {
                detail
            }),
            conflicted_files: Vec::new(),
        });
    }

    let conflicted_files = list_conflicted_files(path).await?;

    if !conflicted_files.is_empty() {
        return Ok(MergeBranchResult {
            status: "conflicts".to_string(),
            message: with_notes(format!(
                "Merging {target_label} needs your decision on {} file(s).",
                conflicted_files.len()
            )),
            conflicted_files,
        });
    }

    Err(GitServiceError::GitCommandFailed(with_notes(if detail.is_empty() {
        format!("Merge with {target_label} failed.")
    } else {
        detail
    })))
}

async fn abort_operation_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let Some(operation) = detect_repository_operation(path) else {
        return Err(GitServiceError::GitCommandFailed(
            "No merge, cherry-pick, revert or rebase is in progress.".to_string(),
        ));
    };

    run_git_owned(path, vec![operation.kind.clone(), "--abort".into()]).await?;

    Ok(format!(
        "Aborted the {}. The branch is back to where it was before it started.",
        operation.kind
    ))
}

async fn continue_operation_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let Some(operation) = detect_repository_operation(path) else {
        return Err(GitServiceError::GitCommandFailed(
            "No merge, cherry-pick, revert or rebase is in progress.".to_string(),
        ));
    };

    let remaining = list_conflicted_files(path).await?;
    if !remaining.is_empty() {
        return Err(GitServiceError::GitCommandFailed(format!(
            "{} file(s) still have unresolved conflicts. Resolve them before completing the {}.",
            remaining.len(),
            operation.kind
        )));
    }

    run_git_owned(path, vec![operation.kind.clone(), "--continue".into()]).await?;

    Ok(format!("Completed the {}.", operation.kind))
}

fn file_has_conflict_markers(file_path: &Path) -> bool {
    const MAX_MARKER_SCAN_BYTES: u64 = 8 * 1024 * 1024;

    let Ok(metadata) = fs::metadata(file_path) else {
        return false;
    };
    if metadata.len() > MAX_MARKER_SCAN_BYTES {
        return false;
    }

    let Ok(bytes) = fs::read(file_path) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes);
    text.lines().any(|line| line.starts_with("<<<<<<< ")) && text.lines().any(|line| line.starts_with(">>>>>>> "))
}

async fn resolve_conflicted_files_inner(repo_path: String, paths: Vec<String>, strategy: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let sanitized_paths = sanitize_path_list(paths);
    let strategy = strategy.trim();

    if sanitized_paths.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Choose at least one conflicted file to resolve.".to_string()));
    }

    if !matches!(strategy, "ours" | "theirs" | "manual") {
        return Err(GitServiceError::GitCommandFailed(
            "Conflict strategy must be 'ours', 'theirs' or 'manual'.".to_string(),
        ));
    }

    // Index stages per unmerged path: 1 = common ancestor, 2 = ours, 3 = theirs. A side that
    // deleted the file has no stage, which is why a plain `checkout --ours/--theirs` fails there.
    let mut stages = BTreeMap::<String, Vec<u8>>::new();
    for chunk in split_git_path_argument_batches(&sanitized_paths) {
        let mut args: Vec<String> = vec!["ls-files".into(), "-u".into(), "-z".into(), "--".into()];
        args.extend(literal_pathspecs(chunk));

        for entry in run_git_owned(path, args).await?.split('\0') {
            let Some((meta, file)) = entry.split_once('\t') else {
                continue;
            };
            let stage = meta.split_whitespace().nth(2).and_then(|value| value.parse::<u8>().ok()).unwrap_or(0);
            stages.entry(file.to_string()).or_default().push(stage);
        }
    }

    if stages.is_empty() {
        return Err(GitServiceError::GitCommandFailed(
            "None of the selected files are in conflict any more.".to_string(),
        ));
    }

    let run_for_paths = |base: Vec<&'static str>, files: Vec<String>| async move {
        for chunk in split_git_path_argument_batches(&files) {
            let mut args: Vec<String> = base.iter().map(|value| value.to_string()).collect();
            args.extend(literal_pathspecs(chunk));
            run_git_owned(path, args).await?;
        }
        GitResult::Ok(())
    };

    let resolved_count = stages.len();
    let label = match strategy {
        "manual" => {
            let unfinished = stages
                .keys()
                .filter(|file| file_has_conflict_markers(&path.join(file.as_str())))
                .cloned()
                .collect::<Vec<_>>();

            if !unfinished.is_empty() {
                return Err(GitServiceError::GitCommandFailed(format!(
                    "Conflict markers (<<<<<<<) are still present in: {}",
                    unfinished.join(", ")
                )));
            }

            run_for_paths(vec!["add", "--"], stages.into_keys().collect()).await?;
            "your edited version"
        }
        _ => {
            let (wanted_stage, checkout_flag) = if strategy == "ours" { (2u8, "--ours") } else { (3u8, "--theirs") };
            let (keep, remove): (Vec<_>, Vec<_>) = stages
                .into_iter()
                .partition(|(_, file_stages)| file_stages.contains(&wanted_stage));
            let keep = keep.into_iter().map(|(file, _)| file).collect::<Vec<_>>();
            let remove = remove.into_iter().map(|(file, _)| file).collect::<Vec<_>>();

            if !keep.is_empty() {
                run_for_paths(vec!["checkout", checkout_flag, "--"], keep.clone()).await?;
                run_for_paths(vec!["add", "--"], keep).await?;
            }

            // The chosen side deleted the file, so taking that side means removing it.
            if !remove.is_empty() {
                run_for_paths(vec!["rm", "-f", "-q", "--"], remove).await?;
            }

            if strategy == "ours" { "the current branch version" } else { "the incoming version" }
        }
    };

    let remaining = list_conflicted_files(path).await?;

    Ok(format!(
        "Resolved {resolved_count} file(s) using {label}. {} still in conflict.",
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
    let pull_args: Vec<String> = if ahead > 0 && behind > 0 {
        vec!["pull".into(), "--no-rebase".into()]
    } else {
        vec!["pull".into(), "--ff-only".into()]
    };
    let output = match run_git_remote_owned(path, pull_args).await {
        Ok(output) => output,
        // A diverged pull that stops on conflicts is a merge waiting for decisions, not a failure:
        // the snapshot reports the pending merge and the UI walks the user through it.
        Err(GitServiceError::GitCommandFailed(_)) if !list_conflicted_files(path).await.unwrap_or_default().is_empty() => {
            return Ok("Pull merged the remote changes, but some files conflict. Resolve them to finish the merge.".to_string());
        }
        Err(error) => return Err(error),
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

async fn pull_branch_inner(repo_path: String, full_name: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let branch_name = full_name
        .trim()
        .strip_prefix("refs/heads/")
        .ok_or_else(|| GitServiceError::GitCommandFailed("Only local branches can be pulled directly.".to_string()))?
        .trim()
        .to_string();

    if branch_name.is_empty() {
        return Err(GitServiceError::GitCommandFailed("Branch reference cannot be empty.".to_string()));
    }

    let current_branch = current_local_branch_name(path).await.ok();
    if current_branch.as_deref() == Some(branch_name.as_str()) {
        return pull_repository_inner(repo_path).await;
    }

    let upstream_short = run_git_owned(
        path,
        vec![
            "for-each-ref".into(),
            "--format=%(upstream:short)".into(),
            format!("refs/heads/{branch_name}"),
        ],
    )
    .await?
    .trim()
    .to_string();

    if upstream_short.is_empty() {
        return Err(GitServiceError::GitCommandFailed(format!(
            "No upstream branch is configured for {branch_name}."
        )));
    }

    let upstream_full = run_git_owned(
        path,
        vec![
            "for-each-ref".into(),
            "--format=%(upstream)".into(),
            format!("refs/heads/{branch_name}"),
        ],
    )
    .await?
    .trim()
    .to_string();

    let remote_name = upstream_short.split('/').next().unwrap_or_default().trim().to_string();
    if remote_name.is_empty() {
        return Err(GitServiceError::GitCommandFailed(format!(
            "Could not determine remote for upstream branch {upstream_short}."
        )));
    }

    let remote_branch_name = upstream_full
        .strip_prefix(&format!("refs/remotes/{remote_name}/"))
        .ok_or_else(|| GitServiceError::GitCommandFailed(format!(
            "Could not determine remote branch ref for {upstream_short}."
        )))?
        .trim()
        .to_string();

    let output = run_git_remote_owned(
        path,
        vec![
            "fetch".into(),
            remote_name.clone(),
            format!("+refs/heads/{remote_branch_name}:refs/remotes/{remote_name}/{remote_branch_name}"),
            format!("refs/heads/{remote_branch_name}:refs/heads/{branch_name}"),
        ],
    )
    .await?;

    let trimmed = output.trim();
    if trimmed.is_empty() {
        Ok(format!("Pulled {branch_name} from {upstream_short} without switching."))
    } else {
        Ok(format!("Pulled {branch_name} from {upstream_short} without switching.\n{trimmed}"))
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
    let merge_args = vec!["merge".into(), "--no-edit".into(), "-X".into(), "theirs".into(), upstream.clone()];
    let initial_merge = run_git_capture_owned(path, merge_args.clone()).await?;
    let initial_detail = combine_command_output(&initial_merge.stdout, &initial_merge.stderr);

    if initial_merge.success {
        let trimmed = initial_detail.trim();
        return Ok(if trimmed.is_empty() {
            format!("Force pull completed from {upstream}.")
        } else {
            trimmed.to_string()
        });
    }

    if !is_local_change_merge_block(initial_detail.as_str()) {
        return Err(GitServiceError::GitCommandFailed(if initial_detail.is_empty() {
            format!("Force pull from {upstream} failed.")
        } else {
            initial_detail
        }));
    }

    let discard_paths = {
        let overwrite_paths = extract_merge_overwrite_paths(&initial_detail);
        if overwrite_paths.is_empty() {
            list_upstream_touched_paths(path, &upstream).await?
        } else {
            overwrite_paths
        }
    };

    if !discard_paths.is_empty() {
        discard_paths_inner(repo_path.clone(), discard_paths.clone()).await?;
    }

    let retry_merge = run_git_capture_owned(path, merge_args).await?;
    let retry_detail = combine_command_output(&retry_merge.stdout, &retry_merge.stderr);

    if !retry_merge.success {
        return Err(GitServiceError::GitCommandFailed(if retry_detail.is_empty() {
            format!("Force pull from {upstream} failed after discarding local state.")
        } else {
            retry_detail
        }));
    }

    let trimmed = retry_detail.trim();
    Ok(if trimmed.is_empty() {
        format!(
            "Force pull completed from {upstream}. Discarded local state for {} merge-blocking path(s).",
            discard_paths.len()
        )
    } else {
        format!(
            "Force pull completed from {upstream}. Discarded local state for {} merge-blocking path(s).\n{}",
            discard_paths.len(),
            trimmed
        )
    })
}

async fn discard_all_local_state(repo_path: &Path) -> GitResult<()> {
    run_git_owned(repo_path, vec!["reset".into(), "--hard".into(), "HEAD".into()]).await?;
    run_git_owned(repo_path, vec!["clean".into(), "-fd".into()]).await?;
    Ok(())
}

async fn fetch_prune_tags(repo_path: &Path) -> GitResult<()> {
    run_git_remote_owned(repo_path, vec!["fetch".into(), "--prune".into(), "--tags".into()]).await?;
    Ok(())
}

async fn list_branch_prune_candidates(repo_path: &Path) -> GitResult<Vec<BranchPruneCandidate>> {
    let output = run_git_owned(
        repo_path,
        vec![
            "for-each-ref".into(),
            "--sort=-committerdate".into(),
            "--format=%(refname)\t%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(upstream:short)\t%(HEAD)".into(),
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

            let _commit_hash = parts.next().unwrap_or_default().trim().to_string();
            let committed_at_unix = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty() && *value != "0")
                .and_then(|value| value.parse::<u64>().ok());
            let tracking_name = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let is_current = parts.next().unwrap_or_default().trim() == "*";

            let (branch_kind, comparable_name) = if let Some(rest) = full_name.strip_prefix("refs/remotes/") {
                let mut segments = rest.split('/');
                let _remote_name = segments.next();
                let comparable_name = segments.collect::<Vec<_>>().join("/");
                ("remote".to_string(), comparable_name)
            } else {
                ("local".to_string(), name.clone())
            };

            Some(BranchPruneCandidate {
                full_name,
                name,
                branch_kind,
                tracking_name,
                is_current,
                comparable_name,
                committed_at_unix,
            })
        })
        .collect())
}

fn normalize_conditional_prune_input(input: ConditionalBranchPruneInput) -> GitResult<NormalizedConditionalBranchPruneInput> {
    let merged_into_branches = input
        .merged_into_branches
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let folder_prefixes = input
        .folder_prefixes
        .into_iter()
        .map(|value| value.trim().trim_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let regex_pattern = input
        .regex_pattern
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let regex = match regex_pattern {
        Some(pattern) => Some(Regex::new(&pattern).map_err(|error| GitServiceError::GitCommandFailed(format!("Regex pattern is invalid: {error}")))?),
        None => None,
    };
    let target = match input.target.trim() {
        "local" => BranchPruneTarget::Local,
        "remote" => BranchPruneTarget::Remote,
        "both" | "" => BranchPruneTarget::Both,
        _ => {
            return Err(GitServiceError::GitCommandFailed(
                "Conditional prune target must be local, remote, or both.".to_string(),
            ))
        }
    };
    let max_age_seconds = match (input.age_value, input.age_unit.as_deref().map(str::trim)) {
        (Some(value), Some("days")) if value > 0 => Some(value.saturating_mul(86_400)),
        (Some(value), Some("months")) if value > 0 => Some(value.saturating_mul(30 * 86_400)),
        (Some(value), Some("years")) if value > 0 => Some(value.saturating_mul(365 * 86_400)),
        (Some(_), Some(_)) => {
            return Err(GitServiceError::GitCommandFailed(
                "Conditional prune age unit must be days, months, or years.".to_string(),
            ))
        }
        _ => None,
    };

    if max_age_seconds.is_none() && merged_into_branches.is_empty() && folder_prefixes.is_empty() && regex.is_none() {
        return Err(GitServiceError::GitCommandFailed(
            "Choose at least one conditional prune rule before running it.".to_string(),
        ));
    }

    Ok(NormalizedConditionalBranchPruneInput {
        max_age_seconds,
        merged_into_branches,
        folder_prefixes,
        regex,
        target,
    })
}

fn matches_prune_target(selected_target: BranchPruneTarget, branch_target: BranchPruneTarget) -> bool {
    selected_target == BranchPruneTarget::Both || selected_target == branch_target
}

fn branch_matches_non_merge_criteria(
    branch: &BranchPruneCandidate,
    input: &NormalizedConditionalBranchPruneInput,
    now_unix: u64,
) -> bool {
    if let Some(max_age_seconds) = input.max_age_seconds {
        let Some(committed_at_unix) = branch.committed_at_unix else {
            return false;
        };

        if now_unix.saturating_sub(committed_at_unix) < max_age_seconds {
            return false;
        }
    }

    if !input.folder_prefixes.is_empty()
        && !input
            .folder_prefixes
            .iter()
            .any(|prefix| branch.comparable_name == *prefix || branch.comparable_name.starts_with(&format!("{prefix}/")))
    {
        return false;
    }

    if let Some(regex) = input.regex.as_ref() {
        if !regex.is_match(&branch.comparable_name) {
            return false;
        }
    }

    true
}

async fn branch_is_merged_into_any(repo_path: &Path, branch: &BranchPruneCandidate, merge_base_refs: &[String]) -> GitResult<bool> {
    if merge_base_refs.is_empty() {
        return Ok(false);
    }

    for base_ref in merge_base_refs {
        if base_ref == &branch.full_name {
            continue;
        }

        let output = run_git_capture_owned(
            repo_path,
            vec![
                "merge-base".into(),
                "--is-ancestor".into(),
                branch.full_name.clone(),
                base_ref.clone(),
            ],
        )
        .await?;

        if output.success {
            return Ok(true);
        }
    }

    Ok(false)
}

async fn move_head_away_from_branch(
    repo_path: &Path,
    current_branch_name: &str,
    branches: &[BranchPruneCandidate],
    deleting_local_branches: &std::collections::HashSet<String>,
) -> GitResult<()> {
    let _ = discard_all_local_state(repo_path).await;

    if let Ok(commit_hash) = run_git_owned(
        repo_path,
        vec!["rev-parse".into(), "--verify".into(), format!("refs/heads/{current_branch_name}")],
    )
    .await
    {
        let trimmed = commit_hash.trim();
        if !trimmed.is_empty()
            && run_git_owned(
                repo_path,
                vec!["checkout".into(), "--detach".into(), "-f".into(), trimmed.to_string()],
            )
            .await
            .is_ok()
        {
            return Ok(());
        }
    }

    if let Some(fallback_branch) = choose_fallback_local_branch(branches, deleting_local_branches, current_branch_name) {
        if run_git_owned(repo_path, vec!["checkout".into(), "-f".into(), fallback_branch.clone()]).await.is_ok() {
            return Ok(());
        }

        run_git_owned(
            repo_path,
            vec!["symbolic-ref".into(), "HEAD".into(), format!("refs/heads/{fallback_branch}")],
        )
        .await?;

        return Ok(());
    }

    Err(GitServiceError::GitCommandFailed(format!(
        "Could not move HEAD away from {current_branch_name} before pruning it."
    )))
}

fn choose_fallback_local_branch(
    branches: &[BranchPruneCandidate],
    deleting_local_branches: &std::collections::HashSet<String>,
    current_branch_name: &str,
) -> Option<String> {
    for preferred in ["main", "master", "dev"] {
        if preferred != current_branch_name
            && branches.iter().any(|branch| {
                branch.branch_kind == "local"
                    && branch.name == preferred
                    && !deleting_local_branches.contains(branch.name.as_str())
            })
        {
            return Some(preferred.to_string());
        }
    }

    branches
        .iter()
        .find(|branch| {
            branch.branch_kind == "local"
                && branch.name != current_branch_name
                && !deleting_local_branches.contains(branch.name.as_str())
        })
        .map(|branch| branch.name.clone())
}

async fn force_delete_local_branch_ref(repo_path: &Path, local_name: &str) -> GitResult<()> {
    let full_ref = format!("refs/heads/{local_name}");

    if run_git_owned(repo_path, vec!["update-ref".into(), "-d".into(), full_ref]).await.is_ok() {
        return Ok(());
    }

    run_git_owned(repo_path, vec!["branch".into(), "-D".into(), local_name.to_string()]).await?;
    Ok(())
}

fn summarize_branch_names(names: &[String]) -> String {
    let sample = names.iter().take(6).cloned().collect::<Vec<_>>();

    if names.len() > sample.len() {
        format!("{} and {} more", sample.join(", "), names.len() - sample.len())
    } else {
        sample.join(", ")
    }
}

async fn list_conflicted_files(repo_path: &Path) -> GitResult<Vec<String>> {
    let output = run_git_owned(
        repo_path,
        vec!["diff".into(), "--name-only".into(), "-z".into(), "--diff-filter=U".into()],
    )
    .await?;

    Ok(output
        .split('\0')
        .filter(|entry| !entry.is_empty())
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

fn extract_merge_overwrite_paths(message: &str) -> Vec<String> {
    let normalized = message.to_lowercase();
    let Some(start_index) = normalized.find("would be overwritten by merge") else {
        return Vec::new();
    };

    let mut collecting = false;
    let mut paths = Vec::new();

    for line in message[start_index..].lines().skip(1) {
        let trimmed = line.trim();

        if trimmed.is_empty() {
            if collecting {
                break;
            }

            continue;
        }

        let lowered = trimmed.to_lowercase();
        if lowered.starts_with("please commit your changes")
            || lowered == "aborting"
            || lowered.starts_with("updating ")
            || lowered.starts_with("merge with strategy")
        {
            break;
        }

        collecting = true;
        paths.push(trimmed.to_string());
    }

    sanitize_path_list(paths)
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
        let trimmed = decode_porcelain_path(path.trim()).replace('\\', "/");
        if !trimmed.is_empty() {
            unique.insert(trimmed);
        }
    }

    unique.into_iter().collect()
}

fn split_git_path_argument_batches(paths: &[String]) -> Vec<&[String]> {
    const MAX_GIT_PATH_ARGUMENT_BYTES: usize = 24 * 1024;
    const MAX_GIT_PATH_ARGUMENT_COUNT: usize = 256;

    let mut batches = Vec::new();
    let mut start = 0;
    let mut current_bytes = 0;
    let mut current_count = 0;

    for (index, path) in paths.iter().enumerate() {
        let path_bytes = path.len() + 1;
        let should_split = current_count > 0
            && (current_bytes + path_bytes > MAX_GIT_PATH_ARGUMENT_BYTES
                || current_count >= MAX_GIT_PATH_ARGUMENT_COUNT);

        if should_split {
            batches.push(&paths[start..index]);
            start = index;
            current_bytes = 0;
            current_count = 0;
        }

        current_bytes += path_bytes;
        current_count += 1;
    }

    if start < paths.len() {
        batches.push(&paths[start..]);
    }

    batches
}

fn decode_porcelain_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() < 2 || !trimmed.starts_with('"') || !trimmed.ends_with('"') {
        return trimmed.to_string();
    }

    // Git escapes non-ASCII names one UTF-8 *byte* per octal escape ("\303\247" is "ç"),
    // so the escapes have to be collected as bytes and decoded together.
    let inner = &trimmed[1..trimmed.len() - 1];
    let mut decoded = Vec::<u8>::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    let mut utf8 = [0u8; 4];

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.extend_from_slice(ch.encode_utf8(&mut utf8).as_bytes());
            continue;
        }

        match chars.next() {
            Some('\\') => decoded.push(b'\\'),
            Some('"') => decoded.push(b'"'),
            Some('n') => decoded.push(b'\n'),
            Some('r') => decoded.push(b'\r'),
            Some('t') => decoded.push(b'\t'),
            Some(octal @ '0'..='7') => {
                let mut value = octal.to_digit(8).unwrap_or(0);

                for _ in 0..2 {
                    let Some(next) = chars.peek().copied() else {
                        break;
                    };

                    if !matches!(next, '0'..='7') {
                        break;
                    }

                    chars.next();
                    value = value * 8 + next.to_digit(8).unwrap_or(0);
                }

                decoded.push(value as u8);
            }
            Some(other) => {
                decoded.push(b'\\');
                decoded.extend_from_slice(other.encode_utf8(&mut utf8).as_bytes());
            }
            None => decoded.push(b'\\'),
        }
    }

    String::from_utf8_lossy(&decoded).into_owned()
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
    args.push(literal_pathspec(relative_path));

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

    let mut command = git_command(None);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(None, &args), None)
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

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(value) = overrides.as_ref() {
        for (key, env_value) in &value.env_pairs {
            command.env(key, env_value);
        }
    }

    let output = match activity::execute(command, activity::describe(Some(repo_path), &args), None).await {
        Ok(output) => output,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                return Err(GitServiceError::GitUnavailable);
            }

            let message = error.to_string();
            if should_retry_with_longpaths_fix(&message) && ensure_git_longpaths(repo_path).await? {
                let _ = append_log(
                    "backend",
                    "git.command.retry",
                    &format!("git -C {repo_display} {command_preview}"),
                    Some("Enabled core.longpaths=true after Windows path-length launch failure; retrying command."),
                );

                return rerun_git_owned_with_env(repo_path, args, overrides).await;
            }

            return Err(GitServiceError::GitCommandFailed(message));
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if should_retry_with_safe_directory_fix(&stderr) && ensure_git_safe_directory(repo_path).await? {
            let _ = append_log(
                "backend",
                "git.command.retry",
                &format!("git -C {repo_display} {command_preview}"),
                Some("Added repository to git safe.directory after dubious ownership error; retrying command."),
            );

            return rerun_git_owned_with_env(repo_path, args, overrides).await;
        }

        if should_retry_with_longpaths_fix(&stderr) && ensure_git_longpaths(repo_path).await? {
            let _ = append_log(
                "backend",
                "git.command.retry",
                &format!("git -C {repo_display} {command_preview}"),
                Some("Enabled core.longpaths=true after Windows path-length failure; retrying command."),
            );

            return rerun_git_owned_with_env(repo_path, args, overrides).await;
        }
    }

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

async fn rerun_git_owned_with_env(
    repo_path: &Path,
    args: Vec<String>,
    overrides: Option<GitRemoteEnvironment>,
) -> GitResult<String> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(value) = overrides {
        for (key, env_value) in value.env_pairs {
            command.env(key, env_value);
        }
    }

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), None).await.map_err(|error| match error.kind() {
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
        return Err(GitServiceError::GitCommandFailed(stderr));
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

fn should_retry_with_longpaths_fix(stderr: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }

    let normalized = stderr.to_lowercase();
    normalized.contains("os error 206")
        || normalized.contains("dateiname oder die erweiterung ist zu lang")
        || normalized.contains("filename too long")
        || normalized.contains("path too long")
}

fn should_retry_with_safe_directory_fix(stderr: &str) -> bool {
    let normalized = stderr.to_lowercase();
    normalized.contains("detected dubious ownership") || normalized.contains("safe.directory")
}

async fn ensure_git_safe_directory(repo_path: &Path) -> GitResult<bool> {
    let safe_directory = canonical_git_safe_directory(repo_path);
    let current = run_git_global_owned(vec![
        "config".into(),
        "--global".into(),
        "--get-all".into(),
        "safe.directory".into(),
    ])
    .await
    .unwrap_or_default();

    let normalized_target = normalize_path_for_git_compare(&safe_directory);
    if current
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .any(|line| normalize_path_for_git_compare(line) == normalized_target)
    {
        return Ok(false);
    }

    run_git_global_owned(vec![
        "config".into(),
        "--global".into(),
        "--add".into(),
        "safe.directory".into(),
        safe_directory,
    ])
    .await?;

    Ok(true)
}

fn canonical_git_safe_directory(repo_path: &Path) -> String {
    fs::canonicalize(repo_path)
        .unwrap_or_else(|_| repo_path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

fn normalize_path_for_git_compare(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while normalized.ends_with('/') {
        normalized.pop();
    }

    if cfg!(windows) {
        normalized.make_ascii_lowercase();
    }

    normalized
}

async fn ensure_git_longpaths(repo_path: &Path) -> GitResult<bool> {
    let current = run_git_owned_without_retry(
        repo_path,
        vec!["config".into(), "--local".into(), "--get".into(), "core.longpaths".into()],
    )
    .await;

    if matches!(current, Ok(value) if value.trim().eq_ignore_ascii_case("true")) {
        return Ok(false);
    }

    run_git_owned_without_retry(
        repo_path,
        vec!["config".into(), "--local".into(), "core.longpaths".into(), "true".into()],
    )
    .await?;

    Ok(true)
}

async fn run_git_owned_without_retry(repo_path: &Path, args: Vec<String>) -> GitResult<String> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let _ = append_log(
        "backend",
        "git.command.start",
        &format!("git -C {repo_display} {command_preview}"),
        Some("no-retry"),
    );

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), None)
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
        return Err(GitServiceError::GitCommandFailed(stderr));
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

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), None)
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

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), None)
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

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), Some(input))
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

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let _ = append_log(
        "backend",
        "git.command.success",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&stdout),
    );

    Ok(stdout)
}

async fn run_git_bytes_owned_with_input(repo_path: &Path, args: Vec<String>, input: Vec<u8>) -> GitResult<Vec<u8>> {
    let command_preview = args.join(" ");
    let repo_display = repo_path.display().to_string();
    let _ = append_log(
        "backend",
        "git.command.start",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&format!("stdin bytes={} (binary stdout expected)", input.len())),
    );

    let mut command = git_command(Some(repo_path));
    command
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = activity::execute(command, activity::describe(Some(repo_path), &args), Some(input))
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
        return Err(GitServiceError::GitCommandFailed(stderr));
    }

    let _ = append_log(
        "backend",
        "git.command.success",
        &format!("git -C {repo_display} {command_preview}"),
        Some(&format!("{} binary bytes returned", output.stdout.len())),
    );

    Ok(output.stdout)
}

fn append_log(source: &str, scope: &str, message: &str, detail: Option<&str>) -> std::io::Result<()> {
    // Command start/end lines are reported by `activity::execute` itself, with live output.
    if !scope.starts_with("git.command.") {
        activity::publish_log(source, scope, message, detail);
    }

    // A poisoned lock used to make every later git command panic, which froze the UI
    // (the pending Tauri call never resolves). Logging must never be able to do that.
    let _guard = LOG_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let log_path = resolve_log_path()?;

    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)?;
    }
    activity::rotate_if_large(&log_path, MAX_LOG_FILE_BYTES);

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
    // Byte slicing here panicked whenever the cut fell inside a multi-byte character
    // (any non-ASCII author name or path), which froze the app. `clip` cuts on a boundary.
    activity::clip(value, LOG_DETAIL_LIMIT)
}

fn parse_status_output(output: &str) -> (String, bool, usize, usize, Vec<FileChange>, RepositoryCounts) {
    let mut current_branch = "Unknown".to_string();
    let mut detached_head = false;
    let mut ahead = 0;
    let mut behind = 0;
    let mut files = Vec::new();
    let mut counts = RepositoryCounts::default();

    // `-z` output: NUL-terminated entries with raw (unquoted) paths; a rename or copy is
    // followed by one extra entry holding the original path.
    let mut entries = output.split('\0');
    while let Some(line) = entries.next() {
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

        if line.len() < 4 || !line.is_char_boundary(3) {
            continue;
        }

        let index_status = line.chars().nth(0).unwrap_or(' ');
        let worktree_status = line.chars().nth(1).unwrap_or(' ');
        let path = line[3..].to_string();

        if matches!(index_status, 'R' | 'C') || matches!(worktree_status, 'R' | 'C') {
            entries.next();
        }

        let untracked = index_status == '?' && worktree_status == '?';
        let ignored = index_status == '!' && worktree_status == '!';
        let conflict_kind = match (index_status, worktree_status) {
            ('U', 'U') => Some("both-modified"),
            ('A', 'A') => Some("both-added"),
            ('D', 'D') => Some("both-deleted"),
            ('A', 'U') => Some("added-by-us"),
            ('U', 'A') => Some("added-by-them"),
            ('D', 'U') => Some("deleted-by-us"),
            ('U', 'D') => Some("deleted-by-them"),
            _ => None,
        };
        let conflicted = conflict_kind.is_some();
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
            file_size_bytes: None,
            conflict_kind: conflict_kind.map(ToString::to_string),
        });
    }

    (current_branch, detached_head, ahead, behind, files, counts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_porcelain_path_unquotes_space_wrapped_paths() {
        assert_eq!(
            decode_porcelain_path("\"Assets/TinyWizard/UI/Background/bg main menu.png.meta\""),
            "Assets/TinyWizard/UI/Background/bg main menu.png.meta"
        );
    }

    #[test]
    fn decode_porcelain_path_decodes_octal_utf8_bytes() {
        // "\303\247" is the two UTF-8 bytes of "ç", not two separate characters.
        assert_eq!(decode_porcelain_path("\"\\303\\207a\\304\\237layan.png\""), "Çağlayan.png");
    }

    struct TestRepo(PathBuf);

    impl TestRepo {
        fn new(name: &str) -> Self {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let root = env::temp_dir().join(format!("unigit-test-{name}-{nanos}"));
            fs::create_dir_all(&root).unwrap();
            let repo = Self(root);
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "UniGit Test"]);
            repo.git(&["config", "user.email", "test@unigit.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo.git(&["config", "core.autocrlf", "false"]);
            repo
        }

        fn git(&self, args: &[&str]) {
            let status = std::process::Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(status.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&status.stderr));
        }

        fn write(&self, relative: &str, contents: &str) {
            let target = self.0.join(relative);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, contents).unwrap();
        }

        fn read(&self, relative: &str) -> String {
            fs::read_to_string(self.0.join(relative)).unwrap()
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        async fn snapshot(&self) -> RepositorySnapshot {
            inspect_repository_inner(self.path()).await.unwrap()
        }
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn stages_and_unstages_paths_with_special_characters() {
        let repo = TestRepo::new("special");
        repo.write("seed.txt", "seed");
        repo.git(&["add", "seed.txt"]);
        repo.git(&["commit", "-q", "-m", "seed"]);

        let names = [
            "Assets/Enemy [Variant] (1).prefab",
            "Assets/Çağlayan öğe.txt",
            "Assets/日本語/テクスチャ.png",
            "Assets/it's a - b; c=d.txt",
            "Assets/#hash & 100%.mat",
            "Assets/star-glob-[a-z].asset",
        ];
        for name in names {
            repo.write(name, "data");
        }

        let listed = repo.snapshot().await.files.into_iter().map(|file| file.path).collect::<Vec<_>>();
        for name in names {
            assert!(listed.contains(&name.to_string()), "status should list {name} verbatim, got {listed:?}");
        }

        let all = names.iter().map(|name| name.to_string()).collect::<Vec<_>>();
        apply_path_operation(repo.path(), all.clone(), false).await.expect("staging special paths");
        let snapshot = repo.snapshot().await;
        assert_eq!(snapshot.counts.staged, names.len());
        assert_eq!(snapshot.counts.untracked, 0);

        apply_path_operation(repo.path(), all.clone(), true).await.expect("unstaging special paths");
        assert_eq!(repo.snapshot().await.counts.untracked, names.len());

        discard_paths_inner(repo.path(), all).await.expect("discarding special paths");
        assert!(repo.snapshot().await.files.is_empty());
    }

    fn conflicting_repo(name: &str) -> TestRepo {
        let repo = TestRepo::new(name);
        repo.write("shared.txt", "base\n");
        repo.write("gone.txt", "base\n");
        repo.write("notes.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "base"]);

        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("shared.txt", "feature\n");
        repo.write("gone.txt", "feature edit\n");
        repo.write("added.txt", "from feature\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "feature work"]);

        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "main\n");
        repo.git(&["rm", "-q", "gone.txt"]);
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "main work"]);

        // Uncommitted local edit: the situation that used to block the merge outright.
        repo.write("notes.txt", "local edit\n");
        repo
    }

    #[tokio::test]
    async fn merge_with_conflicts_can_be_resolved_and_completed() {
        let repo = conflicting_repo("merge");

        let preview = preview_merge_inner(repo.path(), "refs/heads/feature".into()).await.unwrap();
        assert!(!preview.fast_forward && !preview.up_to_date);
        assert_eq!(preview.incoming_commits, 1);
        assert_eq!(preview.local_changes, 1);
        assert_eq!(
            preview.predicted_conflicts,
            Some(vec!["gone.txt".to_string(), "shared.txt".to_string()]),
        );

        let result = merge_branch_inner(repo.path(), "refs/heads/feature".into(), "keep".into(), "ask".into())
            .await
            .unwrap();
        assert_eq!(result.status, "conflicts");
        assert_eq!(result.conflicted_files.len(), 2);

        let snapshot = repo.snapshot().await;
        assert_eq!(snapshot.operation.as_ref().map(|operation| operation.kind.as_str()), Some("merge"));
        let kind_of = |path: &str| {
            snapshot.files.iter().find(|file| file.path == path).and_then(|file| file.conflict_kind.clone())
        };
        assert_eq!(kind_of("shared.txt").as_deref(), Some("both-modified"));
        assert_eq!(kind_of("gone.txt").as_deref(), Some("deleted-by-us"));

        assert!(continue_operation_inner(repo.path()).await.is_err(), "cannot complete with open conflicts");

        resolve_conflicted_files_inner(repo.path(), vec!["shared.txt".into()], "theirs".into()).await.unwrap();
        // "Ours" deleted this file, so keeping ours must remove it rather than fail.
        resolve_conflicted_files_inner(repo.path(), vec!["gone.txt".into()], "ours".into()).await.unwrap();

        continue_operation_inner(repo.path()).await.unwrap();

        let snapshot = repo.snapshot().await;
        assert!(snapshot.operation.is_none());
        assert_eq!(snapshot.counts.conflicted, 0);
        assert_eq!(repo.read("shared.txt"), "feature\n");
        assert_eq!(repo.read("added.txt"), "from feature\n");
        assert!(!repo.0.join("gone.txt").exists());
        assert_eq!(repo.read("notes.txt"), "local edit\n", "autostash must restore the local edit");
    }

    #[tokio::test]
    async fn merge_can_be_aborted_and_preference_resolves_automatically() {
        let repo = conflicting_repo("abort");

        let result = merge_branch_inner(repo.path(), "refs/heads/feature".into(), "keep".into(), "ask".into())
            .await
            .unwrap();
        assert_eq!(result.status, "conflicts");

        abort_operation_inner(repo.path()).await.unwrap();
        let snapshot = repo.snapshot().await;
        assert!(snapshot.operation.is_none());
        assert_eq!(repo.read("shared.txt"), "main\n");
        assert_eq!(repo.read("notes.txt"), "local edit\n");

        // "Prefer incoming" settles the content conflict; only the delete/modify one is left.
        let result = merge_branch_inner(repo.path(), "refs/heads/feature".into(), "keep".into(), "theirs".into())
            .await
            .unwrap();
        assert_eq!(result.conflicted_files, vec!["gone.txt".to_string()]);
        resolve_conflicted_files_inner(repo.path(), vec!["gone.txt".into()], "theirs".into()).await.unwrap();
        continue_operation_inner(repo.path()).await.unwrap();
        assert_eq!(repo.read("shared.txt"), "feature\n");
        assert_eq!(repo.read("gone.txt"), "feature edit\n");
    }

    #[tokio::test]
    async fn merge_survives_untracked_file_in_the_way() {
        let repo = TestRepo::new("untracked");
        repo.write("shared.txt", "base\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "base"]);
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("added.txt", "from feature\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "feature work"]);
        repo.git(&["checkout", "-q", "main"]);
        repo.write("shared.txt", "main\n");
        repo.git(&["commit", "-q", "-am", "main work"]);
        // Same path the incoming branch adds, sitting untracked in the working tree.
        repo.write("added.txt", "local untracked copy\n");

        let result = merge_branch_inner(repo.path(), "refs/heads/feature".into(), "keep".into(), "ask".into())
            .await
            .expect("an untracked file in the way must not fail the merge");
        assert_eq!(result.status, "merged");
        assert!(result.message.contains("stash"), "user must be told where their changes went: {}", result.message);
        assert_eq!(repo.read("added.txt"), "from feature\n");
    }

    #[tokio::test]
    async fn material_preview_is_built_from_the_shader_source() {
        let repo = TestRepo::new("material");
        repo.write(
            "Assets/Shaders/Toon.shader",
            r#"Shader "Game/Toon"
{
    Properties
    {
        _Albedo ("Albedo", 2D) = "white" {}
        _Tint ("Tint", Color) = (1, 0.5, 0.25, 1)
        [Normal] _Bumps ("Bumps", 2D) = "bump" {}
        _Gloss ("Smoothness", Range(0, 1)) = 0.8
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" }
        Blend One One
        Cull Off
        Pass { CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            ENDCG }
    }
}"#,
        );
        repo.write("Assets/Shaders/Toon.shader.meta", "fileFormatVersion: 2\nguid: aaaa0000aaaa0000aaaa0000aaaa0000\n");
        repo.write("Assets/Textures/Skin [v2] ç.png", "not really a png");
        repo.write("Assets/Textures/Skin [v2] ç.png.meta", "fileFormatVersion: 2\nguid: bbbb0000bbbb0000bbbb0000bbbb0000\nTextureImporter:\n  textureType: 1\n  maxTextureSize: 1024\n");
        repo.write(
            "Assets/Hero.mat",
            r#"%YAML 1.1
Material:
  m_Name: Hero
  m_Shader: {fileID: 4800000, guid: aaaa0000aaaa0000aaaa0000aaaa0000, type: 3}
  m_ValidKeywords:
  - _EMISSION
  m_InvalidKeywords: []
  m_CustomRenderQueue: 3100
  m_SavedProperties:
    m_TexEnvs:
    - _Albedo:
        m_Texture: {fileID: 2800000, guid: bbbb0000bbbb0000bbbb0000bbbb0000, type: 3}
        m_Scale: {x: 2, y: 3}
        m_Offset: {x: 0.5, y: 0}
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: bbbb0000bbbb0000bbbb0000bbbb0000, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Ints: []
    m_Floats:
    - _Metallic: 1
    m_Colors:
    - _Tint: {r: 0, g: 1, b: 0, a: 1}
"#,
        );
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "assets"]);

        let preview = inspect_file_preview_inner(repo.path(), "Assets/Hero.mat".into()).await.unwrap();
        assert_eq!(preview.preview_kind, "material");
        let source = &preview.unity_material_sources[0];

        assert_eq!(source.shader_label, "Game/Toon");
        assert_eq!(source.shader_source, "ShaderLab");
        assert_eq!(source.shader_path.as_deref(), Some("Assets/Shaders/Toon.shader"));
        assert_eq!(source.shader_family, "unlit");
        assert_eq!(source.surface_kind, "additive");
        assert!(source.double_sided);
        assert_eq!(source.keywords, vec!["_EMISSION".to_string()]);
        assert_eq!(source.render_queue, Some(3100));

        // _Albedo is not a conventional name: it is picked up from the shader's declarations.
        assert_eq!(source.base_texture_key.as_deref(), Some("_Albedo"));
        assert_eq!(source.textures[0].relative_path, "Assets/Textures/Skin [v2] ç.png");
        assert_eq!(source.base_tiling, Some([2.0, 3.0, 0.5, 0.0]));
        assert_eq!(source.base_color.as_ref().map(|color| (color.r, color.g, color.b)), Some((0.0, 1.0, 0.0)));
        // Not saved in the material, so the shader default applies.
        assert_eq!(source.smoothness, Some(0.8));

        let names = source.properties.iter().map(|property| property.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, ["_Albedo", "_Tint", "_Bumps", "_Gloss"]);
        assert!(source.properties[3].is_default);
        // _MainTex and _Metallic are leftovers from another shader.
        assert!(source.notes.iter().any(|note| note.starts_with("2 saved value(s)")), "{:?}", source.notes);
        assert!(source.notes.iter().any(|note| note.contains("not executed")));

        let texture_preview = inspect_file_preview_inner(repo.path(), "Assets/Textures/Skin [v2] ç.png".into()).await.unwrap();
        let import_settings = texture_preview.import_settings.expect("meta should be summarised");
        assert_eq!(import_settings.pipeline_state, "TextureImporter");
        assert_eq!(import_settings.details[0].value, "Normal map");
    }

    #[tokio::test]
    async fn deleted_file_is_previewed_from_git() {
        let repo = TestRepo::new("deleted");
        repo.write("notes.txt", "kept in history\n");
        repo.git(&["add", "."]);
        repo.git(&["commit", "-q", "-m", "notes"]);
        fs::remove_file(repo.0.join("notes.txt")).unwrap();

        let preview = inspect_file_preview_inner(repo.path(), "notes.txt".into()).await.unwrap();
        assert!(preview.missing_from_disk);
        assert_eq!(preview.preview_kind, "text");
        assert_eq!(preview.text_excerpt.as_deref(), Some("kept in history\n"));
        assert!(preview.unstaged_diff.is_some());

        assert!(inspect_file_preview_inner(repo.path(), "../outside.txt".into()).await.is_err());
    }

    #[test]
    fn reads_asset_headers() {
        let mut psd = b"8BPS".to_vec();
        psd.extend([0, 1, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 2, 0, 0, 0, 4, 0, 0, 8, 0, 3]);
        let summary = parse_psd_summary(&psd).unwrap();
        assert_eq!(summary.details[0].value, "1024 x 512 px");
        assert_eq!(summary.details[1].value, "RGB");

        assert_eq!(parse_blend_summary(b"BLENDER-v402REND\0\0\0\0").unwrap().pipeline_state, "Blender 4.2");
        assert_eq!(parse_blend_summary(b"BLENDER17-01v0500").unwrap().pipeline_state, "Blender 5.0");

        let glb_json = br#"{"asset":{"version":"2.0","generator":"Tool"},"meshes":[{},{}]}"#;
        let mut glb = b"glTF".to_vec();
        glb.extend(2u32.to_le_bytes());
        glb.extend(0u32.to_le_bytes());
        glb.extend((glb_json.len() as u32).to_le_bytes());
        glb.extend(b"JSON");
        glb.extend(glb_json);
        let summary = parse_glb_summary(&glb).unwrap();
        assert_eq!(summary.pipeline_state, "glTF 2.0");
        assert!(summary.details.iter().any(|detail| detail.label == "Meshes" && detail.value == "2"));
    }

    #[test]
    fn logging_long_non_ascii_output_does_not_panic() {
        // The reflog of a repo whose author is "Çağlayan Karagözler" froze the app: the log
        // truncation sliced through a multi-byte character, panicked and poisoned the log lock.
        let detail = "Çağlayan Karagözler ".repeat(LOG_DETAIL_LIMIT / 10);
        // Every alignment of the 23-byte phrase, so the cut lands inside "Ç", "ğ" and "ö" at least once.
        for offset in 0..23 {
            let text = format!("{}{}", "x".repeat(offset), detail);
            assert!(truncate_for_log(&text).contains("truncated"));
        }
        append_log("backend", "test.unicode", "non-ascii detail", Some(&detail)).unwrap();
        append_log("backend", "test.unicode", "still logging afterwards", None).unwrap();
    }

    #[test]
    fn decode_porcelain_path_decodes_common_escapes() {
        assert_eq!(decode_porcelain_path("\"folder\\\\file\\tname\""), "folder\\file\tname");
    }

    #[test]
    fn sanitize_path_list_normalizes_quoted_paths() {
        assert_eq!(
            sanitize_path_list(vec![" \"Assets\\Some Folder\\file.txt\" ".to_string()]),
            vec!["Assets/Some Folder/file.txt".to_string()]
        );
    }

    #[test]
    fn detects_git_lfs_pointer_bytes() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:abc123\nsize 1747405\n";
        assert!(is_git_lfs_pointer_bytes(pointer));
    }

    #[test]
    fn ignores_regular_binary_payloads_for_lfs_detection() {
        assert!(!is_git_lfs_pointer_bytes(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
    }

    #[test]
    fn infers_lit_for_urp_material_with_declared_base_map() {
        let source = r#"
m_Name: testMaterial
m_Shader: {fileID: 4800000, guid: 933532a4fcc9baf4fa0491de14d08ed7, type: 3}
m_SavedProperties:
  m_TexEnvs:
  - _BaseMap:
      m_Texture: {fileID: 2800000, guid: 19c714b595a159a4589ebadae30c41eb, type: 3}
      m_Scale: {x: 1, y: 1}
      m_Offset: {x: 0, y: 0}
  - _MainTex:
      m_Texture: {fileID: 2800000, guid: 19c714b595a159a4589ebadae30c41eb, type: 3}
      m_Scale: {x: 1, y: 1}
      m_Offset: {x: 0, y: 0}
  - _EmissionMap:
      m_Texture: {fileID: 0}
      m_Scale: {x: 1, y: 1}
      m_Offset: {x: 0, y: 0}
  m_Ints: []
  m_Floats:
  - _Metallic: 0
  - _Smoothness: 0.5
  m_Colors:
  - _EmissionColor: {r: 0, g: 0, b: 0, a: 1}
"#;

        let material = parse_unity_material(source).expect("material should parse");
        assert_eq!(material.texture_slots.len(), 3);
        assert_eq!(infer_unity_shader_family(&material, &[]), "lit");
    }
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
        "tga" => "image/x-tga",
        "exr" => "image/x-exr",
        "hdr" => "image/vnd.radiance",
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

fn asset_detail(label: &str, value: impl Into<String>) -> AssetDetail {
    AssetDetail {
        label: label.to_string(),
        value: value.into(),
    }
}

/// Reads whatever the file header gives away without a full decoder.
fn build_asset_summary(bytes: &[u8], extension: &str) -> Option<AssetSummary> {
    match extension {
        "psd" | "psb" => parse_psd_summary(bytes),
        "fbx" => parse_fbx_summary(bytes),
        "gltf" => parse_gltf_summary(bytes, "glTF scene"),
        "glb" => parse_glb_summary(bytes),
        "blend" => parse_blend_summary(bytes),
        _ => None,
    }
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
    let color_mode = match u16::from_be_bytes([bytes[24], bytes[25]]) {
        0 => "Bitmap".to_string(),
        1 => "Grayscale".to_string(),
        2 => "Indexed".to_string(),
        3 => "RGB".to_string(),
        4 => "CMYK".to_string(),
        7 => "Multichannel".to_string(),
        8 => "Duotone".to_string(),
        9 => "Lab".to_string(),
        other => format!("Mode {other}"),
    };

    Some(AssetSummary {
        asset_kind: "Photoshop document".to_string(),
        pipeline_state: if version == 2 { "PSB (large document)" } else { "PSD" }.to_string(),
        details: vec![
            asset_detail("Dimensions", format!("{width} x {height} px")),
            asset_detail("Color mode", color_mode),
            asset_detail("Channels", channels.to_string()),
            asset_detail("Bit depth", format!("{depth} bit per channel")),
        ],
    })
}

/// Binary FBX stores `Name` + 'S' + u32 length + text for string properties.
fn find_fbx_binary_string(bytes: &[u8], name: &[u8]) -> Option<String> {
    let window = &bytes[..bytes.len().min(64 * 1024)];
    let position = window
        .windows(name.len() + 1)
        .position(|candidate| &candidate[..name.len()] == name && candidate[name.len()] == b'S')?;
    let start = position + name.len() + 1;
    let length = u32::from_le_bytes(window.get(start..start + 4)?.try_into().ok()?) as usize;
    let text = window.get(start + 4..start + 4 + length.min(256))?;
    Some(String::from_utf8_lossy(text).trim().to_string()).filter(|value| !value.is_empty())
}

fn parse_fbx_summary(bytes: &[u8]) -> Option<AssetSummary> {
    let format_version = |version: u32| format!("{}.{}", version / 1000, (version % 1000) / 100);
    let summary = |encoding: &str, version: Option<u32>, creator: Option<String>| {
        let mut details = vec![asset_detail("Encoding", encoding)];
        if let Some(version) = version {
            details.push(asset_detail("FBX version", format!("{} ({version})", format_version(version))));
        }
        if let Some(creator) = creator {
            details.push(asset_detail("Exported by", creator));
        }

        AssetSummary {
            asset_kind: "FBX scene".to_string(),
            pipeline_state: match version {
                Some(version) => format!("{encoding} FBX {}", format_version(version)),
                None => format!("{encoding} FBX"),
            },
            details,
        }
    };

    if bytes.starts_with(b"Kaydara FBX Binary") {
        let version = bytes.get(23..27).map(|raw| u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]));
        return Some(summary("Binary", version, find_fbx_binary_string(bytes, b"Creator")));
    }

    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_string();
    if head.contains("FBXHeaderExtension") || head.contains("Kaydara\\FBX") {
        let field = |name: &str| head.lines().find_map(|line| line.trim().strip_prefix(name)).map(str::trim);
        let version = field("FBXVersion:").and_then(|value| value.parse::<u32>().ok());
        let creator = field("Creator:").map(|value| value.trim_matches('"').to_string()).filter(|value| !value.is_empty());
        return Some(summary("ASCII", version, creator));
    }

    None
}

fn parse_gltf_summary(bytes: &[u8], asset_kind: &str) -> Option<AssetSummary> {
    let json = serde_json::from_slice::<serde_json::Value>(bytes).ok()?;
    let count = |key: &str| json.get(key).and_then(|value| value.as_array()).map(|value| value.len()).unwrap_or(0);
    let asset_field = |key: &str| {
        json.get("asset")
            .and_then(|asset| asset.get(key))
            .and_then(|value| value.as_str())
            .map(ToString::to_string)
    };
    let version = asset_field("version").unwrap_or_else(|| "2.0".to_string());

    let mut details = Vec::new();
    if let Some(generator) = asset_field("generator") {
        details.push(asset_detail("Exported by", generator));
    }
    for (label, key) in [
        ("Scenes", "scenes"),
        ("Nodes", "nodes"),
        ("Meshes", "meshes"),
        ("Materials", "materials"),
        ("Textures", "textures"),
        ("Animations", "animations"),
        ("Skins", "skins"),
        ("Cameras", "cameras"),
    ] {
        if count(key) > 0 {
            details.push(asset_detail(label, count(key).to_string()));
        }
    }
    let extensions = json
        .get("extensionsUsed")
        .and_then(|value| value.as_array())
        .map(|values| values.iter().filter_map(|value| value.as_str()).collect::<Vec<_>>().join(", "))
        .filter(|value| !value.is_empty());
    if let Some(extensions) = extensions {
        details.push(asset_detail("Extensions", extensions));
    }

    Some(AssetSummary {
        asset_kind: asset_kind.to_string(),
        pipeline_state: format!("glTF {version}"),
        details,
    })
}

fn parse_glb_summary(bytes: &[u8]) -> Option<AssetSummary> {
    if bytes.len() < 20 || &bytes[0..4] != b"glTF" {
        return None;
    }

    // Header (12 bytes) is followed by the JSON chunk: u32 length, "JSON", payload.
    let chunk_length = u32::from_le_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]) as usize;
    if &bytes[16..20] == b"JSON" {
        if let Some(summary) = bytes.get(20..20 + chunk_length).and_then(|json| parse_gltf_summary(json, "GLB scene")) {
            return Some(summary);
        }
    }

    let version = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    Some(AssetSummary {
        asset_kind: "GLB scene".to_string(),
        pipeline_state: format!("glTF {version}.0"),
        details: Vec::new(),
    })
}

fn parse_blend_summary(bytes: &[u8]) -> Option<AssetSummary> {
    let summary = |state: String, details: Vec<AssetDetail>| {
        Some(AssetSummary {
            asset_kind: "Blender file".to_string(),
            pipeline_state: state,
            details,
        })
    };

    if bytes.starts_with(&[0x28, 0xB5, 0x2F, 0xFD]) || bytes.starts_with(&[0x1F, 0x8B]) {
        let codec = if bytes[0] == 0x28 { "Zstandard" } else { "gzip" };
        return summary(
            "Compressed .blend".to_string(),
            vec![asset_detail("Compression", codec), asset_detail("Version", "Stored inside the compressed data")],
        );
    }

    if !bytes.starts_with(b"BLENDER") || bytes.len() < 17 {
        return None;
    }

    // Classic header: BLENDER + pointer size (_ or -) + endianness (v or V) + "305".
    // Blender 5 header: BLENDER17-01v0500 (header size, pointer size, format, endianness, version).
    let header = String::from_utf8_lossy(&bytes[7..17]).to_string();
    let marker = header.find(['v', 'V'])?;
    let digits = header[marker + 1..].chars().take_while(|ch| ch.is_ascii_digit()).collect::<String>();
    let (major, minor) = match digits.len() {
        3 => (digits[..1].parse::<u32>().ok()?, digits[1..].parse::<u32>().ok()?),
        4 => (digits[..2].parse::<u32>().ok()?, digits[2..].parse::<u32>().ok()?),
        _ => return None,
    };

    summary(
        format!("Blender {major}.{minor}"),
        vec![
            asset_detail("Saved with", format!("Blender {major}.{minor}")),
            asset_detail("Pointers", if header.contains('_') { "32 bit" } else { "64 bit" }),
            asset_detail("Byte order", if header.contains('V') { "Big endian" } else { "Little endian" }),
        ],
    )
}

/// Summarises the importer block of a Unity `.meta` file for textures and models.
fn parse_unity_meta_summary(meta: &str) -> Option<AssetSummary> {
    let importer = meta
        .lines()
        .find(|line| !line.starts_with(' ') && line.trim_end().ends_with("Importer:"))?
        .trim_end()
        .trim_end_matches(':')
        .to_string();
    let value = |key: &str| {
        meta.lines()
            .find_map(|line| line.trim().strip_prefix(key).and_then(|rest| rest.strip_prefix(':')))
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
    };
    let labelled = |key: &str, labels: &[(&str, &str)]| {
        value(key).map(|raw| {
            labels
                .iter()
                .find(|(code, _)| *code == raw)
                .map(|(_, label)| label.to_string())
                .unwrap_or(raw)
        })
    };
    let toggle = |key: &str| value(key).map(|raw| if raw == "1" { "On" } else { "Off" }.to_string());

    let rows: Vec<(&str, Option<String>)> = match importer.as_str() {
        "TextureImporter" => {
            let is_sprite = value("textureType").as_deref() == Some("8");
            vec![
                (
                    "Texture type",
                    labelled(
                        "textureType",
                        &[
                            ("0", "Default"),
                            ("1", "Normal map"),
                            ("2", "Editor GUI"),
                            ("4", "Cookie"),
                            ("6", "Lightmap"),
                            ("7", "Cursor"),
                            ("8", "Sprite"),
                            ("10", "Single channel"),
                        ],
                    ),
                ),
                ("Max size", value("maxTextureSize")),
                (
                    "Compression",
                    labelled("textureCompression", &[("0", "None"), ("1", "Normal"), ("2", "High quality"), ("3", "Low quality")]),
                ),
                ("sRGB", toggle("sRGBTexture")),
                ("Mip maps", toggle("enableMipMap")),
                ("Alpha is transparency", toggle("alphaIsTransparency")),
                ("Filter", labelled("filterMode", &[("0", "Point"), ("1", "Bilinear"), ("2", "Trilinear")])),
                (
                    "Sprite mode",
                    labelled("spriteMode", &[("1", "Single"), ("2", "Multiple"), ("3", "Polygon")]).filter(|_| is_sprite),
                ),
                ("Pixels per unit", value("spritePixelsToUnits").filter(|_| is_sprite)),
                ("Read/Write", toggle("isReadable")),
            ]
        }
        "ModelImporter" => vec![
            ("Scale factor", value("globalScale")),
            (
                "Mesh compression",
                labelled("meshCompression", &[("0", "Off"), ("1", "Low"), ("2", "Medium"), ("3", "High")]),
            ),
            ("Read/Write", toggle("isReadable")),
            ("Blend shapes", toggle("importBlendShapes")),
            ("Animation", toggle("importAnimation")),
            (
                "Rig",
                labelled("animationType", &[("0", "None"), ("1", "Legacy"), ("2", "Generic"), ("3", "Humanoid")]),
            ),
        ],
        _ => Vec::new(),
    };

    let details = rows
        .into_iter()
        .filter_map(|(label, value)| value.map(|value| asset_detail(label, value)))
        .collect::<Vec<_>>();

    (!details.is_empty()).then(|| AssetSummary {
        asset_kind: "Unity import settings".to_string(),
        pipeline_state: importer,
        details,
    })
}

fn is_image_extension(extension: &str) -> bool {
    matches!(extension, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg")
}

fn is_previewable_image_extension(extension: &str) -> bool {
    // TGA, EXR and HDR are decoded in the webview by three.js loaders.
    is_image_extension(extension) || matches!(extension, "psd" | "tga" | "exr" | "hdr")
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
    matches!(extension, "psb" | "fbx" | "obj" | "glb" | "gltf" | "blend" | "dds" | "tif" | "tiff")
}

async fn collect_model_preview_sources(
    repo_root: &Path,
    resolved_path: Option<&Path>,
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
            "fbx" => vec!["Textures referenced by the FBX are not loaded; geometry, materials and rig are shown.".to_string()],
            "obj" if external_resources.is_empty() => vec!["No .mtl material file was found next to this OBJ; a neutral material is used.".to_string()],
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
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_path}"), relative_path).await,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}"), relative_path).await,
    }
}

async fn collect_image_preview_sources(
    repo_root: &Path,
    resolved_path: Option<&Path>,
    relative_path: &str,
    extension: &str,
    mime_type: &str,
) -> GitResult<Vec<ImagePreviewSource>> {
    let mut sources = Vec::new();

    if let Some(working_tree_bytes) = read_preview_blob(repo_root, resolved_path, relative_path, PreviewBlobSource::WorkingTree).await? {
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
    }

    if let Some(staged_bytes) = git_show_optional_bytes(repo_root, format!(":{relative_path}"), relative_path).await? {
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

    if let Some(head_bytes) = git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}"), relative_path).await? {
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
        format: extension.to_string(),
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
    resolved_path: Option<&Path>,
    relative_path: &str,
) -> GitResult<Vec<UnityMaterialPreviewSource>> {
    let mut sources = Vec::new();

    for (key, label, source_kind) in [
        ("workingTree", "Working tree", PreviewBlobSource::WorkingTree),
        ("staged", "Staged", PreviewBlobSource::Staged),
        ("head", "HEAD", PreviewBlobSource::Head),
    ] {
        let Some(bytes) = read_preview_blob(repo_root, resolved_path, relative_path, source_kind).await? else {
            continue;
        };
        let Some(material) = parse_unity_material(&String::from_utf8_lossy(&bytes)) else {
            continue;
        };

        sources.push(build_unity_material_preview_source(repo_root, source_kind, key, label, &material).await?);
    }

    Ok(sources)
}

async fn read_preview_blob(
    repo_root: &Path,
    resolved_path: Option<&Path>,
    relative_path: &str,
    source_kind: PreviewBlobSource,
) -> GitResult<Option<Vec<u8>>> {
    match source_kind {
        PreviewBlobSource::WorkingTree => resolved_path
            .map(|path| fs::read(path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string())))
            .transpose(),
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_path}"), relative_path).await,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_path}"), relative_path).await,
    }
}

fn parse_unity_material(source: &str) -> Option<ParsedUnityMaterial> {
    enum Section {
        None,
        TexEnvs,
        Floats,
        Colors,
        Keywords,
    }

    if !source.contains("m_Shader:") {
        return None;
    }

    let mut material_name = "Material".to_string();
    let mut shader_guid = None;
    let mut shader_file_id = None;
    let mut float_values = HashMap::new();
    let mut color_values = HashMap::new();
    let mut texture_slots: Vec<ParsedUnityTextureSlot> = Vec::new();
    let mut keywords = Vec::new();
    let mut custom_render_queue = None;
    let mut section = Section::None;
    let mut current_texture_property: Option<String> = None;
    let pair = |fields: &HashMap<String, String>| {
        (
            fields.get("x").and_then(|value| value.parse().ok()).unwrap_or(1.0),
            fields.get("y").and_then(|value| value.parse().ok()).unwrap_or(1.0),
        )
    };

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

        // Unity 2020 and older keep enabled keywords on one space-separated line.
        if let Some(value) = trimmed.strip_prefix("m_ShaderKeywords:") {
            keywords.extend(value.split_whitespace().map(ToString::to_string));
            continue;
        }

        if let Some(value) = trimmed.strip_prefix("m_CustomRenderQueue:") {
            custom_render_queue = value.trim().parse::<i32>().ok().filter(|queue| *queue >= 0);
            continue;
        }

        let next_section = match trimmed {
            "m_TexEnvs:" => Some(Section::TexEnvs),
            "m_Floats:" | "m_Ints:" => Some(Section::Floats),
            "m_Colors:" => Some(Section::Colors),
            "m_ValidKeywords:" => Some(Section::Keywords),
            _ => None,
        };
        if let Some(next_section) = next_section {
            section = next_section;
            current_texture_property = None;
            continue;
        }

        match section {
            Section::TexEnvs => {
                if let Some(value) = trimmed.strip_prefix("- ") {
                    if let Some(property_name) = value.strip_suffix(':') {
                        current_texture_property = Some(property_name.trim().to_string());
                    }
                    continue;
                }

                let Some(property_name) = current_texture_property.as_ref() else {
                    continue;
                };

                if let Some(value) = trimmed.strip_prefix("m_Texture:") {
                    let inline_fields = parse_inline_object_fields(value.trim());
                    texture_slots.push(ParsedUnityTextureSlot {
                        property_name: property_name.clone(),
                        guid: inline_fields.get("guid").cloned().filter(|guid| !guid.is_empty()),
                        scale: (1.0, 1.0),
                        offset: (0.0, 0.0),
                    });
                } else if let Some(slot) = texture_slots.last_mut().filter(|slot| &slot.property_name == property_name) {
                    if let Some(value) = trimmed.strip_prefix("m_Scale:") {
                        slot.scale = pair(&parse_inline_object_fields(value.trim()));
                    } else if let Some(value) = trimmed.strip_prefix("m_Offset:") {
                        let (x, y) = pair(&parse_inline_object_fields(value.trim()));
                        // `pair` defaults to 1 for scale; a missing offset component is 0.
                        slot.offset = (if value.contains("x:") { x } else { 0.0 }, if value.contains("y:") { y } else { 0.0 });
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
            Section::Keywords => match trimmed.strip_prefix("- ") {
                Some(keyword) => keywords.push(keyword.trim().to_string()),
                None => section = Section::None,
            },
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
        keywords,
        custom_render_queue,
    })
}

fn parse_inline_object_fields(source: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
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

/// Shaders that ship with Unity and are referenced by a fixed id rather than a project file.
/// Returns (name, lit). Only ids that are stable across Unity versions are listed.
fn well_known_unity_shader(guid: Option<&str>, file_id: Option<&str>) -> Option<(&'static str, bool)> {
    match (guid?, file_id.unwrap_or_default()) {
        ("933532a4fcc9baf4fa0491de14d08ed7", _) => Some(("Universal Render Pipeline/Lit", true)),
        ("8d2bb70cbf9db8d4da26e15b26e74248", _) => Some(("Universal Render Pipeline/Simple Lit", true)),
        ("650dd9526735d5b46b79224bc6e94025", _) => Some(("Universal Render Pipeline/Unlit", false)),
        ("6e4ae4064600d784cac1e41a9e6f2e59", _) => Some(("HDRP/Lit", true)),
        ("0000000000000000f000000000000000", "46") => Some(("Standard", true)),
        ("0000000000000000f000000000000000", "45") => Some(("Standard (Specular setup)", true)),
        ("0000000000000000f000000000000000", "7") => Some(("Legacy Shaders/Diffuse", true)),
        ("0000000000000000f000000000000000", "10750") => Some(("Unlit/Transparent", false)),
        ("0000000000000000f000000000000000", "10751") => Some(("Unlit/Transparent Cutout", false)),
        ("0000000000000000f000000000000000", "10752") => Some(("Unlit/Texture", false)),
        ("0000000000000000f000000000000000", "10755") => Some(("Unlit/Color", false)),
        ("0000000000000000f000000000000000", "10753") => Some(("Sprites/Default", false)),
        ("0000000000000000f000000000000000", "10770") => Some(("UI/Default", false)),
        _ => None,
    }
}

/// Stock shaders are approximated closely enough that "custom code skipped" notes are noise.
fn is_stock_unity_shader(name: &str) -> bool {
    [
        "Universal Render Pipeline/",
        "HDRP/",
        "Standard",
        "Unlit/",
        "Sprites/",
        "UI/",
        "Legacy Shaders/",
        "Mobile/",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

/// Maps a declared shader property to the slot it fills on the preview surface.
fn classify_unity_property(property: &ShaderProperty) -> Option<&'static str> {
    let name = property.name.to_ascii_lowercase();
    let has = |needle: &str| name.contains(needle);

    match property.kind {
        ShaderPropertyKind::Texture => {
            if property.has_attribute("maintexture") {
                Some("baseMap")
            } else if has("detail") {
                Some("detail")
            } else if property.has_attribute("normal") || property.default_value == "bump" || has("bump") || has("normal") {
                Some("normalMap")
            } else if has("emis") {
                Some("emissionMap")
            } else if has("maskmap") {
                Some("maskMap")
            } else if has("metal") {
                Some("metallicMap")
            } else if has("occlusion") || has("aomap") || name.ends_with("_ao") {
                Some("occlusionMap")
            } else if matches!(
                name.as_str(),
                "_maintex" | "_basemap" | "_basecolormap" | "_basetex" | "_basetexture" | "_albedo" | "_albedomap" | "_diffuse" | "_diffusemap"
            ) {
                Some("baseMap")
            } else {
                None
            }
        }
        ShaderPropertyKind::Color => {
            if property.has_attribute("maincolor") {
                Some("baseColor")
            } else if has("emis") {
                Some("emissionColor")
            } else if has("spec") {
                Some("specularColor")
            } else if matches!(name.as_str(), "_basecolor" | "_color" | "_tint" | "_tintcolor" | "_maincolor") {
                Some("baseColor")
            } else {
                None
            }
        }
        ShaderPropertyKind::Float | ShaderPropertyKind::Range | ShaderPropertyKind::Int => {
            // Custom shaders name things freely, so the inspector label counts too.
            let label = property.display_name.to_ascii_lowercase();
            let is_scalar_named = |needle: &str| has(needle) && !has("map") && !has("source") && !has("reflections");

            if name == "_metallic" || label == "metallic" {
                Some("metallic")
            } else if is_scalar_named("smooth") || is_scalar_named("gloss") || matches!(label.as_str(), "smoothness" | "glossiness") {
                Some("smoothness")
            } else if is_scalar_named("roughness") || label == "roughness" {
                Some("roughness")
            } else if matches!(name.as_str(), "_cutoff" | "_alphacutoff" | "_alphaclipthreshold") {
                Some("cutoff")
            } else if matches!(name.as_str(), "_bumpscale" | "_normalscale" | "_normalstrength") {
                Some("normalScale")
            } else if name == "_occlusionstrength" {
                Some("occlusionStrength")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn parse_unity_default_vector(value: &str) -> Option<UnityColorValue> {
    let mut parts = value
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(|part| part.trim().parse::<f32>().ok());

    Some(UnityColorValue {
        r: parts.next()??,
        g: parts.next()??,
        b: parts.next()??,
        a: parts.next().flatten().unwrap_or(1.0),
    })
}

fn format_unity_number(value: f32) -> String {
    let formatted = format!("{value:.3}");
    formatted.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn format_unity_color(color: &UnityColorValue, hdr: bool) -> String {
    let peak = color.r.max(color.g).max(color.b);
    let scale = if peak > 1.0 { peak } else { 1.0 };
    let channel = |value: f32| ((value / scale).clamp(0.0, 1.0) * 255.0).round() as u8;
    let mut text = format!("#{:02X}{:02X}{:02X}", channel(color.r), channel(color.g), channel(color.b));

    if (color.a - 1.0).abs() > 0.001 {
        text.push_str(&format!("  alpha {}", format_unity_number(color.a)));
    }
    if hdr && peak > 1.0 {
        text.push_str(&format!("  HDR x{}", format_unity_number(peak)));
    }

    text
}

/// With no shader source available the material's own saved entries are the best property list.
fn material_declared_properties(material: &ParsedUnityMaterial) -> Vec<ShaderProperty> {
    let property = |name: &str, kind: ShaderPropertyKind| ShaderProperty {
        name: name.to_string(),
        display_name: name.trim_start_matches('_').to_string(),
        kind,
        attributes: Vec::new(),
        default_value: String::new(),
    };
    let mut color_names = material.color_values.keys().collect::<Vec<_>>();
    color_names.sort();
    let mut float_names = material.float_values.keys().collect::<Vec<_>>();
    float_names.sort();

    let mut properties = material
        .texture_slots
        .iter()
        .map(|slot| property(&slot.property_name, ShaderPropertyKind::Texture))
        .collect::<Vec<_>>();
    properties.extend(color_names.into_iter().map(|name| property(name, ShaderPropertyKind::Color)));
    properties.extend(float_names.into_iter().map(|name| property(name, ShaderPropertyKind::Float)));
    properties
}

fn infer_unity_blend_mode(material: &ParsedUnityMaterial, shader: Option<&ParsedShader>) -> &'static str {
    let float = |key: &str| material.float_values.get(key).copied();
    let keyword = |key: &str| material.keywords.iter().any(|value| value == key);
    let from_factors = |source: &str, destination: &str| match (source, destination) {
        ("SrcAlpha", "OneMinusSrcAlpha") => Some("alpha"),
        ("One", "OneMinusSrcAlpha") => Some("premultiply"),
        ("One", "One") | ("SrcAlpha", "One") => Some("additive"),
        ("DstColor", "Zero") | ("Zero", "SrcColor") => Some("multiply"),
        _ => None,
    };
    // UnityEngine.Rendering.BlendMode values as stored in _SrcBlend / _DstBlend.
    let factor_name = |value: f32| match value as i32 {
        0 => "Zero",
        1 => "One",
        2 => "DstColor",
        3 => "SrcColor",
        5 => "SrcAlpha",
        10 => "OneMinusSrcAlpha",
        _ => "",
    };

    if let Some(blend) = shader.and_then(|shader| shader.blend.as_deref()) {
        let mut operands = blend.split_whitespace();
        let (source, destination) = (operands.next().unwrap_or_default(), operands.next().unwrap_or_default());
        let resolve = |operand: &str| match operand.strip_prefix('[').and_then(|inner| inner.strip_suffix(']')) {
            Some(property) => float(property).map(factor_name).unwrap_or_default().to_string(),
            None => operand.to_string(),
        };

        if let Some(mode) = from_factors(&resolve(source), &resolve(destination)) {
            return mode;
        }
    }

    if float("_Surface").unwrap_or(0.0) >= 1.0 || keyword("_SURFACE_TYPE_TRANSPARENT") {
        return match float("_Blend").unwrap_or(0.0) as i32 {
            1 => "premultiply",
            2 => "additive",
            3 => "multiply",
            _ => "alpha",
        };
    }

    // Built-in Standard shader rendering mode.
    match float("_Mode").map(|mode| mode as i32) {
        Some(1) => return "cutout",
        Some(2) => return "alpha",
        Some(3) => return "premultiply",
        _ => {}
    }

    if keyword("_ALPHABLEND_ON") {
        return "alpha";
    }
    if keyword("_ALPHAPREMULTIPLY_ON") {
        return "premultiply";
    }
    if float("_AlphaClip").unwrap_or(0.0) >= 1.0 || keyword("_ALPHATEST_ON") {
        return "cutout";
    }

    let render_type = shader.and_then(|shader| shader.render_type.as_deref()).unwrap_or_default();
    let queue = shader.and_then(|shader| shader.queue.as_deref()).unwrap_or_default();
    if render_type == "TransparentCutout" || queue.starts_with("AlphaTest") {
        return "cutout";
    }
    if render_type == "Transparent" || queue.starts_with("Transparent") || material.custom_render_queue.is_some_and(|queue| queue >= 3000) {
        return "alpha";
    }

    "opaque"
}

async fn build_unity_material_preview_source(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    key: &str,
    label: &str,
    material: &ParsedUnityMaterial,
) -> GitResult<UnityMaterialPreviewSource> {
    let mut notes = Vec::new();

    let mut wanted_guids = material.texture_slots.iter().filter_map(|slot| slot.guid.clone()).collect::<Vec<_>>();
    wanted_guids.extend(material.shader_guid.clone());
    let asset_paths = lookup_unity_asset_paths(repo_root, &wanted_guids);

    // 1. The shader: its own source when it lives in the project, else a known built-in id.
    let shader_path = material.shader_guid.as_ref().and_then(|guid| asset_paths.get(guid)).cloned();
    let mut shader = None;
    if let Some(path) = shader_path.as_ref() {
        if let Some(bytes) = read_material_texture_bytes(repo_root, source_kind, path).await? {
            shader = parse_shader(path, &String::from_utf8_lossy(&bytes));
        }
    }
    let well_known = well_known_unity_shader(material.shader_guid.as_deref(), material.shader_file_id.as_deref());
    let shader_name = shader
        .as_ref()
        .map(|shader| shader.name.clone())
        .or_else(|| well_known.map(|(name, _)| name.to_string()));
    let shader_source = match (shader.as_ref(), well_known) {
        (Some(shader), _) => shader.source_kind,
        (None, Some(_)) => "Built-in",
        (None, None) => "Not found",
    };

    // 2. The property list. A .mat keeps values from every shader it was ever assigned, so the
    //    shader's declarations are what separates live properties from stale leftovers.
    let shader_declares = shader.as_ref().is_some_and(|shader| !shader.properties.is_empty());
    let declared = if shader_declares {
        shader.as_ref().map(|shader| shader.properties.clone()).unwrap_or_default()
    } else {
        material_declared_properties(material)
    };
    let slot_of = |name: &str| material.texture_slots.iter().find(|slot| slot.property_name == name);
    let assigned_guid = |name: &str| slot_of(name).and_then(|slot| slot.guid.clone());

    let mut roles = HashMap::<&'static str, usize>::new();
    for (index, property) in declared.iter().enumerate() {
        let Some(role) = classify_unity_property(property) else {
            continue;
        };
        // A texture slot only fills a role when the material actually assigns something to it.
        if property.kind != ShaderPropertyKind::Texture || assigned_guid(&property.name).is_some() {
            roles.entry(role).or_insert(index);
        }
    }

    if shader_declares {
        // Custom shaders rarely follow naming conventions: fall back to declaration order.
        if !roles.contains_key("baseMap") {
            if let Some(index) = declared.iter().position(|property| {
                property.kind == ShaderPropertyKind::Texture
                    && classify_unity_property(property).is_none()
                    && assigned_guid(&property.name).is_some()
            }) {
                roles.insert("baseMap", index);
            }
        }
        if !roles.contains_key("baseColor") {
            if let Some(index) = declared.iter().position(|property| {
                property.kind == ShaderPropertyKind::Color
                    && classify_unity_property(property).is_none()
                    && !property.has_attribute("hdr")
            }) {
                roles.insert("baseColor", index);
            }
        }
    }
    let role_of = |index: usize| roles.iter().find(|(_, role_index)| **role_index == index).map(|(role, _)| *role);

    // 3. Textures that the preview surface can use.
    let mut textures = Vec::new();
    let mut missing_textures = Vec::new();
    let mut oversized_textures = Vec::new();
    for role in ["baseMap", "normalMap", "emissionMap", "metallicMap", "maskMap", "occlusionMap"] {
        let Some(property) = roles.get(role).map(|index| &declared[*index]) else {
            continue;
        };
        let Some(guid) = assigned_guid(&property.name) else {
            continue;
        };
        let Some(texture_path) = asset_paths.get(&guid) else {
            missing_textures.push(property.name.clone());
            continue;
        };
        let extension = Path::new(texture_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !is_previewable_image_extension(&extension) {
            continue;
        }
        let Some(bytes) = read_material_texture_bytes(repo_root, source_kind, texture_path).await? else {
            missing_textures.push(property.name.clone());
            continue;
        };
        if (bytes.len() as u64) > MAX_INLINE_IMAGE_BYTES {
            oversized_textures.push(property.name.clone());
            continue;
        }

        textures.push(UnityMaterialTexturePreview {
            key: property.name.clone(),
            property_name: property.name.clone(),
            label: property.display_name.clone(),
            relative_path: texture_path.clone(),
            mime_type: infer_mime_type(&extension).to_string(),
            encoded_bytes_base64: BASE64.encode(bytes),
            is_psd: extension == "psd",
            format: extension,
        });
    }
    let texture_key = |role: &str| {
        roles
            .get(role)
            .map(|index| declared[*index].name.clone())
            .filter(|name| textures.iter().any(|texture| &texture.key == name))
    };

    // 4. Values: what the material saved, else the shader's declared default.
    let float_of = |role: &str| {
        roles.get(role).and_then(|index| {
            let property = &declared[*index];
            material
                .float_values
                .get(&property.name)
                .copied()
                .or_else(|| property.default_value.trim().parse::<f32>().ok())
        })
    };
    let color_of = |role: &str| {
        roles.get(role).and_then(|index| {
            let property = &declared[*index];
            material
                .color_values
                .get(&property.name)
                .cloned()
                .or_else(|| parse_unity_default_vector(&property.default_value))
        })
    };

    let properties = declared
        .iter()
        .enumerate()
        .map(|(index, property)| {
            let hdr = property.has_attribute("hdr");
            let (kind, value, color, is_default) = match property.kind {
                ShaderPropertyKind::Texture => {
                    let guid = assigned_guid(&property.name);
                    let value = match guid.as_ref() {
                        Some(guid) => asset_paths.get(guid).cloned().unwrap_or_else(|| format!("missing (guid {guid})")),
                        None if property.default_value.is_empty() => "None".to_string(),
                        None => format!("None ({})", property.default_value),
                    };
                    ("texture", value, None, guid.is_none())
                }
                ShaderPropertyKind::Color | ShaderPropertyKind::Vector => {
                    let saved = material.color_values.get(&property.name).cloned();
                    let resolved = saved.clone().or_else(|| parse_unity_default_vector(&property.default_value));
                    let is_color = property.kind == ShaderPropertyKind::Color;
                    let value = match resolved.as_ref() {
                        Some(color) if is_color => format_unity_color(color, hdr),
                        Some(vector) => format!(
                            "({}, {}, {}, {})",
                            format_unity_number(vector.r),
                            format_unity_number(vector.g),
                            format_unity_number(vector.b),
                            format_unity_number(vector.a)
                        ),
                        None => "unset".to_string(),
                    };
                    (
                        if is_color { "color" } else { "vector" },
                        value,
                        resolved.filter(|_| is_color),
                        saved.is_none(),
                    )
                }
                _ => {
                    let saved = material.float_values.get(&property.name).copied();
                    let resolved = saved.or_else(|| property.default_value.trim().parse::<f32>().ok());
                    (
                        "number",
                        resolved.map(format_unity_number).unwrap_or_else(|| "unset".to_string()),
                        None,
                        saved.is_none(),
                    )
                }
            };

            UnityMaterialProperty {
                name: property.name.clone(),
                display_name: property.display_name.clone(),
                kind: kind.to_string(),
                value,
                color,
                role: role_of(index).map(ToString::to_string),
                is_default,
                hidden: property.has_attribute("hideininspector"),
            }
        })
        .collect::<Vec<_>>();

    // 5. Surface settings.
    let shader_family = match (shader.as_ref(), well_known) {
        (Some(shader), _) => if shader.lit { "lit" } else { "unlit" }.to_string(),
        (None, Some((_, lit))) => if lit { "lit" } else { "unlit" }.to_string(),
        (None, None) => infer_unity_shader_family(material, &textures),
    };
    let blend_mode = infer_unity_blend_mode(material, shader.as_ref());
    let cull = shader.as_ref().and_then(|shader| shader.cull.clone()).unwrap_or_else(|| "[_Cull]".to_string());
    let double_sided = match cull.strip_prefix('[').and_then(|inner| inner.strip_suffix(']')) {
        Some(property) => material.float_values.get(property).is_some_and(|value| *value == 0.0),
        None => cull.eq_ignore_ascii_case("off"),
    } || material.float_values.get("_DoubleSidedEnable").is_some_and(|value| *value >= 1.0);

    let emission_color = color_of("emissionColor");
    let emission_keyword_gated = shader
        .as_ref()
        .map(|shader| shader.emission_keyword)
        .unwrap_or_else(|| well_known.is_some_and(|(name, lit)| lit && !name.starts_with("HDRP")));
    let emission_enabled = if emission_keyword_gated {
        material.keywords.iter().any(|keyword| keyword == "_EMISSION")
    } else {
        emission_color.as_ref().is_some_and(unity_color_has_visible_energy)
    };

    let base_slot = roles.get("baseMap").and_then(|index| slot_of(&declared[*index].name));
    let smoothness = float_of("smoothness").or_else(|| float_of("roughness").map(|roughness| 1.0 - roughness));
    let (metallic_texture_key, metallic_texture_layout) = match (texture_key("maskMap"), texture_key("metallicMap")) {
        (Some(mask), _) => (Some(mask), Some("mask".to_string())),
        (None, Some(metallic)) => (Some(metallic), Some("metallic".to_string())),
        (None, None) => (None, None),
    };

    // 6. Tell the user what the preview could not honour.
    let stock = shader_name.as_deref().is_some_and(is_stock_unity_shader);
    if let Some(shader) = shader.as_ref().filter(|_| !stock) {
        notes.extend(shader.skipped.iter().cloned());
    }
    if shader.is_none() && well_known.is_none() {
        notes.push(match material.shader_guid.as_deref() {
            Some(guid) => format!(
                "The shader file (guid {guid}) is not in this repository, so properties are read from the material alone and may include leftovers from other shaders."
            ),
            None => "This material does not reference a shader file; properties are read from the material alone.".to_string(),
        });
    }
    if shader_declares {
        let declared_names = declared.iter().map(|property| property.name.as_str()).collect::<std::collections::HashSet<_>>();
        let stale = material
            .texture_slots
            .iter()
            .filter(|slot| slot.guid.is_some())
            .map(|slot| slot.property_name.as_str())
            .chain(material.color_values.keys().map(String::as_str))
            .chain(material.float_values.keys().map(String::as_str))
            .filter(|name| !declared_names.contains(name))
            .count();
        if stale > 0 {
            notes.push(format!(
                "{stale} saved value(s) belong to a previously assigned shader and are ignored."
            ));
        }
    }
    if !missing_textures.is_empty() {
        notes.push(format!("Texture file not found in this repository for: {}.", missing_textures.join(", ")));
    }
    if !oversized_textures.is_empty() {
        notes.push(format!("Texture too large to preview inline for: {}.", oversized_textures.join(", ")));
    }

    let shape_hint = match shader_name.as_deref() {
        Some(name) if name.starts_with("Sprites/") || name.starts_with("UI/") || name.contains("Sprite") || name.contains("Particle") => "plane",
        _ => "sphere",
    };

    Ok(UnityMaterialPreviewSource {
        key: key.to_string(),
        label: label.to_string(),
        source_kind: key.to_string(),
        material_name: material.material_name.clone(),
        shader_label: shader_name.clone().unwrap_or_else(|| "Unknown shader".to_string()),
        shader_path,
        shader_source: shader_source.to_string(),
        render_pipeline: shader.as_ref().and_then(|shader| shader.render_pipeline.clone()),
        shader_family,
        surface_kind: blend_mode.to_string(),
        double_sided,
        base_color: color_of("baseColor"),
        emission_color,
        emission_enabled,
        metallic: float_of("metallic"),
        smoothness,
        normal_scale: float_of("normalScale"),
        occlusion_strength: float_of("occlusionStrength"),
        cutoff: (blend_mode == "cutout").then(|| float_of("cutoff").unwrap_or(0.5)),
        base_tiling: base_slot.map(|slot| [slot.scale.0, slot.scale.1, slot.offset.0, slot.offset.1]),
        render_queue: material.custom_render_queue,
        keywords: material.keywords.clone(),
        preview_shape_hint: shape_hint.to_string(),
        notes,
        base_texture_key: texture_key("baseMap"),
        normal_texture_key: texture_key("normalMap"),
        emission_texture_key: texture_key("emissionMap"),
        occlusion_texture_key: texture_key("occlusionMap"),
        metallic_texture_key,
        metallic_texture_layout,
        textures,
        properties,
    })
}

async fn read_material_texture_bytes(
    repo_root: &Path,
    source_kind: PreviewBlobSource,
    relative_asset_path: &str,
) -> GitResult<Option<Vec<u8>>> {
    let from_disk = || match resolve_repo_file(repo_root, relative_asset_path) {
        Ok(resolved) => fs::read(resolved).ok(),
        Err(_) => None,
    };
    let from_git = match source_kind {
        PreviewBlobSource::WorkingTree => return Ok(from_disk()),
        PreviewBlobSource::Staged => git_show_optional_bytes(repo_root, format!(":{relative_asset_path}"), relative_asset_path).await?,
        PreviewBlobSource::Head => git_show_optional_bytes(repo_root, format!("HEAD:{relative_asset_path}"), relative_asset_path).await?,
    };

    // Package shaders and textures live in Unity's ignored cache and only exist on disk.
    Ok(from_git.or_else(from_disk))
}

#[derive(Default)]
struct UnityGuidIndex {
    paths: HashMap<String, String>,
    walked_at: Option<Instant>,
}

static UNITY_GUID_INDEX: OnceLock<Mutex<HashMap<PathBuf, UnityGuidIndex>>> = OnceLock::new();

/// Resolves Unity asset GUIDs to repo-relative paths through the `.meta` files.
fn lookup_unity_asset_paths(repo_root: &Path, guids: &[String]) -> HashMap<String, String> {
    let mut indexes = UNITY_GUID_INDEX
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let index = indexes.entry(repo_root.to_path_buf()).or_default();
    let still_exists = |relative: &String| repo_root.join(format!("{relative}.meta")).is_file();
    let has_miss = guids.iter().any(|guid| !index.paths.get(guid).is_some_and(still_exists));

    // ponytail: a miss re-walks every .meta, at most once per 10s per repo. Move to a file
    // watcher if projects grow large enough for that walk to be felt.
    if has_miss && index.walked_at.is_none_or(|at| at.elapsed() > Duration::from_secs(10)) {
        index.paths = walk_unity_meta_files(repo_root);
        index.walked_at = Some(Instant::now());
    }

    guids
        .iter()
        .filter_map(|guid| {
            index
                .paths
                .get(guid)
                .filter(|relative| still_exists(relative))
                .map(|relative| (guid.clone(), relative.clone()))
        })
        .collect()
}

fn walk_unity_meta_files(repo_root: &Path) -> HashMap<String, String> {
    let mut paths = HashMap::new();
    let mut pending = vec![repo_root.to_path_buf()];
    let mut package_caches = Vec::new();

    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let is_unity_project_root = directory.join("Assets").is_dir();

        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();

            if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
                match name.as_str() {
                    ".git" | "node_modules" | "target" | "dist" => {}
                    "Temp" | "Logs" | "obj" | "UserSettings" if is_unity_project_root => {}
                    // Library is Unity's cache; only its package sources carry stock shaders.
                    "Library" if is_unity_project_root => package_caches.push(path.join("PackageCache")),
                    _ => pending.push(path),
                }
                continue;
            }

            if !name.ends_with(".meta") {
                continue;
            }

            let Some(guid) = read_unity_meta_guid(&path) else {
                continue;
            };
            let Ok(relative) = path.strip_prefix(repo_root) else {
                continue;
            };
            let relative = relative.to_string_lossy().replace('\\', "/");
            // Project assets are walked before package caches and win on duplicates.
            paths
                .entry(guid)
                .or_insert_with(|| relative.trim_end_matches(".meta").to_string());
        }

        if pending.is_empty() {
            pending.extend(package_caches.drain(..).filter(|cache| cache.is_dir()));
        }
    }

    paths
}

fn read_unity_meta_guid(meta_path: &Path) -> Option<String> {
    // The guid sits on the second line; reading the head keeps a 50k-asset walk cheap.
    let mut buffer = [0u8; 256];
    let read = fs::File::open(meta_path).ok()?.read(&mut buffer).ok()?;
    String::from_utf8_lossy(&buffer[..read])
        .lines()
        .find_map(|line| line.strip_prefix("guid:"))
        .map(|guid| guid.trim().to_string())
}

/// Heuristic used only when neither the shader source nor a known built-in id is available.
fn infer_unity_shader_family(material: &ParsedUnityMaterial, textures: &[UnityMaterialTexturePreview]) -> String {
    let has_base_map = has_unity_texture_slot(material, &["_BaseMap", "_MainTex", "_BaseColorMap"])
        || textures.iter().any(|texture| matches!(texture.property_name.as_str(), "_BaseMap" | "_MainTex" | "_BaseColorMap"));
    let has_metallic = material.float_values.contains_key("_Metallic");
    let has_smoothness = material.float_values.contains_key("_Smoothness") || material.float_values.contains_key("_Glossiness");
    let has_emission = material
        .color_values
        .get("_EmissionColor")
        .or_else(|| material.color_values.get("_EmissiveColor"))
        .is_some_and(unity_color_has_visible_energy)
        || has_unity_texture_slot(material, &["_EmissionMap", "_EmissiveColorMap"])
        || textures.iter().any(|texture| matches!(texture.property_name.as_str(), "_EmissionMap" | "_EmissiveColorMap"));

    if has_base_map && has_metallic && has_smoothness {
        return "lit".to_string();
    }

    if has_base_map || has_emission {
        return "unlit".to_string();
    }

    "custom".to_string()
}

fn has_unity_texture_slot(material: &ParsedUnityMaterial, keys: &[&str]) -> bool {
    material.texture_slots.iter().any(|slot| slot.guid.is_some() && keys.iter().any(|key| slot.property_name == *key))
}

fn unity_color_has_visible_energy(color: &UnityColorValue) -> bool {
    color.r > 0.0001 || color.g > 0.0001 || color.b > 0.0001
}

fn build_unity_material_asset_summary(source: &UnityMaterialPreviewSource) -> AssetSummary {
    let detail = |label: &str, value: String| AssetDetail {
        label: label.to_string(),
        value,
    };
    let mut details = vec![
        detail("Material", source.material_name.clone()),
        detail("Shader", source.shader_label.clone()),
        detail(
            "Shader source",
            match source.shader_path.as_ref() {
                Some(path) => format!("{} ({path})", source.shader_source),
                None => source.shader_source.clone(),
            },
        ),
        detail("Lighting", source.shader_family.clone()),
        detail("Blending", source.surface_kind.clone()),
        detail("Culling", if source.double_sided { "Two sided" } else { "Back faces" }.to_string()),
        detail("Textures in preview", source.textures.len().to_string()),
    ];

    if let Some(pipeline) = source.render_pipeline.as_ref() {
        details.push(detail("Render pipeline", pipeline.clone()));
    }
    if let Some(queue) = source.render_queue {
        details.push(detail("Render queue", queue.to_string()));
    }
    if !source.keywords.is_empty() {
        details.push(detail("Keywords", source.keywords.join(" ")));
    }

    AssetSummary {
        asset_kind: "Unity material".to_string(),
        pipeline_state: source.shader_source.clone(),
        details,
    }
}

async fn git_show_optional_bytes(repo_root: &Path, object_spec: String, relative_path: &str) -> GitResult<Option<Vec<u8>>> {
    match run_git_bytes_owned(repo_root, vec!["show".into(), object_spec]).await {
        Ok(bytes) => hydrate_lfs_preview_bytes(repo_root, relative_path, bytes).await.map(Some),
        Err(GitServiceError::GitCommandFailed(message)) if is_missing_git_object_error(&message) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn hydrate_lfs_preview_bytes(repo_root: &Path, relative_path: &str, bytes: Vec<u8>) -> GitResult<Vec<u8>> {
    if !is_git_lfs_pointer_bytes(&bytes) {
        return Ok(bytes);
    }

    match run_git_bytes_owned_with_input(
        repo_root,
        vec!["lfs".into(), "smudge".into(), "--".into(), relative_path.to_string()],
        bytes.clone(),
    )
    .await
    {
        Ok(smudged) if !smudged.is_empty() && !is_git_lfs_pointer_bytes(&smudged) => Ok(smudged),
        Ok(_) => Ok(bytes),
        Err(GitServiceError::GitCommandFailed(message)) => {
            let _ = append_log(
                "backend",
                "git.lfs.preview.warn",
                &format!("Failed to smudge LFS preview blob for {relative_path}"),
                Some(&message),
            );
            Ok(bytes)
        }
        Err(error) => Err(error),
    }
}

fn is_git_lfs_pointer_bytes(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };

    let normalized = text.replace("\r\n", "\n");
    normalized.starts_with("version https://git-lfs.github.com/spec/v1\n")
        && normalized.contains("\noid sha256:")
        && normalized.contains("\nsize ")
}

fn is_missing_git_object_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();

    normalized.contains("exists on disk, but not in")
        || normalized.contains("does not exist in")
        || normalized.contains("path '" ) && normalized.contains("exists on disk, but not in 'head'")
        || normalized.contains("fatal: pathspec")
}

fn looks_like_text(bytes: &[u8]) -> bool {
    let sample = &bytes[..bytes.len().min(4_096)];

    // A multi-byte character cut off at the sample boundary is still text.
    !sample.contains(&0)
        && match std::str::from_utf8(sample) {
            Ok(_) => true,
            Err(error) => error.error_len().is_none(),
        }
}
