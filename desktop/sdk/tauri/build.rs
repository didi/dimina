fn main() {
    tauri_plugin::Builder::new(&[
        "start",
        "open",
        "focus",
        "close",
        "close_all",
        "windows",
        "set_diagnostics_enabled",
        "get_diagnostics_json",
        "import",
        "dispose",
    ])
    .build();
}
