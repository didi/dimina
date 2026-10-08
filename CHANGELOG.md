# Changelog

## [v1.7.7] 2026-10-08

### 新增

- 原生三端的逻辑层新增 `WXWebAssembly`，通过 WAMR 解释器执行 Wasm，支持函数 imports、导出调用和内存扩容；Web 使用浏览器的 WebAssembly。编译器保留 `.wasm`、`.wasm.br`、`.pag` 和 `.mp4` 二进制资源，支持 `libpag-miniprogram@4.5.85` 接入。
- 新增 `wx.createVideoDecoder()`，支持视频逐帧 RGBA 输出、seek、停止、移除和事件订阅；原生三端使用系统解码器，Web 使用 MP4Box 与 WebCodecs，不输出音轨。
- 原生 Canvas 桥接支持同步返回 WebGL 查询、资源创建和像素读取结果；Web 的 WebGL Canvas 通过 OffscreenCanvas 交给逻辑 Worker 绘制，并同步执行浏览器 WebGL 调用。
- 新增 libpag 示例，覆盖静态 PAG、视频 PAG 和动画播放。

### 修复

- 修复 HarmonyOS 调试模式下重复启动或宿主升级时，内置底包和 JSSDK 可能覆盖已安装较新版本的问题；调试开关不再参与发布包安装与版本决策（#353）。
- 修复页面 query 含嵌套 URL 或多个问号时被截断的问题，共享路径解析与 iOS 原生路径解析均保留首个问号之后的完整 query（#354）。
- 修复原生小游戏首次启动时 WebGL 扩展常量缺失导致纹理上传失败的问题；扩展查询同步返回当前上下文的真实常量，并补齐小游戏 WebGL 初始化与绘制桥接回归（#358）。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.7，高德地图可选适配器与核心 SDK 使用相同版本。
- 编译器升级到 1.2.2，JSSDK 升级到 1.0.51；新增 Wasm、视频解码和同步 WebGL 能力需同时更新原生 SDK、Service 和 Render 产物。
- iOS 的 `WXWebAssembly` 要求 iOS 17.4 及以上版本，其他 SDK 功能的最低系统版本不变。原生 Wasm 覆盖 libpag 所需能力，暂不支持完整 WebAssembly JavaScript 标准、SIMD、线程或 WASI。
- Web 的 WebGL 依赖 OffscreenCanvas / Worker WebGL，视频解码另需安全上下文与 WebCodecs，并取决于浏览器编码支持。Android、iOS 已有模拟器绘制回归；HarmonyOS 尚未完成完整 API 20 SDK 构建及 ArkWeb、系统解码设备验收，三端真机效果与性能仍需验证。

## [v1.7.6] 2026-09-24

### 新增

- iOS 主仓库新增可选的 `DiminaMapAMap` Swift Package product，可通过同一个仓库 URL 接入核心 SDK 和高德地图适配器；高德 XCFramework 使用固定 URL 和 SHA-256 校验。
- iOS 新增 Objective-C 宿主接入接口及示例，方便现有 Objective-C 应用使用 Dimina。

### 优化

- iOS 地图发布流程增加主仓库地图 product 构建验证，并保留离线 Swift Package 接入方式。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.6，高德地图可选适配器与核心 SDK 使用相同版本。
- 编译器保持 1.2.1，JSSDK 保持 1.0.49。
- iOS 高德二进制继续复用 v1.7.5 Release 的固定附件和校验值；仍需将 `AMap.bundle` 复制到宿主主 bundle，且不支持 arm64 模拟器。

## [v1.7.5] 2026-09-23

### 新增

- 补齐高德地图可选适配器的独立发布配置：Android Maven 制品、iOS Swift Package 发布附件和 HarmonyOS HAR，宿主可按需接入。
- iOS 新增 `DMPApp.setDebugMode`，复用小程序实例时同步刷新调试配置；vConsole 仅跟随显式的 `isDebugMode`，配置用于后续创建的 Service 和页面。

### 优化

- Android、HarmonyOS 改善输入框与软键盘的焦点管理。
- 优化组件按压反馈，滚动或触摸移动超过阈值时取消 hover 状态。

### 修复

