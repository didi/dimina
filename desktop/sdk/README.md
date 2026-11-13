# 桌面独立窗口 SDK

在已有 Electron、Tauri、Qt、.NET 客户端中调用 SDK，以独立窗口打开 Dimina 小程序。SDK 启动并管理配套桌面运行时，运行时负责窗口、资源加载、网络、文件、剪贴板、同步/异步存储和小程序生命周期。

业务侧不需要编写 HTML、资源服务器或 WebView 桥接，也不需要安装 Go。嵌入现有窗口、Widget 或 Control 的模式尚未提供。

## 获取运行时与调用库

准备 [桌面构建环境](../README.md#构建与运行)，从仓库的 `fe/` 目录构建 SDK：

```sh
cd fe
pnpm install
node ../desktop/sdk/build.mjs
# 指定目标平台，工具链要求同桌面应用构建：
node ../desktop/sdk/build.mjs --platform=windows/amd64
```

构建产物位于 `desktop/sdk/dist/`：

```text
dist/
├── runtime/{platform-arch}/    # 完整运行时目录，包含必要的原生依赖
├── node/dimina-desktop-sdk.tgz
├── qt/                        # CMake 库源码
├── dotnet/                    # .NET 类库项目
├── tauri/                     # Tauri 2 Rust 插件源码
├── licenses/                  # 原生依赖许可证
└── README.md
```

运行时只包含容器资源，不内置演示小程序。将自己的 **Dimina 编译产物**随客户端发布，例如：

```text
your-product/
├── dimina-runtime/             # 将 runtime/{platform-arch}/ 整个目录复制到这里
└── miniapps/
    └── your-app-id/
        ├── main/app-config.json
        ├── main/logic.js
        ├── main/...
        └── sub_xxx/...         # 有分包时一并保留
```

运行时路径：

| 平台 | `runtimePath` 指向 |
| --- | --- |
| macOS | `Dimina Desktop.app/Contents/MacOS/Dimina Desktop`，保留完整 `.app` |
| Windows | 构建目录中的 `.exe`，同时保留同目录依赖；系统需安装 WebView2 Runtime |
| Linux | 构建目录中的可执行文件，同时安装桌面运行时所需 GTK 3 / WebKitGTK 4.1 |

`runtimePath`、`packagesDir`、`dataDir` 都使用绝对路径。`packagesDir` 是包含多个 appId 子目录的只读资源根目录；`dataDir` 是当前产品独占的可写数据目录。每个客户端维护一个 SDK 实例；不同产品或账号使用不同的数据目录，不要让多个运行时同时写同一目录。

源码调用库可直接从 `node/`、`qt/`、`dotnet/`、`tauri/` 引用，也可打包成内部制品；这里没有要求从公共 registry 安装某个已发布版本。

## Node.js / Electron

安装本地制品或源码目录：

```sh
pnpm add /path/to/sdk/dist/node/dimina-desktop-sdk.tgz
# 或：pnpm add file:/path/to/dimina/desktop/sdk/node
```

在 Node.js 22+ 或 Electron **主进程**中：

```js
import { Dimina } from '@dimina/desktop-sdk'

const dimina = await Dimina.start({
  runtimePath: '/absolute/path/to/runtime-executable',
  packagesDir: '/absolute/path/to/miniapps',
  dataDir: '/absolute/path/to/product-data/dimina',
})

const window = await dimina.openApp({
  appId: 'your-app-id',
  path: 'pages/index/index', // 可省略，使用编译配置中的入口页
  name: '我的小程序',
})
await window.focus()
await window.close()
await dimina.dispose() // 客户端退出时调用，关闭其全部小程序窗口并回收运行时
```

Electron 可使用 `process.resourcesPath` 定位随应用打包的运行时和小程序，用 `app.getPath('userData')` 下的专用子目录保存数据。初始化放在 `app.whenReady()` 之后，应用退出前等待 `dispose()`。renderer 通过宿主已有的、限制调用范围的 IPC 触发主进程方法；不要把 SDK 实例或控制凭据暴露给页面。

CommonJS 主进程也可使用 `const { Dimina } = await import('@dimina/desktop-sdk')`；请在异步初始化函数中执行。

## Tauri

提供 Tauri 2 Rust 插件及前端子入口，无需在宿主编写 IPC 或进程管理代码。Rust 侧注册 `tauri_plugin_dimina::init(PluginOptions::new(runtimePath, packagesDir))`，配置资源与 `dimina:default` 权限后，前端即可调用：

```js
import { Dimina } from '@dimina/desktop-sdk/tauri'

const dimina = await Dimina.start()
const app = await dimina.openApp({ appId: 'your-app-id' })
await app.close()
await dimina.dispose()
```

运行时和数据路径由 Rust 宿主配置；插件在应用退出时回收进程。完整 Cargo 引用、资源打包、插件注册和权限配置见 [Tauri 接入指南](./tauri/README.md)。

## Qt

调用库依赖 Qt Core、Network，支持 Qt 5.15 和 Qt 6，不依赖 Qt WebEngine 或 WebChannel。

```cmake
add_subdirectory(path/to/sdk/qt dimina-sdk)
target_link_libraries(your_client PRIVATE Dimina::Desktop)
```

```cpp
#include "DiminaDesktop.h"

auto *desktop = new Dimina::Desktop(this);
connect(desktop, &Dimina::Desktop::started, this, [desktop] {
    desktop->openApp("your-app-id", "pages/index/index", "我的小程序");
});
connect(desktop, &Dimina::Desktop::appOpened, this, [desktop](const QJsonObject &window) {
    const auto id = window["id"].toString();
    // 在自己的按钮/菜单中调用 desktop->focus(id) 或 desktop->closeApp(id)。
});
connect(desktop, &Dimina::Desktop::operationFailed, this,
        [](const QString &operation, const QString &message) { /* 显示宿主错误 */ });
connect(desktop, &Dimina::Desktop::appOpenFailed, this,
        [](const QString &appId, const QString &message) { /* 显示小程序启动错误 */ });

desktop->start({runtimePath, packagesDir, dataDir}); // 三个 QString 绝对路径
// 客户端退出时 desktop->stop()；析构也会回收它拥有的运行时。
```

这些方法是异步的，依赖 Qt 事件循环；在 `started` 后调用其他方法。`appOpened` 在小程序首屏 DOM 就绪后发出，`operationFailed` 和 `appOpenFailed` 分别报告通用操作和小程序启动失败。

## .NET

类库目标为 .NET Standard 2.0，可供现代 .NET 和兼容的 .NET Framework 客户端引用，不依赖 WPF、WinForms 或 WebView2 控件包。兼容范围参见 [.NET Standard 官方说明](https://learn.microsoft.com/en-us/dotnet/standard/net-standard?tabs=net-standard-2-0)。

```sh
dotnet add YourClient.csproj reference /path/to/sdk/dotnet/Dimina.Desktop.csproj
# 如需内部 NuGet 制品：dotnet pack /path/to/sdk/dotnet/Dimina.Desktop.csproj -c Release
```

```csharp
using Dimina.Desktop;

var desktop = await DiminaDesktop.StartAsync(new DesktopOptions {
    RuntimePath = runtimePath,
    PackagesDir = packagesDir,
    DataDir = dataDir,
});
var window = await desktop.OpenAppAsync(new OpenAppOptions {
    AppId = "your-app-id", Name = "我的小程序"
});
await desktop.FocusAsync(window.Id);
await desktop.CloseAppAsync(window.Id);
await desktop.DisposeAsync();
```

WPF / WinForms 的按钮事件可直接 `await OpenAppAsync()`，不需要手动切换到原生窗口线程。客户端退出前等待 `DisposeAsync()`；同步宿主也可以使用 `Dispose()`。

## API 与行为

| 操作 | Node / Electron | Tauri 前端 | Qt | .NET |
| --- | --- | --- | --- | --- |
| 启动容器运行时 | `Dimina.start(options)` | `Dimina.start()` | `start(options)` → `started` | `StartAsync(options)` |
| 打开并等待首屏 DOM | `openApp(options)` | `openApp(options)` | `openApp(appId, path, name)` → `appOpened` | `OpenAppAsync(options)` |
| 聚焦已有窗口 | `window.focus()` / `focus(id)` | 同左 | `focus(id)` | `FocusAsync(id)` |
| 关闭指定窗口 | `window.close()` / `closeApp(id)` | 同左 | `closeApp(id)` | `CloseAppAsync(id)` |
| 获取当前窗口列表 | `windows()` | `windows()` | `windows()` → `windowsReceived` | `WindowsAsync()` |
| 导入编译产物目录 | `importApp(absolutePath)` | 同左，需 `allow-import` | `importApp(path)` → `appImported` | `ImportAppAsync(path)` |
| 关闭全部小程序窗口 | `closeAll()` | `closeAll()` | `closeAll()` | `CloseAllAsync()` |
| 退出并回收运行时 | `dispose()` | `dispose()` / 宿主退出 | `stop()` / 析构 | `DisposeAsync()` / `Dispose()` |

- 同一 SDK 实例中，同 appId 重复打开会聚焦并复用已有窗口。`path` 在新建窗口时生效；需要以不同入口重新启动时，先关闭已有窗口。
- 窗口标识 `id` 由运行时生成，与 appId 不同。用户点击胶囊关闭后，该 id 失效；关闭已退出的窗口是幂等操作，可通过窗口列表获取实际状态。
- `openApp` 等待资源与首屏 DOM 就绪，失败会 reject / 发出失败信号。错误窗口可能仍用于展示原因，可通过窗口列表关闭；请求取消不等于关闭窗口。
- 只支持 Dimina 编译产物。新源码先编译；导入不会覆盖同 appId 的已有导入包。导入包优先于 `packagesDir` 中的同名目录。
- 各窗口的资源授权随关闭撤销；存储按 appId 持久化在 `dataDir`，同步和异步存储共用数据源。窗口隐藏/恢复、尺寸变化和胶囊关闭由运行时处理。
- SDK 与运行时需配套发布；SDK 会检查启动协议。不要以系统 `open`、shell 字符串拼接或另起普通桌面应用进程代替 SDK 初始化。

更多功能范围见 [桌面宿主说明](../README.md)。运行时用于宿主认可的小程序；同源 iframe + Worker 不构成恶意第三方代码的完整沙箱。

## 发布到已有产品

1. 将对应平台的完整运行时目录、调用库和编译产物纳入产品安装包。运行时路径不要放进 ASAR 等进程无法直接执行的归档；Electron 可以通过 `extraResources` 放在外部资源目录。
2. macOS 保留 `.app` 结构并纳入产品签名/公证流程；Windows 保留 WebView2 相关依赖并准备 Runtime；Linux 按宿主发行版准备系统库。
3. 数据目录放在产品的用户数据区域，资源目录保持只读。运行时更新与小程序包更新分别管理，完整替换对应资源而不是覆盖正在使用的单个文件。
4. 保留分发目录中的许可证与第三方声明；应用退出时统一释放 SDK 实例。
