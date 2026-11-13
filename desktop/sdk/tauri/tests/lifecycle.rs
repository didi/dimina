use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};
use tauri_plugin_dimina::{Dimina, NativeApiOptions, Options};

fn native_runtime(directory: &Path, mode: &str) -> PathBuf {
    let runtime = directory.join(if cfg!(windows) {
        "runtime.exe"
    } else {
        "runtime"
    });
    if let Some(source) = std::env::var_os("DIMINA_TEST_RUNTIME") {
        fs::copy(source, &runtime).unwrap();
    } else {
        // Also works from the published crate: the fixture sources are included.
        let builder =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/testdata/runtime/build.mjs");
        assert!(Command::new("node")
            .arg(builder)
            .arg("--out")
            .arg(&runtime)
            .status()
            .unwrap()
            .success());
    }
    fs::write(
        directory.join("fixture.json"),
        serde_json::to_vec(&serde_json::json!({"mode":mode})).unwrap(),
    )
    .unwrap();
    runtime
}

fn fixture(protocol: Option<u32>) -> (tempfile::TempDir, Options) {
    let dir = tempfile::Builder::new()
        .prefix("dimina sdk ")
        .tempdir()
        .unwrap();
    let mode = match protocol {
        None => "hang",
        Some(1) => "control-failure",
        _ => "wrong",
    };
    let options = Options {
        runtime_path: native_runtime(dir.path(), mode),
        packages_dir: dir.path().into(),
        data_dir: dir.path().into(),
        startup_timeout: Duration::from_secs(3),
    };
    (dir, options)
}

async fn assert_reaped(options: &Options) {
    let pid = fs::read_to_string(options.data_dir.join("pid")).unwrap();
    for _ in 0..100 {
        if !Command::new(&options.runtime_path)
            .args(["--is-running", pid.trim()])
            .status()
            .unwrap()
            .success()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = Command::new(&options.runtime_path)
        .args(["--kill", pid.trim()])
        .status();
    panic!("SDK left its runtime process running");
}

#[tokio::test]
async fn rejects_incompatible_runtime_and_reaps_the_child() {
    let (_dir, options) = fixture(Some(2));
    let error = Dimina::start(&options).await.err().unwrap();
    assert!(error.contains("Unsupported runtime handshake"), "{error}");
    assert_reaped(&options).await;
}

#[tokio::test]
async fn startup_timeout_reaps_the_child() {
    let (_dir, options) = fixture(None);
    assert!(Dimina::start(&options)
        .await
        .err()
        .unwrap()
        .contains("startup timed out"));
    assert_reaped(&options).await;
}

#[tokio::test]
async fn cancelling_startup_reaps_the_child() {
    let (_dir, mut options) = fixture(None);
    options.startup_timeout = Duration::from_secs(30);
    let owned = options.clone();
    let task = tokio::spawn(async move { Dimina::start(&owned).await });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !options.data_dir.join("pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_reaped(&options).await;
}

#[tokio::test]
async fn dispose_reaps_an_unresponsive_runtime_after_control_failure() {
    let (_dir, options) = fixture(Some(1));
    let runtime = Dimina::start(&options).await.unwrap();
    assert!(runtime.dispose().await.is_err());
    assert!(!runtime.is_running().await);
    assert_reaped(&options).await;
}

#[tokio::test]
async fn dispose_reaps_runtime_when_native_reply_fills_stdin() {
    let dir = tempfile::Builder::new()
        .prefix("dimina pipe ")
        .tempdir()
        .unwrap();
    let runtime_path = native_runtime(dir.path(), "backpressure");
    let options = Options {
        runtime_path,
        packages_dir: dir.path().into(),
        data_dir: dir.path().into(),
        startup_timeout: Duration::from_secs(3),
    };
    let runtime = Dimina::start(&options).await.unwrap();
    runtime
        .register_api(
            "getClipboardData",
            NativeApiOptions::default(),
            |_, _| async { Ok(serde_json::json!({"data":"x".repeat(512<<10)})) },
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !dir.path().join("blocked").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("native response did not enter stdin");
    let result = tokio::time::timeout(Duration::from_secs(7), runtime.dispose()).await;
    drop(runtime);
    assert_reaped(&options).await;
    assert!(
        result.is_ok(),
        "dispose blocked on a native response stdin lock"
    );
}
