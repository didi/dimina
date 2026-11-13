# @dimina/desktop-sdk

供 Node.js / Electron 主进程和 Tauri 前端调用的 Dimina 独立窗口容器 SDK。Node/Electron 入口零 npm 运行时依赖，使用配套的桌面运行时；不会自动下载或安装运行时。

```js
import { Dimina } from '@dimina/desktop-sdk'

const desktop = await Dimina.start({ runtimePath, packagesDir, dataDir })
const window = await desktop.openApp({ appId: 'your-app-id', name: '我的小程序' })
await window.focus()
await window.close()
await desktop.dispose()
```

三个目录/文件路径都必须是绝对路径。`runtimePath` 在 macOS 指向完整 `.app` 内的可执行文件；Windows 指向配套 `.exe`；Linux 指向配套可执行文件。`packagesDir` 包含按 appId 命名的 Dimina 编译产物目录，`dataDir` 由当前产品独占。

还提供 `windows()`、`closeAll()`、`importApp(absolutePath)`。重复打开同 appId 会复用已有窗口；首次打开可传 `path` 指定入口。客户端退出时等待 `dispose()`，不要把 SDK 实例暴露给 renderer 或小程序。

主进程可用 `await desktop.registerApi(name, handler, { appIds, timeoutMs })` 注册原生能力，为移动 SDK 已有 API 提供桌面原生实现。处理器接收 `(params, { appId, windowId, signal })`，返回 JSON 对象或 Promise；异步操作可使用 `signal` 参与取消。

完整构建、平台依赖和分发说明见仓库 `desktop/sdk/README.md`。

Tauri 2 前端使用 `import { Dimina } from '@dimina/desktop-sdk/tauri'`，注册配套 Rust 插件和权限后调用 `await Dimina.start()`。运行时路径由 Rust 宿主配置，完整接入步骤见 `desktop/sdk/tauri/README.md`。
