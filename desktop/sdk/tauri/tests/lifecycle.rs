#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::Duration,
};
use tauri_plugin_dimina::{Dimina, Options};

fn fixture(protocol: Option<u32>) -> (tempfile::TempDir, Options) {
    let dir = tempfile::Builder::new()
        .prefix("dimina sdk ")
        .tempdir()
        .unwrap();
    let runtime = dir.path().join("runtime");
    let hello = protocol.map(|version| format!("printf '%s\\n' '{{\"protocol\":{version},\"baseUrl\":\"http://127.0.0.1:1/random/sdk/control/\",\"token\":\"ffffffffffffffffffffffffffffffffffffffffffffffff\"}}'\n")).unwrap_or_default();
    fs::write(
        &runtime,
        format!("#!/bin/sh\necho $$ > \"${{0%/*}}/pid\"\n{hello}exec sleep 60\n"),
    )
    .unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let options = Options {
        runtime_path: runtime,
        packages_dir: dir.path().into(),
        data_dir: dir.path().into(),
        startup_timeout: Duration::from_secs(3),
    };
    (dir, options)
}

async fn assert_reaped(options: &Options) {
    let pid = fs::read_to_string(options.data_dir.join("pid")).unwrap();
    for _ in 0..100 {
        let alive = Command::new("kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success();
        if !alive {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let _ = Command::new("kill").args(["-KILL", pid.trim()]).status();
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