- 修复旧版 Android WebView 因不支持的 JavaScript 语法和 `Object.hasOwn` 导致小程序初始化停滞的问题，容器构建目标兼容 Chrome 83。
- 修复 Android 拍照、录像未申请相机运行时权限导致的崩溃；拒绝授权或启动相机失败时安全结束调用。
- 修复 Android 胶囊“重新进入小程序”和 `wx.reLaunch` 可能产生重复最近任务卡片的问题，并完善任务查找与保活重入时的入口信息更新。
- 修复 iOS 远程包 `modules` 缺失或为空时拒绝已声明页面的问题，支持从主包和分包页面声明补全映射，并保持小游戏入口独立处理。
- 修复 iOS 混合宿主中替换小程序根页面时丢失宿主导航栈、无法返回宿主的问题。
- 修复 HarmonyOS 无底包远程安装后重开或冷启动时未恢复缓存配置的问题；启动失败会结束等待、回调失败并允许重试，配置不完整时保留历史包。
- 修复 vConsole 内嵌 CSS source map 导致的构建警告，并重置 Web 容器导航操作区域的默认列表样式。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.5，高德地图可选适配器与核心 SDK 使用相同版本。
- 编译器版本保持 1.2.1，JSSDK 版本为 1.0.49。

## [v1.7.4] 2026-09-17

### 新增

- Android、iOS 和 HarmonyOS 新增 `destroyAllMiniPrograms`，宿主可统一销毁前台、后台保活及跨小程序来源实例，同时保留已安装包和持久化数据。

### 优化

- 三端重新进入保活中的小程序时，会用本次入口更新 `App.onShow` 和 `getEnterOptionsSync()` 的路径、query、场景及来源信息；页面栈保持不变，也不会重复触发当前页的 `Page.onShow`。

### 修复

- 修复连续调用 `showLoading`、`hideLoading` 或用新提示替换旧提示时，旧的关闭动画或定时任务误关新提示的问题。
- 修复 Android 启动遮罩在小程序名称为空、仅含空格或运行中变更时，首字显示异常或崩溃的问题。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.4。
- HarmonyOS 高德地图扩展模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.4。
- 编译器版本保持 1.2.1，JSSDK 升级到 1.0.46。

## [v1.7.3] 2026-09-15

### 新增

- Android、iOS 和 HarmonyOS 的 `FileSystemManager` 支持在 `wx.env.USER_DATA_PATH` 下持久化文件，补齐目录、读写、删除、遍历、状态查询、复制和重命名的同步与异步接口。
- 三端新增宿主管理小程序包能力，可查询已安装状态和版本，并从本地 Dimina ZIP 安装、升级、替换或降级小程序；安装失败时保留旧包。
- 三端支持配置胶囊显隐和默认启动遮罩；Android 另可关闭独立小程序任务卡片，让页面进入宿主任务栈。

### 修复

- `wx.request` 会将 GET、HEAD 和 DELETE 请求中的对象参数统一编码到 URL query，数组使用重复键，空值不发送，三端不再携带请求体。
- HarmonyOS 收到空 JSON 响应时不再执行 `JSON.parse`，避免无内容响应触发解析错误。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.3。
- HarmonyOS 高德地图扩展模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.3。
- 编译器版本保持 1.2.1，JSSDK 升级到 1.0.45。
- `oxc-parser` 升级到 0.149.0，Vitest 与覆盖率工具升级到 5.0.0。

## [v1.7.2] 2026-09-11

### 新增

- vConsole 的 `MiniProgram Storage` 面板支持使用 JSON 新增和编辑值，并可在确认后删除当前小程序的 MMKV 数据；操作完成后会重新读取原生存储。

### 优化

- Android 调试模式改为完全由宿主控制，在 Debug 和 Release AAR 中均可显式开启或关闭，默认保持关闭。
- 更新 `cssnano`、`magic-string`、`oxlint` 和 Node.js 类型定义。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.2。
- HarmonyOS 高德地图扩展模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.2。
- 编译器版本保持 1.2.1，JSSDK 升级到 1.0.44。

## [v1.7.1] 2026-09-10

### 新增

- 调试模式下将逻辑线程的 `console.log/info/warn/error/debug` 转发到 vConsole，并在页面通道就绪前暂存最多 200 条启动日志。
- vConsole 新增只读的 `MiniProgram Storage` 面板，按当前 `appId` 读取原生 MMKV 数据，与 WebView 浏览器存储分开展示。

