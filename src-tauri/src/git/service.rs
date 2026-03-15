use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use tauri::command;
use thiserror::Error;
use tokio::process::Command;

use super::models::{
    AssetDetail, AssetSummary, BranchEntry, CommitDetail, CommitFileEntry,
    CloneResult, CommitGraphPage, CommitGraphRow, CommitSummary, FileChange,
    FileHistoryEntry, FilePreview, RepositoryConfig, RepositoryCounts,
    RepositoryRemote, RepositorySnapshot,
};

const MAX_INLINE_IMAGE_BYTES: u64 = 8 * 1024 * 1024;
const LOG_DETAIL_LIMIT: usize = 6_000;

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
pub async fn log_client_event(scope: String, message: String, detail: Option<String>) -> Result<(), String> {
    append_log("frontend", &scope, &message, detail.as_deref())
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
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1"])
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
    let branch_output = run_git(path, ["status", "--branch", "--porcelain=v1"])
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

    let preview_kind = if is_image_extension(&extension) {
        if file_size_bytes <= MAX_INLINE_IMAGE_BYTES {
            let bytes = fs::read(&resolved_path)
                .map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
            image_data_url = Some(format!("data:{mime_type};base64,{}", BASE64.encode(bytes)));
        }

        unstaged_diff = git_diff(repo_root, &relative_path, false).await?;
        staged_diff = git_diff(repo_root, &relative_path, true).await?;

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
        "image" if image_data_url.is_some() => "Inline image preview is active in this slice.".to_string(),
        "image" => "Image preview is recognized, but this file is too large for inline transfer in the current slice.".to_string(),
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
    let trimmed = full_name.trim();

    if let Some(local_name) = trimmed.strip_prefix("refs/heads/") {
        run_git_owned(path, vec!["switch".into(), local_name.to_string()]).await?;
        return Ok(format!("Switched to {local_name}."));
    }

    if let Some(remote_branch) = trimmed.strip_prefix("refs/remotes/") {
        let mut segments = remote_branch.split('/');
        let remote_name = segments.next().unwrap_or_default();
        let branch_name = segments.collect::<Vec<_>>().join("/");

        if remote_name.is_empty() || branch_name.is_empty() {
            return Err(GitServiceError::GitCommandFailed("Remote branch is malformed.".to_string()));
        }

        let local_exists = !run_git_owned(path, vec!["branch".into(), "--list".into(), branch_name.clone()])
            .await?
            .trim()
            .is_empty();

        if local_exists {
            run_git_owned(path, vec!["switch".into(), branch_name.clone()]).await?;
        } else {
            run_git_owned(
                path,
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

    run_git_owned(
        path,
        vec!["branch".into(), "-m".into(), local_name.to_string(), next_trimmed.to_string()],
    )
    .await?;

    Ok(format!("Renamed {local_name} to {next_trimmed}."))
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

        run_git_owned(
            path,
            vec!["push".into(), remote_name.to_string(), "--delete".into(), branch_name.clone()],
        )
        .await?;

        return Ok(format!("Deleted remote branch {remote_name}/{branch_name}."));
    }

    Err(GitServiceError::GitCommandFailed("Unsupported branch reference.".to_string()))
}

async fn push_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let output = run_git_owned(path, vec!["push".into()]).await?;
    let trimmed = output.trim();

    if trimmed.is_empty() {
        Ok("Push completed.".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

async fn fetch_repository_inner(repo_path: String) -> GitResult<String> {
    let path = validate_repository_path(&repo_path)?;
    let output = run_git_owned(path, vec!["fetch".into(), "--prune".into(), "--tags".into()]).await?;
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
        run_git_owned(path, vec!["pull".into(), "--no-rebase".into()]).await?
    } else {
        run_git_owned(path, vec!["pull".into(), "--ff-only".into()]).await?
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

    run_git_owned(path, vec!["fetch".into(), "--prune".into(), "--tags".into()]).await?;
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
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
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
    matches!(extension, "psd" | "fbx" | "glb" | "gltf" | "blend" | "tga" | "exr")
}

fn looks_like_text(path: &Path) -> GitResult<bool> {
    let bytes = fs::read(path).map_err(|error| GitServiceError::FilePreviewFailed(error.to_string()))?;
    let sample = &bytes[..bytes.len().min(4_096)];

    if sample.contains(&0) {
        return Ok(false);
    }

    Ok(std::str::from_utf8(sample).is_ok())
}
