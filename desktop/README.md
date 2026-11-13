# Dimina Desktop

基于 MyGo 的桌面小程序宿主。复用 DMCC、Service、Render 和 Web 容器，通过系统 WebView 运行小程序，提供独立窗口和本地系统能力。

在现有 Electron、Tauri、Qt、.NET 客户端中调用独立小程序窗口，使用 [桌面窗口 SDK](./sdk/README.md)，无需自行实现资源服务或小程序桥接。

## 构建与运行

需要 Go **1.27.3+**、Node.js **22.22.3+**、pnpm **12.2.0+**、Rust stable（含 Cargo）。MyGo 固定为 `v0.9.0`。

首次准备前端依赖和示例产物：

```sh
cd fe
pnpm install
pnpm compile
cd ..
./script/build_and_run.sh
```

macOS 产物在 `desktop/build/darwin-arm64/Dimina Desktop.app` 或 `darwin-amd64/`。`./script/build_and_run.sh --build-only` 只构建。

构建脚本优先使用 `GO_BIN` 指定的 Go；其次使用仓库 `.build/toolchains/go/bin/go`（如果存在）；否则使用 PATH 中的 `go`。不自动安装或修改系统工具链。

跨平台构建：

```sh
cd fe
node ../desktop/scripts/build.mjs --platform=windows/amd64
node ../desktop/scripts/build.mjs --platform=linux/amd64
```

Windows 需要 WebView2 Runtime；Linux 需要 GTK 3、WebKitGTK 4.1 和系统 D-Bus / BlueZ。蓝牙辅助程序随运行时打包，接入方不需要安装 Rust。源码构建辅助程序时，Linux 还需 `pkg-config`、D-Bus 开发包，Windows 需要 MSVC 工具链。跨平台构建需准备相应 Rust target 和链接器；可在对应平台构建。脚本只生成可运行产物；生成 DMG、Windows 安装器或通过商店分发时，需另行配置打包和代码签名。

## 使用

- 在应用列表打开内置示例，同一小程序重复打开时激活已有窗口。
- 导入小程序时，选择含 `main/app-config.json`、`main/logic.js` 的 **Dimina 编译产物目录**。不直接执行小程序源码或微信原始 wxapkg。
- 导入文件复制到宿主数据目录，限制为 256 MiB / 20000 文件，拒绝符号链接。不会覆盖已导入版本。
- 小程序窗口可以缩放；窗口隐藏、最小化和恢复会通知运行时前后台状态。
- 小程序窗口隐藏系统标题栏和红绿灯，通过页面顶部导航栏拖动、胶囊按钮关闭；应用列表保留系统窗口控件。
- 桌面小程序不预留移动端状态栏，导航栏高 44px，标题和胶囊居中，页面内容从导航栏下方开始。
- 原生窗口在加载界面图片、字体和布局就绪后显示；关闭时先等待窗口隐藏，再清理小程序并关闭窗口。独立窗口不播放容器整屏进出动画，页面内部导航保持原有动画。

## 已接入的宿主能力

| 能力 | 实现 |
| --- | --- |
| 窗口与页面 | 每个小程序一个窗口；页面导航继续由现有运行时处理 |
| HTTP 与文件传输 | `wx.request`、`wx.downloadFile`、`wx.uploadFile` 使用 Go HTTP；上传支持进度、响应头和取消 |
| TCP / UDP | `wx.createTCPSocket`、`wx.createUDPSocket`；系统 socket、二进制消息、持续事件及取消监听，UDP `bind()` 同步返回端口 |
| WebSocket | 沿用 WebView 的 `wx.connectSocket` / `SocketTask` 实现 |
| 扫码 | `wx.scanCode`；独立扫码窗口、系统相机权限、二维码/条码识别和图片识别，支持取消及 `onlyFromCamera` |
| BLE 蓝牙 | 系统适配器、发现、连接、服务/特征查询、读写、通知、RSSI / MTU 查询及持续事件；按窗口管理连接与订阅 |
| 剪贴板 | `wx.setClipboardData`、`wx.getClipboardData` |
| 文件选择 | `wx.chooseMessageFile`；选择的文件通过临时资源 URL 提供，关闭小程序后撤销 |
| 存储 | set/get/remove/clearStorage、getStorageInfo 的同步和异步版本，按 appId 持久化 |
| 系统信息 | 宿主平台、架构及运行时视口；尺寸变化先更新同步快照，再通知 Page.onResize |

同步存储、socket 对象方法和蓝牙事件注册仅在 Worker 线程发起同步 HTTP 请求，保证监听注册与调用顺序；宿主完成原子写入后返回结果，写失败向业务抛错。系统信息等已有同步快照 API 不经过这条通道。`wx.canIUse` 查询桌面能力；其它同步 API 会明确返回不支持。关闭窗口会取消请求、传输、蓝牙订阅和连接，并关闭 socket、撤销文件授权。

每次启动只监听 `127.0.0.1` 的随机端口，资源地址带随机前缀。正式包内嵌前端与当次已有示例产物，无需 Vite 或代理服务。修改示例源码后，应重新执行 `pnpm compile` 再构建桌面包。

## 身份与运行边界

Go 通过实际调用窗口确定 appId，业务不能通过传入另一个 appId 访问它的存储；同步端点和选择文件的临时授权也绑定到窗口生命周期。MyGo Session 隔离浏览器存储，Go 存储以 appId 分目录。

该宿主用于认可的本地包与内置示例。**同源 iframe + Worker 不是恶意第三方代码的完整沙箱**；未提供网络域名授权清单、任意文件系统 API、强制独占进程或 CPU/内存配额。跨小程序跳转返回不支持，避免在同一窗口里混用两个 appId 的宿主权限。微信登录、支付、经典蓝牙、BLE 外设模式、主动设置 MTU、Android 专用 `TCPSocket.bindWifi`、mDNS 服务发现尚无内置桌面实现。BLE MTU 由系统自动协商；上传只接受当前窗口选择或下载得到的文件 URL，下载暂不支持指定 `filePath`。组件表现取决于目标系统 WebView。

宿主数据保存在系统用户配置目录的 `dimina-desktop/`，含 `packages/`、`storage/`、按窗口清理的 `tmp/` 和 `desktop.log`。设置 `DIMINA_DESKTOP_DEBUG=1` 可启用 Web Inspector。

## 验证

移动端 API 兼容清单与桌面处理器名称校验共用公共 API 参考。修改清单后先执行 `node desktop/scripts/sync-mobile-apis.mjs`；`node desktop/scripts/sync-mobile-apis.mjs --check` 可检查生成结果，桌面构建也会执行该检查。

先构建前端，再执行后端测试：

```sh
cd desktop
go test -race ./...
cd ../fe
pnpm --filter @dimina/service exec vitest run __tests__/synchronous-api.spec.js
pnpm --filter @dimina/fe-container-sdk exec vitest run __tests__/system-info-viewport.spec.ts
pnpm --filter @dimina/fe-container-sdk typecheck
```