### 优化

- `wx.request` 的请求及成功、失败结果可在 vConsole Network 面板中查看；上传、下载和 WebSocket 流量暂不采集。
- Android、iOS 和 HarmonyOS 统一调试开关与 pageFrame 的 vConsole 初始化时机，未开启调试时不采集上述数据。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.1。
- HarmonyOS 高德地图扩展模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.1。
- 编译器版本保持 1.2.1，JSSDK 升级到 1.0.43。

## [v1.7.0] 2026-09-10

### 新增

- Android、iOS、HarmonyOS 和 Web 支持隐藏并保留小程序实例；再次打开时恢复原页面栈和运行状态，并按容量、超时或内存压力回收后台实例。
- 四端新增可扩展的地图 provider，提供高德地图适配与基础 MapContext 能力；地图厂商依赖和平台 Key 由宿主按需接入。

### 优化

- 隐藏期间暂停业务定时器和普通消息回调，恢复后按原顺序继续执行；退出、重启和跨小程序导航等终止性回调不受影响。
- PickerView 根据容器尺寸变化重新计算布局，保留挂载阶段的受控选中值。
- Input 和 Textarea 在输入法组词期间不再派发中间态 `bindinput`，选词完成后只派发一次最终值。
- Android 优先使用运行时 WindowInsets 和刘海区域计算状态栏高度，资源尺寸仅作为回退。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.7.0。
- HarmonyOS 高德地图扩展模块 `@didi-dimina/map-amap` 与核心 SDK 同步升级到 1.7.0。
- 编译器版本保持 1.2.1，JSSDK 升级到 1.0.40。

## [v1.6.2] 2026-09-01

### 修复

- 修复 HarmonyOS 关闭小程序时没有退出动画的问题；关闭时一次性弹出小程序占用的原生路由，保留宿主页面及来源小程序页面。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.6.2。

## [v1.6.1] 2026-08-31

### 新增

- Android、iOS、HarmonyOS 和 Web 支持配置虚拟文件协议前缀，统一向运行时注入 `globalThis.__VIRTUAL_FILE_PREFIX__`，文件 API、资源拦截及原生组件不再依赖固定的 `difile://`。
- `getFileSystemManager()` 将原型方法绑定为可枚举的实例属性，兼容 Taro 等依赖 `Object.keys()` 探测文件 API 的框架。
- Web 小程序列表支持根据横向滚动位置自动显示或隐藏导航按钮。

### 优化

- DMCC 视图编译器缓存共享命名模板、可选链改写及源码定位结果；在 63 页面 Taro UI 参考项目中，视图编译耗时由约 41.7 秒降至约 4.9 秒，并避免缓存键重复持有大段源码。
- Web bridge 启动协议统一校验 service、render 资源及首屏 `domReady`，通过 `resourceLoadId` 隔离过期回包，避免启动遮罩提前消失或永久等待。
- 优化 Canvas 2D `save`、`restore`、`reset` 状态反馈和批次压缩；小游戏首个上屏 Canvas 挂载后复用 `domReady` 就绪契约。
- 完善 HarmonyOS 图片写入、编码器版本兼容和直播播放器错误传播，并补充本地测试工作流及依赖校验。
- MMKV 升级到 2.4.2，Vue 升级到 3.5.42，`oxc-parser` 升级到 0.147.0。

### 修复

- 修复 Page 默认 `data` 对象在多个页面实例之间共享，导致实例状态相互污染的问题。
- 修复 HarmonyOS 胶囊按钮与 TabBar 事件回调不可由宿主组件传入的问题。
- 修复 Canvas 状态恢复时反馈序列不完整，以及小游戏首屏就绪后启动遮罩未及时关闭的问题。
- 修复 HarmonyOS 图片文件关闭、WebP 编码分支及 `AVPlayer` 创建失败时错误信息不完整的问题。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.6.1。
- 编译器升级到 1.2.1，继续要求 Node.js 22.22.3 及以上版本并采用纯 ESM。
- JSSDK 升级到 1.0.38。

## [v1.6.0] 2026-08-28

