# Changelog

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
