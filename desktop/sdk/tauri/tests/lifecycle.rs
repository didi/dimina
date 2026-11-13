#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
    time::Duration,
};
use tauri_plugin_dimina::{Dimina, NativeApiOptions, Options};

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

#[tokio::test]
async fn dispose_reaps_runtime_when_native_reply_fills_stdin() {
    let dir = tempfile::Builder::new()
        .prefix("dimina pipe ")
        .tempdir()
        .unwrap();
    let runtime_path = dir.path().join("runtime.mjs");
    let source=r##"#!/usr/bin/env node
import http from 'node:http';
import {writeFileSync} from 'node:fs';
const directory=__DIRECTORY__;
writeFileSync(directory+'/pid',String(process.pid));
const server=http.createServer((request,response)=>{
  request.resume();
  request.on('end',()=>{
    response.setHeader('Content-Type','application/json');response.end('{"value":null}');
    if(request.url.endsWith('/registerApi')) console.log(JSON.stringify({type:'native-call',id:'blocked',appId:'test',windowId:'window',name:'getClipboardData',params:{}}));
  });
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({protocol:1,baseUrl:`http://127.0.0.1:${server.address().port}/random/sdk/control/`,token:'f'.repeat(48)})));
// Leave data unconsumed. Once Node's bounded buffer and the OS pipe fill,
// the SDK response writer holds the stdin lock until the child is killed.
process.stdin.on('readable',()=>writeFileSync(directory+'/blocked',String(process.stdin.readableLength)));
"##.replace("__DIRECTORY__",&serde_json::to_string(dir.path()).unwrap());
    fs::write(&runtime_path, source).unwrap();
    fs::set_permissions(&runtime_path, fs::Permissions::from_mode(0o700)).unwrap();
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