### 新增

- Android、iOS、HarmonyOS 和 Web 支持多个不同 `appId` 的小程序运行时并存；跨小程序跳转时保留来源实例及其后台任务，返回时恢复原实例。
- 新增 `navigateToMiniProgram`、`navigateBackMiniProgram`、`exitMiniProgram` 和 `restartMiniProgram`，并支持卸载小程序及清理对应用户数据。
- Android、iOS、HarmonyOS 和 Web 支持微信小游戏 `game.js` 入口，新增上屏 Canvas、图片、动画帧、触摸及小游戏前后台事件基础能力。
- 补齐旧版 `CanvasContext` 跨端能力，统一 Canvas 触摸手势和 Label 激活行为。
- 新增 `openDocument`、网络状态变化订阅、Web `FileSystemManager.saveFile`、HEIF/HEIC 转码与 MIME 类型识别，并完善文件、权限、视频及屏幕管理能力。
- Android 支持嵌入式 WebView 与窗口 Insets 策略，完善原生组件交互和全面屏适配。
- HarmonyOS 新增 QuickJS 断点调试器、POSIX 调试传输及协议测试。
- 新增 Android、iOS、HarmonyOS 和 Web 共用的 Flutter 集成示例与接入文档。

### 优化

- 补齐跨小程序前后台生命周期、来源关系、回调排空及销毁边界，避免隐藏实例被误清理。
- 完善 Page、Component、App 的显示状态、兄弟组件顺序、页面卸载及 bridge listener 清理，补充真实组件重复创建和独立可见性回归测试。
- 编译器新增并发构建、worker 池资源限制、编译缓存、watch 调度与资源处理配置，减少构建耗时、CPU 峰值和内存占用。
- 优化视图与样式编译流程，清理无效 CSS token，并完善兼容性清单同步与包导出校验。
- 存储键升级为 v2 编码并兼容旧数据迁移；完善应用运行时恢复及小程序关闭后的导航栈收敛。
- Web 容器新增设备舞台和交互样式，优化逻辑视口尺寸、鼠标事件与开发服务器启动链路。
- Android 与 HarmonyOS 统一 QuickJS、libuv 的 CMake 接口；QuickJS 改为仓库内固定上游源码，libuv 保持 Android 静态链接、HarmonyOS 系统动态库，并新增跨端生命周期测试。
- 更新 QuickJS、libuv、Brotli、MMKV、Media3 及前端构建依赖，增加原生依赖版本校验与更新脚本。

### 修复

- 修复 iOS 重复发送 `pageUnload`、跨小程序生命周期顺序不一致及关闭小程序后页面栈未及时稳定的问题。
- 修复 Canvas `putImageData` 参数校验失败后残留数据、Web 样式隔离和鼠标悬停误触发问题。
- 修复 `getSystemInfoSync` 未优先使用逻辑视口尺寸、媒体处理参数边界及部分文件/权限异常路径。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.6.0。
- 编译器升级到 1.2.0，迁移为纯 ESM，并将 Node.js 最低版本升级到 22.22.3。
- JSSDK 升级到 1.0.33。

## [v1.5.0] 2026-08-13

### 新增

- Android、iOS 和 HarmonyOS 新增原生 WebSocket `SocketTask`，完善连接、消息、关闭、错误及前后台生命周期语义。
- Android、iOS 和 HarmonyOS 新增 `wx.chooseMessageFile`，支持文件类型、扩展名和数量筛选。
- 完善 `wx.uploadFile`，支持上传进度与响应头回调。

### 优化

- Web 容器运行时拆分为独立的 `@dimina/fe-container-sdk`，完善多实例隔离、导航恢复及宿主适配能力。
- 完善 Socket、上传和文件选择的参数校验、异常清理与跨端回调一致性。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.5.0。
- JSSDK 升级到 1.0.27。

## [v1.4.2] 2026-07-24

### 新增

- Android、iOS 和 HarmonyOS 支持无底包时通过 `updateManifestUrl` 完成首次安装，在 service/render 初始化前校验、下载并激活远程小程序包。
- Web 容器支持通过 `manifestUrl` 启动未预置在 `appList.json` 中的小程序，并从 manifest 指定的静态资源目录加载编译产物。

### 优化

