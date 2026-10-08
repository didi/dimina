# Changelog

## [v1.7.7] 2026-10-08

### 新增

- 逻辑层新增 `WXWebAssembly`，通过 WAMR 解释器执行 Wasm，支持函数 imports、导出调用、Memory / Table / Global 和内存扩容，可加载包内 `.wasm` / `.wasm.br` 并接入 `libpag-miniprogram@4.5.85`。
- 新增 `wx.createVideoDecoder()`，通过系统 AVSource / AVDemuxer / AVCodec 提供逐帧 RGBA 输出、seek、停止、移除和事件订阅，不输出音轨。
- Canvas 桥接新增同步 WebGL 查询、资源创建和像素读取协议；仅逻辑执行线程等待结果，Worker 与 UI 线程通过异步回包保持可运行，超时或页面关闭时返回明确错误。

### 修复

- 修复调试模式下重复启动或宿主升级时，内置底包和 JSSDK 可能覆盖已安装较新版本的问题；调试开关不再参与发布包安装与版本决策（#353）。
- 修复共享路径解析截断 query 中嵌套 URL 和后续问号的问题（#354）。

### 兼容性

- 与 Android、iOS SDK 统一版本号，核心 SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.7。
- JSSDK 升级到 1.0.51，编译器升级到 1.2.2；新增能力需同时更新原生 SDK、Service 和 Render 产物。
- Wasm 覆盖 libpag 所需能力，暂不支持完整 WebAssembly JavaScript 标准、SIMD、线程或 WASI。已有查询协议、包内读取和解码器控制的宿主回归，尚未完成完整 API 20 SDK 构建及 ArkWeb、系统解码设备验收。

## [v1.7.6] 2026-09-24

### 兼容性

- 与 Android、iOS SDK 统一版本号，核心 SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.6。
- 本版未新增 HarmonyOS 功能，JSSDK 保持 1.0.49。

## [v1.7.5] 2026-09-23

### 优化

- 改善输入框与软键盘的焦点管理。
- 补齐高德地图可选适配器的独立 HAR 发布配置，并使用明确版本依赖核心 SDK。

### 修复

- 修复无底包远程安装后重开或冷启动时未恢复磁盘缓存配置、导致启动失败的问题。
- 启动失败时结束等待并回调失败，恢复可重试状态；配置不完整时不清理历史包。

### 兼容性

- HarmonyOS SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.5。
- JSSDK 版本为 1.0.49。

## [v1.7.4] 2026-09-17

### 新增

- `DMPAppManager` 新增 `destroyAllMiniPrograms`，宿主可统一销毁前台、后台保活及跨小程序来源实例，同时保留已安装包和持久化数据。

### 优化

- 重新进入保活中的小程序时，会用本次入口更新 `App.onShow` 和 `getEnterOptionsSync()` 的路径、query、场景及来源信息；页面栈保持不变，也不会重复触发当前页的 `Page.onShow`。

### 修复

- 修复连续调用 `showLoading`、`hideLoading` 时，旧的关闭任务可能误关新提示的问题。

### 兼容性

- HarmonyOS SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.4。
- JSSDK 升级到 1.0.46。

## [v1.7.3] 2026-09-15

### 新增

- `FileSystemManager` 支持在 `wx.env.USER_DATA_PATH` 下持久化文件，补齐目录、读写、删除、遍历、状态查询、复制和重命名的同步与异步接口。
- 新增宿主管理小程序包接口，可查询已安装状态和版本，并从本地 Dimina ZIP 安装、升级、替换或降级小程序；安装失败时保留旧包。
- 支持配置胶囊显隐和默认启动遮罩，关闭启动遮罩不改变资源加载及页面 ready 时机。

### 修复

- `wx.request` 会将 GET、HEAD 和 DELETE 请求中的对象参数统一编码到 URL query，数组使用重复键，空值不发送，原生请求不再携带请求体。
- 收到空 JSON 响应时不再执行 `JSON.parse`，避免无内容响应触发解析错误。

### 兼容性

- HarmonyOS SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.3。
- JSSDK 升级到 1.0.45。

## [v1.7.2] 2026-09-11

### 新增

- vConsole 的 `MiniProgram Storage` 面板支持使用 JSON 新增和编辑值，并可在确认后删除当前小程序的 MMKV 数据；操作完成后会重新读取原生存储。

### 兼容性

- HarmonyOS SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.2。
- JSSDK 升级到 1.0.44。

## [v1.7.1] 2026-09-10

### 新增

- 调试模式下将逻辑线程的 `console.log/info/warn/error/debug` 转发到 vConsole，并在页面通道就绪前暂存最多 200 条启动日志。
- vConsole 新增只读的 `MiniProgram Storage` 面板，按当前小程序读取原生 MMKV 数据，与 WebView 浏览器存储分开展示。

### 优化

- `wx.request` 的请求及成功、失败结果可在 vConsole Network 面板中查看；上传、下载和 WebSocket 流量暂不采集。
- 调试开关同时控制逻辑层数据采集和 pageFrame 的 vConsole 初始化，未开启调试时不采集上述数据。

