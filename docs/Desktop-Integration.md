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

```js
import { Dimina } from '@dimina/desktop-sdk'

const desktop = await Dimina.start({ runtimePath, packagesDir, dataDir })
const window = await desktop.openApp({ appId: 'your-app-id', name: '我的小程序' })
// 需要时：await window.focus() / await window.close()
// 客户端退出时：await desktop.dispose()
```

小程序需要先经过 Dimina 编译，`packagesDir` 下每个 appId 目录包含 `main/app-config.json`、`main/logic.js` 和完整分包。它不是微信原始 wxapkg，也不是小程序源码目录。

若要直接使用独立的桌面应用，见 [桌面宿主说明](../desktop/README.md)；若要自行实现 WebView 宿主或扩展其他承载方式，见 [Web 容器 SDK](../fe/packages/container-sdk/README.md)。