- 首次安装复用现有包校验与原子替换链路，校验 `appId`、必需文件及可选 SHA-256，失败时终止本次启动并清理临时包。
- 保持已有底包快速启动和启动后后台更新语义，首次安装仅用于建立本地运行基线。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.4.2。
- JSSDK 升级到 1.0.20。

## [v1.4.1] 2026-07-17

### 优化

- 优化小程序 App 初始化与资源加载时序，确保 `scene`、`path` 和 `query` 在 App 实例创建前正确传递。
- 完善 `getApp({ allowDefault: true })` 语义，支持 App 声明前的默认对象获取与属性合并。
- 优化 Android、iOS 和 HarmonyOS 的小程序关闭、重新进入和页面栈清理，避免多页面/多容器场景下的残留状态或资源误释放。
- Android 新增小程序 Activity 注册管理，完善同一 `appId` 下多 Activity 的生命周期与统一关闭处理。
- 优化 PageFrame 页面根节点结构与样式挂载，并完善项目混合页示例。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.4.1。
- JSSDK 升级到 1.0.18。

## [v1.4.0] 2026-07-17

### 新增

- Android、iOS 和 HarmonyOS 新增文件系统 API，支持文件与目录管理、ZIP 读取及 Brotli 压缩文件解压。
- Android、iOS 和 HarmonyOS 新增蓝牙、TCP/UDP Socket 及局域网服务发现能力。
- Android 和 iOS 新增 `scanCode` 扫码能力，支持相机权限管理和二维码识别。
- HarmonyOS 新增 Canvas `toDataURL`、`getImageData` 和 `canvasToTempFilePath` 能力。
- 新增自定义 `tabBar`、主题变更监听、媒体查询监听和性能观测能力。
- 编译器新增自定义小程序文件扩展名配置，支持更灵活的模板、样式和视图脚本类型。

### 优化

- 完善 `getAppBaseInfo`、系统信息和菜单按钮几何信息，支持窗口变化后动态更新。
- 优化页面与组件生命周期、`setData`、properties/observer、relations、slot 和事件路径处理，进一步对齐微信小程序语义。
- 优化组件样式隔离、外部样式类和 CSS 作用域处理，提升组件嵌套与样式复用的兼容性。
- 优化 `Radio`、`ScrollView`、`Slider`、`Switch`、`Swiper`、`Textarea`、`Video` 和 `WebView` 等组件的交互、性能与无障碍属性。
- 优化编译器的 `import`/`include` 模板路径解析、WXS 处理、组件依赖遍历、兼容性诊断以及 rpx 到 vw 的转换。

### 修复

- 修复 Canvas 保存失败、跨域资源处理异常等问题。
- 修复 HarmonyOS 文件读写长度、图片选择和 `saveFileSync` 目录创建及错误处理问题。
- 修复 Android WebView 虚拟文件请求的 MIME 类型识别，并优化 Android/iOS WebView 的 `appId` 资源隔离与预加载。
- 修复 Button 内置样式权重过高、跨 realm 数组类型识别和扩展 API 订阅事件标识丢失问题。

### 兼容性

- Android、iOS 和 HarmonyOS SDK 版本统一升级到 1.4.0。
- 编译器升级到 1.1.0，Node.js 最低版本要求调整为 20。
- JSSDK 升级到 1.0.17。

## [v1.3.1] 2026-05-29

- Android、iOS 和 HarmonyOS 新增小程序远程更新管理，支持更新检查、资源下载、应用更新及 `updateManifestUrl` 配置。
- 三端补齐动态 TabBar API，支持 badge、red dot、样式和显隐状态更新。
- 完善 Canvas Promise 调用与 WebGL 支持。
- 扩展 API 支持 Promise-like 返回，并可通过 `Object.keys(wx)` 枚举宿主注册的自定义 API。
- 优化 QuickJS 错误信息和源码更新机制，改善页面容器与开发调试体验。
- Android、iOS 和 HarmonyOS SDK 升级到 1.3.1，JSSDK 升级到 1.0.11。

## [v1.3.0] 2026-05-18

