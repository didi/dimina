fn main() {
    tauri_plugin::Builder::new(&[
        "start",
        "open",
        "focus",
        "close",
        "close_all",
        "windows",
        "import",
        "dispose",
    ])
    .build();
}
