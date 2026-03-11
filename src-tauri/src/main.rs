mod git;

use git::{
    create_commit, export_file_from_commit, inspect_commit_detail, inspect_file_preview,
    inspect_repository, list_commit_graph, list_commit_history, restore_file_from_commit,
    stage_files, unstage_files,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            inspect_file_preview,
            inspect_commit_detail,
            export_file_from_commit,
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