### 兼容性

- HarmonyOS SDK 和高德地图扩展模块 `@didi-dimina/map-amap` 同步升级到 1.7.1。
- JSSDK 升级到 1.0.43。

## [v1.7.0] 2026-09-10

### 新增

- 支持隐藏并保留小程序实例；再次打开时恢复页面栈、Web 节点和 TabBar 状态，并按容量、超时或内存压力回收后台实例。
- 新增地图 provider 接口和可选的高德地图 HAR，支持宿主注册 provider、配置平台 Key，并通过原生 MapViewComponent 承载地图。

### 优化

- 隐藏期间暂停业务定时器和普通消息回调，恢复后按原顺序继续执行；退出、重启和跨小程序导航等终止性回调不受影响。
- 调整原生地图节点的尺寸同步与重建流程，避免地图纹理缩放变形，并保留重建前的标记状态。
- TabBar 更新按小程序实例隔离；隐藏期间缓存的更新在恢复页面后生效。

### 兼容性

- HarmonyOS SDK 升级到 1.7.0，JSSDK 升级到 1.0.40。
- 高德地图适配模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.0，仍由宿主按需引入。

## [v1.6.2] 2026-09-01

### 修复

- 修复关闭小程序时没有退出动画的问题；关闭时一次性弹出当前小程序占用的 `NavPathStack` 路由，避免多页面逐页转场，并保留宿主页面或来源小程序页面。

### 兼容性

- HarmonyOS SDK 升级到 1.6.2。

## [v1.6.1] 2026-08-31

### 新增

- `DMPApp.init` 支持通过 `virtualFilePrefix` 配置虚拟文件协议前缀，并导出 `DMPDefaultVirtualFilePrefix` 与 `DMPVirtualFileConfig`；QuickJS、文件 API、资源拦截及原生组件统一使用同一配置。
- `getFileSystemManager()` 将方法暴露为可枚举的实例属性，兼容 Taro 等通过 `Object.keys()` 探测文件 API 的框架。

### 优化

- 完善图片文件写入与句柄关闭流程，兼容不同 HarmonyOS SDK 的 `ImagePacker` 接口，并修正 WebP 编码分支。
- 完善直播 `AVPlayer` 创建失败时的日志和错误传播。
- MMKV 升级到 2.4.2，并完善 HarmonyOS 本地测试工作流和原生依赖校验。

### 修复

- 修复胶囊按钮与 TabBar 事件回调属性不可由宿主组件传入的问题。
- 修复 Page 默认 `data` 对象在多个小程序页面实例之间共享的问题。
- 修复 Canvas 状态恢复反馈不完整，以及小游戏首个 Canvas 上屏后启动遮罩未及时关闭的问题。

### 兼容性

- HarmonyOS SDK 升级到 1.6.1，JSSDK 升级到 1.0.38。

## [v1.6.0] 2026-08-28

### 新增

- 支持多个不同 `appId` 的小程序实例共存，并新增 `navigateToMiniProgram`、`navigateBackMiniProgram`、`exitMiniProgram` 和 `restartMiniProgram` 跨小程序导航能力。
- 新增微信小游戏运行时，支持 `game.js` 启动、Canvas、图片、动画帧、触摸事件及前后台切换。
- 新增小程序卸载及用户数据清理能力。
- 新增 `openDocument`、网络状态变化订阅，并完善文件管理、权限、视频处理、屏幕管理及 HEIF/HEIC 图片转码能力。
- 补齐旧版 `CanvasContext` 接口，统一触摸手势与 Label 激活行为。
- 支持 QuickJS JavaScript 断点调试，新增 POSIX 调试传输层和协议测试。
- 新增 Flutter 接入示例与集成文档。

### 优化

- 完善跨小程序生命周期派发、运行时恢复、关闭及导航资源清理流程。
- 存储键升级为 v2 编码，并兼容旧数据迁移。
- 将 QuickJS 源码纳入 `third_party` 管理，抽取 Android、Harmony 共用的 CMake 源码准备、Debug 补丁和编译配置。
- 统一 libuv CMake 接口及生命周期测试；Harmony 继续使用系统 libuv 实现。
- 升级 Brotli、MMKV 等原生依赖，其中 MMKV 升级至 2.4.1。

### 修复

- 修复跨小程序页面与应用生命周期顺序不一致的问题。
- 完善视频码率、帧率等参数校验，以及文件和权限相关异常处理。

### 兼容性

- HarmonyOS SDK 升级到 1.6.0，JSSDK 升级到 1.0.33。

## [v1.5.0] 2026-08-13

### 新增

- 新增原生 WebSocket `SocketTask`，完善连接、消息、关闭、错误及前后台生命周期语义。
- 新增 `wx.chooseMessageFile`，支持文件类型、扩展名和数量筛选。
- 完善 `wx.uploadFile`，支持上传进度与响应头回调。

### 优化

- 完善 Socket、上传和文件选择的参数校验、异常清理与回调一致性。

