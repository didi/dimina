use reqwest::{Client, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

pub type Result<T> = std::result::Result<T, String>;

/// Absolute paths, resolved by the host rather than frontend content.
#[derive(Clone)]
pub struct Options {
    pub runtime_path: PathBuf,
    pub packages_dir: PathBuf,
    pub data_dir: PathBuf,
    pub startup_timeout: Duration,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenAppOptions {
    pub app_id: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: String,
    pub app_id: String,
    pub name: String,
    pub ready: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedApp {
    pub app_id: String,
    pub name: String,
    pub path: String,
    pub imported: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Handshake {
    protocol: u32,
    base_url: String,
    token: String,
}

/// Owns one runtime process. Dropping it also closes stdin and kills the child.
pub struct Dimina {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    http: Client,
    base: Url,
    token: String,
    stopped: AtomicBool,
}

impl Dimina {
    pub async fn start(options: &Options) -> Result<Self> {
        if [
            &options.runtime_path,
            &options.packages_dir,
            &options.data_dir,
        ]
        .iter()
        .any(|path| !path.is_absolute())
        {
            return Err("runtime_path, packages_dir and data_dir must be absolute paths".into());
        }
        let mut command = Command::new(&options.runtime_path);
        command
            .args(["--sdk-host", "--packages-dir"])
            .arg(&options.packages_dir)
            .arg("--data-dir")
            .arg(&options.data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let diagnostics = std::sync::Arc::new(Mutex::new(String::new()));
        let stderr = child.stderr.take().ok_or("Runtime stderr is unavailable")?;
        let log = diagnostics.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buffer = log.lock().await;
                buffer.push_str(&line);
                buffer.push('\n');
                if buffer.len() > 4096 {
                    let mut boundary = buffer.len() - 4096;
                    while !buffer.is_char_boundary(boundary) {
                        boundary += 1;
                    }
                    buffer.drain(..boundary);
                }
            }
        });
        let stdout = child.stdout.take().ok_or("Runtime stdout is unavailable")?;
        let mut lines = BufReader::new(stdout).lines();
        let first = tokio::time::timeout(options.startup_timeout, lines.next_line())
            .await
            .map_err(|_| "Dimina runtime startup timed out".to_string())?
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Dimina runtime exited before its handshake".to_string());
        let first = match first {
            Ok(line) if line.len() <= 65536 => line,
            Ok(_) => return Err("Invalid runtime handshake".into()),
            Err(error) => return Err(format!("{error}: {}", diagnostics.lock().await)),
        };
        let hello: Handshake =
            serde_json::from_str(&first).map_err(|_| "Invalid runtime handshake")?;
        let base = Url::parse(&hello.base_url).map_err(|_| "Invalid runtime URL")?;
        if hello.protocol != 1
            || base.scheme() != "http"
            || base.host_str() != Some("127.0.0.1")
            || !base.path().ends_with("/sdk/control/")
            || hello.token.len() != 48
            || !hello
                .token
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("Unsupported runtime handshake".into());
        }
        tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
        let stdin = child.stdin.take();
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            base,
            token: hello.token,
            http: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(100))
                .build()
                .map_err(|e| e.to_string())?,
            stopped: AtomicBool::new(false),
        })
    }

    pub async fn is_running(&self) -> bool {
        !self.stopped.load(Ordering::SeqCst)
            && matches!(self.child.lock().await.try_wait(), Ok(None))
    }

    async fn request<T: DeserializeOwned>(&self, method: &str, body: Option<Value>) -> Result<T> {
        let url = self.base.join(method).map_err(|e| e.to_string())?;
        let request = if method == "windows" {
            self.http.get(url)
        } else {
            self.http.post(url).json(&body.unwrap_or(json!({})))
        };
        let response = request
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let envelope: Value = response
            .json()
            .await
            .map_err(|_| format!("Invalid runtime response (HTTP {status})"))?;
        if let Some(error) = envelope.get("error").and_then(Value::as_str) {
            if !error.is_empty() {
                return Err(error.into());
            }
        }
        if !status.is_success() {
            return Err(format!("Runtime HTTP {status}"));
        }
        serde_json::from_value(envelope.get("value").cloned().unwrap_or(Value::Null))
            .map_err(|e| e.to_string())
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, body: Option<Value>) -> Result<T> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("Dimina runtime is stopped".into());
        }
        self.request(method, body).await
    }

    pub async fn open_app(&self, options: OpenAppOptions) -> Result<WindowInfo> {
        self.call("open", Some(json!(options))).await
    }
    pub async fn windows(&self) -> Result<Vec<WindowInfo>> {
        self.call("windows", None).await
    }
    pub async fn focus(&self, id: &str) -> Result<()> {
        self.call("focus", Some(json!({"id":id}))).await
    }
    pub async fn close_app(&self, id: &str) -> Result<()> {
        self.call("close", Some(json!({"id":id}))).await
    }
    pub async fn close_all(&self) -> Result<()> {
        self.call("closeAll", None).await
    }
    pub async fn import_app(&self, path: PathBuf) -> Result<ImportedApp> {
        if !path.is_absolute() {
            return Err("Package path must be absolute".into());
        }
        self.call("import", Some(json!({"path":path}))).await
    }
    pub async fn dispose(&self) -> Result<()> {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        // Exit remains bounded even if a page stops responding to close events.
        let result =
            tokio::time::timeout(Duration::from_secs(3), self.request::<()>("closeAll", None))
                .await;
        self.stdin.lock().await.take();
        let mut child = self.child.lock().await;
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            child.kill().await.map_err(|e| e.to_string())?;
        }
        result.map_err(|_| "Runtime close timed out".to_string())?
    }
}
