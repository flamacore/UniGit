use serde::Serialize;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub conflicted: bool,
    pub untracked: bool,
    pub ignored: bool,
    pub staged_modified: bool,
    pub display_status: String,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCounts {
    pub staged: usize,
    pub unstaged: usize,
    pub conflicted: usize,
    pub untracked: usize,
    pub ignored: usize,
    pub staged_modified: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySnapshot {
    pub repo_path: String,
    pub repo_name: String,
    pub current_branch: String,
    pub detached_head: bool,
    pub ahead: usize,
    pub behind: usize,
    pub last_refreshed_at: String,
    pub files: Vec<FileChange>,
    pub counts: RepositoryCounts,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub authored_at: String,
    pub subject: String,
    pub decorations: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphRow {
    pub hash: String,
    pub short_hash: String,
    pub parent_hashes: Vec<String>,
    pub display_branch: String,
    pub author_name: String,
    pub authored_at: String,
    pub subject: String,
    pub decorations: String,
    pub lane: usize,
    pub active_lanes: Vec<usize>,
    pub merge_commit: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitGraphPage {
    pub rows: Vec<CommitGraphRow>,
    pub has_more: bool,
    pub next_skip: usize,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileEntry {
    pub path: String,
    pub status: String,
    pub additions: Option<usize>,
    pub deletions: Option<usize>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub parent_hashes: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: String,
    pub committer_name: String,
    pub committed_at: String,
    pub subject: String,
    pub body: String,
    pub decorations: String,
    pub files: Vec<CommitFileEntry>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub authored_at: String,
    pub subject: String,
    pub decorations: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchEntry {
    pub full_name: String,
    pub name: String,
    pub branch_kind: String,
    pub remote_name: Option<String>,
    pub tracking_name: Option<String>,
    pub tracking_state: Option<String>,
    pub is_current: bool,
    pub commit_hash: String,
    pub subject: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemote {
    pub name: String,
    pub fetch_url: Option<String>,
    pub push_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfig {
    pub repo_path: String,
    pub repo_name: String,
    pub current_branch: String,
    pub detached_head: bool,
    pub remotes: Vec<RepositoryRemote>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub repo_path: String,
    pub repo_name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub relative_path: String,
    pub file_name: String,
    pub extension: String,
    pub preview_kind: String,
    pub mime_type: String,
    pub file_size_bytes: u64,
    pub modified_at: Option<u64>,
    pub image_data_url: Option<String>,
    pub text_excerpt: Option<String>,
    pub staged_diff: Option<String>,
    pub unstaged_diff: Option<String>,
    pub asset_summary: Option<AssetSummary>,
    pub support_hint: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetSummary {
    pub asset_kind: String,
    pub pipeline_state: String,
    pub details: Vec<AssetDetail>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetDetail {
    pub label: String,
    pub value: String,
}
