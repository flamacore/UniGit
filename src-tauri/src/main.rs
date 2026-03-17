#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;

use git::{
    add_paths_to_gitignore, apply_commit_file_patch, create_commit, delete_branch,
    create_branch, force_switch_branch, merge_branch, resolve_conflicted_files,
    discard_paths, export_file_from_commit,
    inspect_commit_detail, inspect_commit_message_context, inspect_file_preview, inspect_repository,
    inspect_repository_config, list_branches, list_commit_graph, list_commit_history,
    list_file_history, clone_repository, delete_repository_remote, fetch_repository,
    force_pull_repository, pull_repository, push_repository, rename_branch,
    restore_file_from_commit, save_repository_remote, stage_files, switch_branch,
    unstage_files, log_client_event, get_log_file_path, clear_git_index_lock,
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
            get_log_file_path,
            clear_git_index_lock,
            inspect_file_preview,
            inspect_commit_detail,
            inspect_commit_message_context,
            discard_paths,
            add_paths_to_gitignore,
            list_branches,
            switch_branch,
            force_switch_branch,
            create_branch,
            rename_branch,
            delete_branch,
            merge_branch,
            resolve_conflicted_files,
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
