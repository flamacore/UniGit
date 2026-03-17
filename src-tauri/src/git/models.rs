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
pub struct CommitMessageContext {
    pub current_branch: String,
    pub staged_files: Vec<String>,
    pub staged_diff: String,
    pub unpushed_commits: Vec<String>,
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
pub struct MergeBranchResult {
    pub status: String,
    pub message: String,
    pub conflicted_files: Vec<String>,
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
    pub image_sources: Vec<ImagePreviewSource>,
    pub image_comparison_presets: Vec<ImageComparisonPreset>,
    pub default_image_comparison_preset_key: Option<String>,
    pub unity_material_sources: Vec<UnityMaterialPreviewSource>,
    pub unity_material_comparison_presets: Vec<ImageComparisonPreset>,
    pub default_unity_material_comparison_preset_key: Option<String>,
    pub support_hint: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreviewSource {
    pub key: String,
    pub label: String,
    pub source_kind: String,
    pub mime_type: String,
    pub byte_size: u64,
    pub encoded_bytes_base64: String,
    pub is_psd: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageComparisonPreset {
    pub key: String,
    pub label: String,
    pub left_source_key: String,
    pub right_source_key: String,
    pub description: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnityMaterialPreviewSource {
    pub key: String,
    pub label: String,
    pub source_kind: String,
    pub material_name: String,
    pub shader_label: String,
    pub shader_family: String,
    pub surface_kind: String,
    pub base_color: Option<UnityColorValue>,
    pub emission_color: Option<UnityColorValue>,
    pub metallic: Option<f32>,
    pub smoothness: Option<f32>,
    pub cutoff: Option<f32>,
    pub preview_shape_hint: String,
    pub notes: Vec<String>,
    pub textures: Vec<UnityMaterialTexturePreview>,
    pub base_texture_key: Option<String>,
    pub normal_texture_key: Option<String>,
    pub emission_texture_key: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnityMaterialTexturePreview {
    pub key: String,
    pub property_name: String,
    pub label: String,
    pub relative_path: String,
    pub mime_type: String,
    pub encoded_bytes_base64: String,
    pub is_psd: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnityColorValue {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
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