### 兼容性

- HarmonyOS SDK 升级到 1.5.0，JSSDK 升级到 1.0.27。

## [v1.4.2] 2026-07-24

### 新增

- 支持无底包时通过 `updateManifestUrl` 完成首次安装，在运行时启动前校验、下载并激活远程小程序包。

### 优化

- 首次安装复用现有包校验链路，校验 `appId`、必需文件及可选 SHA-256，失败时终止本次启动并清理临时包。
- 保持已有底包启动和启动后后台更新语义，首次安装仅用于建立本地运行基线。

### 兼容性

- HarmonyOS SDK 升级到 1.4.2，JSSDK 升级到 1.0.20。

## [v1.4.1] 2026-07-17

### 优化

- 优化小程序 App 初始化与资源加载时序，确保 `scene`、`path` 和 `query` 在 App 实例创建前正确传递。
- 完善 `getApp({ allowDefault: true })` 语义，支持 App 声明前的默认对象获取与属性合并。
- 优化小程序关闭和重新进入流程，统一清理全部 Navigator 与页面栈，避免多容器场景下的页面残留。
- 优化胶囊关闭按钮和小程序菜单的退出行为，确保引擎、应用实例与导航资源正确释放。

### 兼容性

- HarmonyOS SDK 升级到 1.4.1，JSSDK 升级到 1.0.18。

## [v1.4.0] 2026-07-17

### 新增

- 新增完整的文件系统 API，支持文件与目录管理、ZIP 读取及 Brotli 压缩文件解压。
- 新增蓝牙、TCP/UDP Socket 及局域网服务发现能力。
- 新增 Canvas `toDataURL`、`getImageData` 和 `canvasToTempFilePath` 能力。
- 新增 `getAppBaseInfo`，完善主题、语言、字体缩放、调试状态等宿主环境信息。
- 新增 HAR 构建与上传命令。

### 优化

- 完善自定义 TabBar、主题变更监听、媒体查询监听和性能观测能力。
- 优化页面与组件生命周期、`setData`、properties/observer、relations、slot、事件路径和样式隔离处理。
- 优化内置组件的交互、性能与无障碍属性。

### 修复

- 修复文件读写长度、图片选择和 `saveFileSync` 目录创建及错误处理问题。
- 修复 Canvas 保存失败和跨域资源处理异常问题。
- 修复扩展 API 订阅事件标识丢失问题。

### 兼容性

- HarmonyOS SDK 升级到 1.4.0，JSSDK 升级到 1.0.17。

## [v1.3.1] 2026-05-29

- 新增 TabBar 动态 API，支持 badge、red dot、样式和显隐状态更新。
- 新增小程序远程更新管理，支持更新检查、资源下载、应用更新及 `updateManifestUrl` 配置。
- 完善 Canvas Promise 调用与 WebGL 支持。
- 扩展 API 支持 Promise-like 返回，并可通过 `Object.keys(wx)` 枚举宿主注册的自定义 API。
- HarmonyOS SDK 升级到 1.3.1，JSSDK 升级到 1.0.11。

## [v1.3.0] 2026-05-18

- 新增原生 Video 同层渲染、播放控制和 VideoContext 交互。
- 新增 TabBar API 及完整样式支持，优化图标相对路径、高度和展开速度。
- 新增小程序菜单与胶囊按钮，完善 `titleHorizontalInset` 和布局计算。
- 完善 vConsole 调试与逻辑层日志。
- 优化 MMKV 存储、key 管理和错误处理，修复底部背景色异常。
- HarmonyOS SDK 升级到 1.3.0，JSSDK 升级到 1.0.10。

## [v1.2.0] 2026-04-07

- 新增 `extBridge`/`extOnBridge` 第三方扩展桥接，并支持自定义全局 API 命名空间。
- 新增多列 Picker 及 WebSocket `SocketTask` 能力。
- 完善页面与组件生命周期、relations、behavior 合并和 observer 执行语义。
- targetSdkVersion 升级至 6.0.0，补齐 API 18 下的 `hideToast` 兼容。
- 优化定时器回调、Promise 异常和内存管理。
- HarmonyOS SDK 升级到 1.2.0，JSSDK 升级到 1.0.5。

## [v1.0.2] 2025-06-18

- 新增 `chooseVideo` API。
- 新增逻辑层核心日志和 vConsole 输出。
- 优化 QuickJS 远程依赖、工程结构和编译兼容性。
- HarmonyOS SDK 升级到 1.0.2，JSSDK 升级到 1.0.1。

## [v1.0.1] 2025-05-21

- 优化小程序资源复制与目录管理。
- 完善导航栏样式、文字颜色与暗色模式返回按钮。
- 优化调试模式、用户代理和工程签名/打包配置。
- HarmonyOS SDK 升级到 1.0.1，同步 JSSDK 1.0.0。

## [v1.0.0] 2025-05-09

- HarmonyOS SDK 首次发布。
- 提供 QuickJS 逻辑引擎、WebView 视图容器、资源包加载和原生 Bridge 基础运行环境。
