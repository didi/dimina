# Tauri 接入

通过 `tauri-plugin-dimina` 在 Tauri 2 的 macOS、Windows、Linux 客户端中打开独立小程序窗口。Rust 插件负责启动配套运行时、转发调用和退出回收；前端通过 `@dimina/desktop-sdk/tauri` 调用。小程序不会嵌入 Tauri 自身的 WebView。

## 安装

先按 [SDK 指南](../README.md) 构建对应平台的运行时与调用库，再在宿主 `src-tauri/Cargo.toml` 中引用插件源码：

```toml
[dependencies]
tauri-plugin-dimina = { path = "/path/to/sdk/dist/tauri" }
```

在宿主前端安装本地 npm 制品。宿主需已安装 Tauri 2 的 `@tauri-apps/api`：

```sh
pnpm add /path/to/sdk/dist/node/dimina-desktop-sdk.tgz
```

## 配置资源与插件

将 `runtime/{platform-arch}/` 中的完整内容复制到宿主的 `src-tauri/dimina-runtime/`，将 Dimina 编译产物放进 `src-tauri/miniapps/{appId}/`。保留 macOS `.app` 内的目录、文件权限和其他平台的原生依赖。

在现有 `tauri.conf.json` 中合并资源配置：

```json
{
  "bundle": {
    "resources": {
      "dimina-runtime/": "dimina-runtime/",
      "miniapps/": "miniapps/"
    }
  }
}
```

在 Rust 入口注册插件：

```rust
pub fn run() {
    #[cfg(target_os = "macos")]
    let runtime = "dimina-runtime/Dimina Desktop.app/Contents/MacOS/Dimina Desktop";
    #[cfg(target_os = "windows")]
    let runtime = "dimina-runtime/Dimina Desktop.exe";
    #[cfg(target_os = "linux")]
    let runtime = "dimina-runtime/dimina-desktop";

    tauri::Builder::default()
        .plugin(tauri_plugin_dimina::init(
            tauri_plugin_dimina::PluginOptions::new(runtime, "miniapps"),
        ))
        .run(tauri::generate_context!())
        .expect("failed to run application");
}
```

相对路径按 Tauri 的资源目录解析；也可以由 Rust 宿主传入绝对路径。默认数据目录为宿主 `app_data_dir()/dimina`，不与独立桌面示例应用共享。需要自定义目录时，可在注册前设置 `PluginOptions.data_dir = Some(absolute_path)`；路径在插件注册时固定。

以上资源复制与路径规则见 [Tauri 资源文档](https://v2.tauri.app/develop/resources/)。打包时仍须完成对应平台运行时依赖、签名和公证，见 [SDK 分发说明](../README.md#发布到已有产品)。

## 允许宿主窗口调用

在现有 `src-tauri/capabilities/default.json` 的权限列表加入 `dimina:default`，并按实际窗口 label 设置 `windows`：

```json
{
  "identifier": "default",
  "windows": ["main"],
  "permissions": ["core:default", "dimina:default"]
}
```

默认权限包含启动、打开、聚焦、关闭、窗口列表和销毁。若宿主还需要从用户选中的绝对路径导入编译产物，额外加入 `dimina:allow-import`。无需配置 shell/process 插件权限，也无需向前端传递运行时可执行文件路径或控制凭据。权限机制遵循 [Tauri 插件规范](https://v2.tauri.app/develop/plugins/#command-permissions)。

## 前端调用

```js
import { Dimina } from '@dimina/desktop-sdk/tauri'

const dimina = await Dimina.start()
const app = await dimina.openApp({ appId: 'your-app-id', name: '我的小程序' })
await app.focus()
await app.close()
// 无需继续使用小程序时：
await dimina.dispose()
```

还提供 `windows()`、`closeAll()`、`importApp(absolutePath)`。方法返回 Promise；启动或打开失败会 reject。`openApp` 等待首屏 DOM 就绪，同 appId 重复打开复用已有窗口；行为与 Node/Electron 入口一致。

一个 Tauri 应用共享一个由插件管理的运行时。`Dimina.start()` 会复用运行中的实例，`dispose()` 会关闭该应用的全部小程序窗口；如需再次使用，可重新 `start()`。不要在组件卸载或热更新时自动销毁整个运行时。宿主应用真正退出时，插件会回收它拥有的运行时；宿主异常退出后，运行时也会通过控制管道断开退出。

Tauri 前端使用 `/tauri` 子入口，Node/Electron 主进程使用包根入口；两者均使用 `Dimina.start()`，无需编写自己的 IPC 转发层。Qt 与 .NET 的接入方式见 [SDK 指南](../README.md)。

需要为移动 SDK 已有 API 接入 Rust 原生实现时，通过 `PluginOptions.api(name, options, handler)` 注册；完整示例与取消约定见 [原生 API 接入](../Native-APIs.md#tauri--rust)。

## 开发测试

`cargo test` 的生命周期用例支持 Windows、macOS 和 Linux。测试会用 Node.js 22+ 和 Go 1.27.3+ 编译 `tests/testdata/runtime/` 中的原生进程夹具，验证启动、取消、管道背压及退出回收；无需相机、蓝牙设备或桌面窗口。Go 可由 `GO_BIN` 指定，也可从 PATH 查找。CI 通过 `DIMINA_TEST_RUNTIME` 复用提前编译的夹具。以上工具仅用于运行开发测试，不是集成 Rust 插件时的运行依赖。
