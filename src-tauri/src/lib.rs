// The whole app is the web frontend; the native side only provides
// "Save as…" dialogs and file writing for the converted results.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running ConvertAnything");
}
