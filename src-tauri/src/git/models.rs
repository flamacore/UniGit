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
    pub file_size_bytes: Option<u64>,
    /// Set for unmerged paths: both-modified, both-added, both-deleted, added-by-us,
    /// added-by-them, deleted-by-us, deleted-by-them.
    pub conflict_kind: Option<String>,
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
    pub operation: Option<RepositoryOperation>,
}

/// A merge, cherry-pick, revert or rebase that git has started but not concluded.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryOperation {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitLfsPreparationResult {
    pub transcript: String,
    pub attributes_changed: bool,
    pub tracked_patterns: Vec<String>,
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
pub struct StashEntry {
    pub reference: String,
    pub short_hash: String,
    pub created_at: String,
    pub message: String,
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
    pub ahead_count: usize,
    pub behind_count: usize,
    pub is_current: bool,
    pub is_owned_by_me: bool,
    pub is_created_by_me: bool,
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

/// Dry-run description of what merging a branch into HEAD would do.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub target_label: String,
    pub current_branch: String,
    pub up_to_date: bool,
    pub fast_forward: bool,
    pub unrelated_histories: bool,
    pub incoming_commits: usize,
    pub incoming_subjects: Vec<String>,
    pub changed_files: usize,
    /// `None` when this git version cannot predict conflicts without touching the tree.
    pub predicted_conflicts: Option<Vec<String>>,
    pub local_changes: usize,
    pub overlapping_local_changes: Vec<String>,
    pub operation_in_progress: Option<String>,
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
pub struct RepositorySshSettings {
    pub mode: String,
    pub use_user_ssh_config: bool,
    pub private_key_path: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySshKeyOption {
    pub path: String,
    pub label: String,
    pub key_kind: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySshConfigHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub identity_files: Vec<String>,
    pub identities_only: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositorySshDiscovery {
    pub ssh_directory: Option<String>,
    pub user_config_path: Option<String>,
    pub config_hosts: Vec<RepositorySshConfigHost>,
    pub private_keys: Vec<RepositorySshKeyOption>,
    pub open_ssh_command: Option<String>,
    pub putty_command: Option<String>,
    pub pageant_supported: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfig {
    pub repo_path: String,
    pub repo_name: String,
    pub current_branch: String,
    pub detached_head: bool,
    pub remotes: Vec<RepositoryRemote>,
    pub ssh_settings: RepositorySshSettings,
    pub ssh_discovery: RepositorySshDiscovery,
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
    /// Importer settings read from the Unity `.meta` file next to the asset.
    pub import_settings: Option<AssetSummary>,
    pub lfs_tracked: bool,
    pub missing_from_disk: bool,
    pub image_sources: Vec<ImagePreviewSource>,
    pub image_comparison_presets: Vec<ImageComparisonPreset>,
    pub default_image_comparison_preset_key: Option<String>,
    pub unity_material_sources: Vec<UnityMaterialPreviewSource>,
    pub unity_material_comparison_presets: Vec<ImageComparisonPreset>,
    pub default_unity_material_comparison_preset_key: Option<String>,
    pub model_sources: Vec<ModelPreviewSource>,
    pub model_comparison_presets: Vec<ImageComparisonPreset>,
    pub default_model_comparison_preset_key: Option<String>,
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
    /// Lower-case file extension; tells the webview which decoder to use.
    pub format: String,
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
    pub shader_path: Option<String>,
    /// ShaderLab, Shader Graph, Built-in or Not found.
    pub shader_source: String,
    pub render_pipeline: Option<String>,
    pub shader_family: String,
    /// opaque, cutout, alpha, premultiply, additive or multiply.
    pub surface_kind: String,
    pub double_sided: bool,
    pub base_color: Option<UnityColorValue>,
    pub emission_color: Option<UnityColorValue>,
    pub emission_enabled: bool,
    pub metallic: Option<f32>,
    pub smoothness: Option<f32>,
    pub normal_scale: Option<f32>,
    pub occlusion_strength: Option<f32>,
    pub cutoff: Option<f32>,
    /// Base map tiling x/y and offset x/y.
    pub base_tiling: Option<[f32; 4]>,
    pub render_queue: Option<i32>,
    pub keywords: Vec<String>,
    pub preview_shape_hint: String,
    pub notes: Vec<String>,
    pub textures: Vec<UnityMaterialTexturePreview>,
    pub base_texture_key: Option<String>,
    pub normal_texture_key: Option<String>,
    pub emission_texture_key: Option<String>,
    pub occlusion_texture_key: Option<String>,
    pub metallic_texture_key: Option<String>,
    /// "metallic" (R metal, A smoothness) or "mask" (R metal, G occlusion, A smoothness).
    pub metallic_texture_layout: Option<String>,
    pub properties: Vec<UnityMaterialProperty>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnityMaterialProperty {
    pub name: String,
    pub display_name: String,
    /// texture, color, vector or number.
    pub kind: String,
    pub value: String,
    pub color: Option<UnityColorValue>,
    /// Which preview slot this property drives, when it drives one.
    pub role: Option<String>,
    /// True when the material saved no value and the shader default applies.
    pub is_default: bool,
    pub hidden: bool,
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
    pub format: String,
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
pub struct ModelPreviewSource {
    pub key: String,
    pub label: String,
    pub source_kind: String,
    pub format: String,
    pub relative_path: String,
    pub mime_type: String,
    pub encoded_bytes_base64: String,
    pub asset_label: String,
    pub notes: Vec<String>,
    pub external_resources: Vec<ModelPreviewResource>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelPreviewResource {
    pub uri: String,
    pub mime_type: String,
    pub encoded_bytes_base64: String,
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
