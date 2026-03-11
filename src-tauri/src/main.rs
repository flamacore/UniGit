mod git;

use git::{
    apply_commit_file_patch, create_commit, export_file_from_commit, inspect_commit_detail,
    inspect_file_preview, inspect_repository, list_commit_graph, list_commit_history,
    list_file_history, force_pull_repository, push_repository, restore_file_from_commit,
    stage_files, unstage_files, log_client_event,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            log_client_event,
            inspect_file_preview,
            inspect_commit_detail,
            list_file_history,
            apply_commit_file_patch,
            export_file_from_commit,
            push_repository,
            force_pull_repository,
            list_commit_graph,
            list_commit_history,
            restore_file_from_commit,
            stage_files,
            unstage_files,
            create_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
