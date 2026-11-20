# 小程序接入与排查

[文档中心](./README.md) · [能力参考](./API-Reference.md) · [生命周期与就绪时序](./Architecture-Lifecycle.md)

接入已有小程序时，先选一条完整业务路径，例如从宿主入口打开页面、更新数据，再返回宿主。用这条路径同时检查编译、目标平台能力和运行时行为。

## 编译成功，但目标平台不能正常运行

在开发环境编译并保留 source map：

```sh
dmcc build -c ./miniapp -s ./dist --sourcemap
```

先看构建输出中的 `[compat]` 提示。DMCC 会提示清单外的直接 `wx` API 引用、未支持或未声明的组件，以及无效的模板属性前缀。宿主自行注入的 API 也可能触发提示，需要核对目标宿主是否注册了该能力。即使没有提示，也要按[能力参考](./API-Reference.md)核对目标平台和参数限制，并实际运行相关路径。桌面端额外核对[桌面原生能力与限制](../desktop/sdk/Native-APIs.md)。

对于可选能力，在支持 `wx.canIUse()` 的目标环境中用它判断入口，然后仍处理调用失败，例如权限拒绝、设备不可用。必须具备的能力应在试接入时验证成功、失败和退出清理三个路径。

## 先确定要调试哪一层

| 平台 | 逻辑层 / 业务数据 | 渲染层 / 样式 |
| --- | --- | --- |
| Android | 初始化时设置 `Dimina.DiminaConfig.Builder().setDebugMode(true)`，用 vConsole 查看逻辑日志、`wx.request` 与小程序 Storage。 | 宿主为 debuggable 构建时，可用 Chrome 检查 WebView。 |
| iOS | 启动前设置 `appConfig.isDebugMode = true`，使用 vConsole。 | SDK 的 Debug 构建在 iOS 16.4+ 将 WKWebView 标为可检查。 |
| HarmonyOS | 设置 `appConfig.isDebugMode = true` 或运行 Debug HAP 可打开 vConsole。需要调试 `app.js` 等入口时，按[QuickJS 断点手册](./JavaScript-Debugging.md)配置 source map、调试端口和 HDC 转发。 | 使用 DevEco Studio 的 Web 调试工具检查 WebView。 |
| Web | 用浏览器开发工具检查逻辑 Worker。 | 检查页面 iframe 中的 DOM、样式和事件。 |
| 桌面 | 用最小小程序复现，并保存桌面运行时日志及宿主调用错误。 | 从开发环境以 `DIMINA_DESKTOP_DEBUG=1` 启动运行时可启用 WebView DevTools。 |

vConsole 的 Network 面板覆盖 `wx.request`，上传、下载和 WebSocket 需单独排查。复现时使用测试账号和数据。

### 白屏、点击没反应或数据没更新

1. 确认宿主打开的 `appId`、入口路径和包版本正确，记录 SDK、JSSDK 和 DMCC 版本。桌面运行时的编译产物目录见[桌面接入](./Desktop-Integration.md)。
2. 启动异常时，按资源加载、逻辑报错、首轮渲染、页面就绪的顺序检查。需要跨层对日志时附上 `bridgeId`、页面路径和事件类型，有条件时附上 `resourceLoadId`。
3. 如果逻辑数据更新了但读到旧布局，把测量放到 `setData(data, callback)` 或首次 `onReady` 后。返回、快速重复打开、关闭后重开分别复现一次，记录在哪条路径出现差异。

### 慢在首屏还是交互

先说明用户看到的现象，例如点击入口后长时间空白，或者列表更新后迟迟没有反应。把首次安装或解包、已装包的冷启动、后台实例恢复分开记录。用同一设备、同一包和相同网络条件比较，记录是否开启了调试模式。

[Web 性能基准](../fe/packages/benchmark/README.md)已有打开到 `onReady`、列表更新和 `setData` 等用例，适合比较前端运行时改动。移动和桌面的首屏观感、系统 WebView 与原生桥接的表现需要在对应设备上单独验证。记录 `onReady` 时，也应注明它表示生命周期就绪。用录屏或平台性能工具另外确认画面出现和可点击的时点。

## 让页面与宿主 App 的导航保持一致

先选一个入口页，在页面 JSON 使用 `"navigationStyle": "custom"`，由页面绘制与宿主一致的标题栏。保留胶囊时，可用 `wx.getMenuButtonBoundingClientRect()` 为它留出空间。根据实际 safe area 布局，不写死状态栏高度。

| 场景 | 当前可用的配置 |
| --- | --- |
| Android 宿主级胶囊和启动界面 | 初始化前配置 `setShowCapsule()`、`setCapsuleBackgroundColor()`、`setCapsuleIconColor()`、`setShowLaunchLoading()`。 |
| iOS / HarmonyOS 宿主级胶囊和启动界面 | 启动前设置各自 `DMPAppManager` 的 `showCapsule`、`capsuleBackgroundColor`、`capsuleIconColor`、`showLaunchLoading`。 |
| Web 宿主外层过渡 | 通过[容器配置](../fe/packages/container-sdk/README.md#配置项createcontaineroptions)控制 `appTransitions`、加载页淡出和状态栏适配。 |
| 桌面客户端 | 现有 SDK 提供[独立小程序窗口](./Desktop-Integration.md)。窗口内的样式与宿主页面内嵌是两种接入需求。 |

移动端外观开关由宿主控制，作用范围可能包括宿主内的多个小程序。混用不同外观时，先限定试点范围。隐藏胶囊或使用自定义导航时，显式提供可见的返回或退出操作，并测试首页、二级页、系统返回和快速重进。只有宿主能提供加载与失败反馈时，再关闭默认启动界面。

## 提交可复现的问题

记录目标平台、系统与设备、宿主 SDK / JSSDK / DMCC 版本、最小页面、触发步骤、实际和预期结果。性能问题附上录屏或耗时样本，兼容问题列出受影响的 API、参数或组件。分享日志前去掉鉴权头、请求正文、业务数据和 Storage 内容。