- Android、iOS、HarmonyOS 及 Web 完善 TabBar 与 `switchTab` 能力，并优化图标、高度和弹窗堆叠处理。
- 新增 Video 组件及原生同层渲染支持，完善 Android、iOS 和 HarmonyOS 的视频控制与事件交互。
- 新增 Canvas 绘制、图片处理、`canvasToTempFilePath` 和 WebGL 能力。
- 新增小程序菜单与胶囊按钮，完善菜单按钮几何信息、宿主环境信息和多端 vConsole 调试。
- 优化生命周期、组件初始化、properties/observer、`setData` 批处理、slot、数据绑定和事件处理。
- 编译器新增兼容性诊断、sourcemap、`--force`、自定义应用类型与环境配置，并完善循环依赖、模块解析和表达式编译。
- 优化 Android WebView 资源加载与缓存、iOS 异步资源加载与 Swift Package Manager 集成、HarmonyOS 存储与布局处理。
- Android、iOS 和 HarmonyOS SDK 升级到 1.3.0，编译器升级到 1.0.16，JSSDK 升级到 1.0.10。

## [v1.2.0] 2026-04-07

- Android、iOS 和 HarmonyOS 新增 `extBridge`/`extOnBridge` 第三方扩展桥接，并支持自定义全局 API 命名空间。
- Web 端新增基于 hash 的小程序路由与刷新后页面栈恢复，并完善 WebSocket `SocketTask` 管理。
- 完善组件父子/ancestor-descendant relations、页面与组件生命周期、behavior 合并及 observer 执行语义。
- 新增多列 Picker，完善 Slider、RichText、IntersectionObserver 和复杂表达式绑定。
- 编译器迁移至 Oxc 解析与代码生成链路，优化 WXS、CSS、动态 slot、npm 模块和 Windows 路径处理。
- 优化 Android libuv 定时器与 WebView 缓存/资源请求，iOS Bridge 返回与 Xcode 26 构建，HarmonyOS 定时器、Promise 与 API 18 兼容性。
- 编译器升级到 1.0.12，JSSDK 升级到 1.0.5。

## [v1.1.3] 2025-08-22

- 编译器新增 TypeScript、Less、SCSS 和 npm 组件支持，并优化 WXS 循环依赖处理。
- 完善组件 attached/ready 生命周期、relations 建立、properties 访问和 observer 旧值传递。
- 优化 MovableView、PickerViewColumn、Slider 和 Swiper 交互，新增 Vant 与 Taro 示例。
- 修复 iOS WebView 非主线程执行 JavaScript 问题，统一 CocoaPods source tag 并简化 podspec 结构。
- 编译器升级到 1.0.8，JSSDK 升级到 1.0.3。

## [v1.1.2] 2025-07-01

- 修复 Android 同步存储 API 对 `JSONArray` 的序列化与反序列化问题。
- Android SDK 升级到 1.1.2。

## [v1.1.1] 2025-06-30

- 新增组件父子与 ancestor-descendant 关系管理。
- 重构 iOS WebView 生命周期、资源处理、状态机和复用校验。
- 修复 Android 虚拟资源 URL 中 `appId` 的字母数字匹配问题。
- 修复滚动穿透、behavior 无效对象处理和编译文件路径缺失时的异常。
- Android SDK 升级到 1.1.1。

## [v1.1.0] 2025-06-18

- 新增 Taro 3 编译产物兼容，完善代理 API 和资源基础路径处理。
- 优化编译器在 Windows 路径、跨分包共享组件、自依赖和同一组件被多页面引用时的编译逻辑。
- 优化 iOS WebView 池、预加载、URL Scheme 资源处理，新增振动 API 和暗色主题适配。
- HarmonyOS 新增 `chooseVideo`、核心日志和逻辑层 vConsole 输出，并优化 QuickJS 依赖与工程结构。
- 完善 Android 和前端测试/发布工作流，新增基于 tag 的发布日志生成。
- 编译器升级到 1.0.7，JSSDK 升级到 1.0.1。

## [v1.0.0] 2025-05-22

- Dimina 首次开源发布。
- 提供 DMCC 小程序编译器、逻辑层/视图层运行时、标准组件和原生 Bridge 基础能力。
- 提供 Android、iOS、HarmonyOS 和 Web 容器及对应接入示例。
- 编译器版本为 1.0.6，JSSDK 版本为 1.0.0。
