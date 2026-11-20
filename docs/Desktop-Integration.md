# 桌面客户端接入

使用封装好的独立窗口 SDK，在现有 Electron、Tauri、Qt、.NET 客户端中打开 Dimina 小程序。业务侧只需配置运行时、小程序资源和数据目录，再调用打开、聚焦、关闭接口；窗口、资源服务、桥接、存储和生命周期由容器处理。

当前提供独立小程序窗口，不包含嵌入现有页面、Widget 或 Control 的模式。

| 技术栈 | 调用库 | 接入方式 |
| --- | --- | --- |
| Node.js / Electron | [`@dimina/desktop-sdk`](../desktop/sdk/node/) | 主进程调用 `Dimina.start()`、`openApp()` |
| Tauri 2 | [`tauri-plugin-dimina`](../desktop/sdk/tauri/) + `@dimina/desktop-sdk/tauri` | Rust 注册插件，前端调用 `Dimina.start()`、`openApp()` |
| Qt 5.15 / Qt 6 | [`Dimina::Desktop`](../desktop/sdk/qt/) | Core + Network 库，使用方法与信号，无需 WebEngine |
| .NET / .NET Framework | [`Dimina.Desktop`](../desktop/sdk/dotnet/) | .NET Standard 2.0 类库，使用 `StartAsync()`、`OpenAppAsync()` |

**从 [SDK 接入指南](../desktop/sdk/README.md) 开始**，其中包含构建命令、各技术栈的最小调用示例、API 对照、运行时分发与平台依赖。

需要调用现有客户端的原生能力时，参见 [原生 API 接入](../desktop/sdk/Native-APIs.md)。宿主为移动 SDK 已有 API 注册处理器后，小程序保持原有 `wx` 调用方式，支持异步结果、失败回调、appId 授权及取消。

```js
import { Dimina } from '@dimina/desktop-sdk'

const desktop = await Dimina.start({ runtimePath, packagesDir, dataDir })
const window = await desktop.openApp({ appId: 'your-app-id', name: '我的小程序' })
// 需要时：await window.focus() / await window.close()
// 客户端退出时：await desktop.dispose()
```

小程序需要先经过 Dimina 编译，`packagesDir` 下每个 appId 目录包含 `main/app-config.json`、`main/logic.js` 和完整分包。它不是微信原始 wxapkg，也不是小程序源码目录。

## 导出启动与 Bridge 诊断

宿主可以在打开小程序前开启采集，复现后导出 JSON。报告留在桌面运行时，打开失败或窗口关闭后仍能取到，宿主退出前保存即可。

```js
// Node.js / Electron 和 Tauri 的 JavaScript SDK
await desktop.setDiagnosticsEnabled(true, { host: hostVersion })
try {
  const window = await desktop.openApp({ appId: 'your-app-id' })
  // 在窗口中复现后，也可以先关闭窗口。
  await window.close()
} finally {
  const report = await desktop.getDiagnosticsJSON()
  if (report) console.log(report)
  await desktop.setDiagnosticsEnabled(false)
}
```

| 宿主 SDK | 开启采集 | 获取 JSON |
| --- | --- | --- |
| Node.js / Electron、Tauri JS | `setDiagnosticsEnabled(true, versions?)` | `getDiagnosticsJSON()` |
| Tauri Rust | `set_diagnostics_enabled(true, versions)` | `get_diagnostics_json()` |
| Qt | `setDiagnosticsEnabled(true, versions)`，等待 `diagnosticsConfigured` | `getDiagnosticsJSON()`，结果通过 `diagnosticsReceived` 返回 |
| .NET | `SetDiagnosticsEnabledAsync(true, versions)` | `GetDiagnosticsJsonAsync()` |

报告按 `appId` 查找打开请求，窗口创建后按 `windowId` 查看 WebView 启动和原生 API 记录。用 `callId` 关联 API 接收与原生返回或失败。原生返回事件记录桌面运行时处理结果，JS 回调是否执行可在逻辑层核对。每轮分别保留最近 200 条启动与 Bridge 事件。开启新一轮采集或关闭采集会清空记录，页面查询参数、API 参数和返回正文不进入报告。

独立启动器可设置 `DIMINA_DESKTOP_DEBUG=1` 开启采集。在启动器的 Web Inspector 执行 `await window.diminaGetDiagnosticsJSON()` 可获得本次运行的报告，小程序窗口内只返回该窗口的记录。现有 `window.diminaGetLaunchDiagnostics()` 提供窗口内的 Web 启动快照。 [Web 容器启动诊断](../fe/packages/container-sdk/README.md#导出启动诊断)

若要直接使用独立的桌面应用，见 [桌面宿主说明](../desktop/README.md)；若要自行实现 WebView 宿主或扩展其他承载方式，见 [Web 容器 SDK](../fe/packages/container-sdk/README.md)。
