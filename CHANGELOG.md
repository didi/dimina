# Changelog

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
