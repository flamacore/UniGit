mod git;

use git::{
    apply_commit_file_patch, create_commit, delete_branch, export_file_from_commit,
    inspect_commit_detail, inspect_file_preview, inspect_repository,
    inspect_repository_config, list_branches, list_commit_graph, list_commit_history,
    list_file_history, clone_repository, delete_repository_remote, fetch_repository,
    force_pull_repository, pull_repository, push_repository, rename_branch,
    restore_file_from_commit, save_repository_remote, stage_files, switch_branch,
    unstage_files, log_client_event,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            inspect_repository_config,
            clone_repository,
            save_repository_remote,
            delete_repository_remote,
            log_client_event,
            inspect_file_preview,
            inspect_commit_detail,
            list_branches,
            switch_branch,
            rename_branch,
            delete_branch,
            list_file_history,
            apply_commit_file_patch,
            export_file_from_commit,
            fetch_repository,
            pull_repository,
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
