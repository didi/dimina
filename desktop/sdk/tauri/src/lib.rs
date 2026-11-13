mod runtime;
use runtime::Result;
pub use runtime::{
    Dimina, ImportedApp, NativeApiContext, NativeApiHandler, NativeApiOptions, OpenAppOptions,
    Options, WindowInfo,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, State,
};
use tokio::sync::{Mutex, Notify};

/// Paths may be absolute or relative to the Tauri resource directory.
pub struct PluginOptions {
    pub runtime_path: PathBuf,
    pub packages_dir: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub startup_timeout: Duration,
    api_handlers: Vec<(String, NativeApiOptions, NativeApiHandler)>,
}
impl PluginOptions {
    pub fn new(runtime_path: impl Into<PathBuf>, packages_dir: impl Into<PathBuf>) -> Self {
        Self {
            runtime_path: runtime_path.into(),
            packages_dir: packages_dir.into(),
            data_dir: None,
            startup_timeout: Duration::from_secs(30),
            api_handlers: Vec::new(),
        }
    }
    pub fn api<F, Fut>(
        mut self,
        name: impl Into<String>,
        options: NativeApiOptions,
        handler: F,
    ) -> Self
    where
        F: Fn(serde_json::Value, NativeApiContext) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<serde_json::Value>> + Send + 'static,
    {
        self.api_handlers.push((
            name.into(),
            options,
            Arc::new(move |params, context| Box::pin(handler(params, context))),
        ));
        self
    }
}

struct PluginState {
    options: Options,
    runtime: Mutex<Option<Arc<Dimina>>>,
    exiting: AtomicBool,
    exit: Notify,
    api_handlers: Vec<(String, NativeApiOptions, NativeApiHandler)>,
}
impl PluginState {
    async fn client(&self) -> Result<Arc<Dimina>> {
        self.runtime
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Call Dimina.start() first".into())
    }
    async fn stop(&self) -> Result<()> {
        let mut slot = self.runtime.lock().await;
        let result = if let Some(runtime) = slot.as_ref() {
            runtime.dispose().await
        } else {
            Ok(())
        };
        slot.take();
        result
    }
}

#[tauri::command]
async fn start(state: State<'_, PluginState>) -> Result<()> {
    let mut slot = state.runtime.lock().await;
    if state.exiting.load(Ordering::SeqCst) {
        return Err("Host application is exiting".into());
    }
    if let Some(runtime) = slot.as_ref() {
        if runtime.is_running().await {
            return Ok(());
        }
    }
    let initialize = async {
        let runtime = Dimina::start(&state.options).await?;
        for (name, options, handler) in &state.api_handlers {
            runtime
                .register_handler(name, options.clone(), handler.clone())
                .await?;
        }
        Ok::<_, String>(runtime)
    };
    let runtime = tokio::select! {
        runtime = initialize => runtime?,
        _ = state.exit.notified() => return Err("Host application is exiting".into()),
    };
    *slot = Some(Arc::new(runtime));
    Ok(())
}
#[tauri::command]
async fn open(state: State<'_, PluginState>, options: OpenAppOptions) -> Result<WindowInfo> {
    state.client().await?.open_app(options).await
}
#[tauri::command]
async fn windows(state: State<'_, PluginState>) -> Result<Vec<WindowInfo>> {
    state.client().await?.windows().await
}
#[tauri::command]
async fn focus(state: State<'_, PluginState>, id: String) -> Result<()> {
    state.client().await?.focus(&id).await
}
#[tauri::command]
async fn close(state: State<'_, PluginState>, id: String) -> Result<()> {
    state.client().await?.close_app(&id).await
}
#[tauri::command]
async fn close_all(state: State<'_, PluginState>) -> Result<()> {
    state.client().await?.close_all().await
}
#[tauri::command]
async fn import(state: State<'_, PluginState>, path: PathBuf) -> Result<ImportedApp> {
    state.client().await?.import_app(path).await
}
#[tauri::command]
async fn dispose(state: State<'_, PluginState>) -> Result<()> {
    state.stop().await
}

pub fn init<R: Runtime>(options: PluginOptions) -> TauriPlugin<R> {
    Builder::new("dimina")
        .invoke_handler(tauri::generate_handler![
            start, open, windows, focus, close, close_all, import, dispose
        ])
        .setup(move |app, _| {
            let resolve = |path: PathBuf| -> tauri::Result<PathBuf> {
                if path.is_absolute() {
                    Ok(path)
                } else {
                    Ok(app.path().resource_dir()?.join(path))
                }
            };
            let data_dir = match options.data_dir {
                Some(path) => path,
                None => app.path().app_data_dir()?.join("dimina"),
            };
            if !data_dir.is_absolute() {
                return Err("Dimina data_dir must be absolute".into());
            }
            app.manage(PluginState {
                options: Options {
                    runtime_path: resolve(options.runtime_path)?,
                    packages_dir: resolve(options.packages_dir)?,
                    data_dir,
                    startup_timeout: options.startup_timeout,
                },
                runtime: Mutex::new(None),
                exiting: AtomicBool::new(false),
                exit: Notify::new(),
                api_handlers: options.api_handlers,
            });
            Ok(())
        })
        .on_event(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<PluginState>() {
                    // Interrupt startup before waiting for the lifecycle lock.
                    state.exiting.store(true, Ordering::SeqCst);
                    state.exit.notify_one();
                    let _ = tauri::async_runtime::block_on(state.stop());
                }
            }
        })
        .build()
}
