mod git;

use git::{
    create_commit, inspect_file_preview, inspect_repository, list_commit_graph,
    list_commit_history, stage_files, unstage_files,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            inspect_repository,
            inspect_file_preview,
            list_commit_graph,
            list_commit_history,
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
