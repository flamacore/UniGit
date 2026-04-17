#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod git;

use git::{
    add_paths_to_gitignore, apply_commit_file_patch, create_commit, delete_branch,
    conditional_prune_branches, hard_prune_local_branches,
    create_branch, force_switch_branch, merge_branch, resolve_conflicted_files,
    apply_stash, drop_stash, list_stashes, stash_paths,
    detach_head_to_commit,
    discard_paths, export_file_from_commit,
    inspect_commit_detail, inspect_commit_message_context, inspect_file_preview, inspect_repository,
    inspect_repository_config, list_branches, list_commit_graph, list_commit_history,
    list_file_history, clone_repository, delete_repository_remote, fetch_repository,
    force_pull_repository, pull_branch, pull_repository, push_repository, rename_branch,
    restore_file_from_commit, save_repository_remote, save_repository_ssh_settings, stage_files, switch_branch,
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
            save_repository_ssh_settings,
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
            list_stashes,
            stash_paths,
            apply_stash,
            drop_stash,
            detach_head_to_commit,
            rename_branch,
            delete_branch,
            hard_prune_local_branches,
            conditional_prune_branches,
            merge_branch,
            resolve_conflicted_files,
            list_file_history,
            apply_commit_file_patch,
            export_file_from_commit,
            fetch_repository,
            pull_branch,
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
