# Dimina 实现细节

[文档中心](./README.md) · [架构图](./Architecture-Diagram.md) · [生命周期](./Architecture-Lifecycle.md) · [能力参考](./API-Reference.md)

本文从实现角度说明 Dimina 如何把小程序源码转换为可在 Android、iOS、Harmony 和 Web 容器中加载的资源包。阅读前建议先浏览[架构总览](./Architecture-Diagram.md)。

## 一句话模型

```text
小程序源码 → DMCC 编译 → 运行时资源包 → 宿主容器加载
                                      ├─ service：业务逻辑与生命周期
                                      ├─ render：Vue 驱动的视图
                                      └─ native：路由、系统能力与扩展 Bridge
```

Dimina 保留小程序“逻辑层与渲染层分离”的基本模型。业务逻辑不直接操作 DOM；它通过数据更新和事件消息驱动视图。容器既负责转发逻辑层与渲染层消息，也负责把小程序 API 映射到平台能力。

## 1. 源码与编译产物

### 1.1 DMCC 处理的输入

DMCC 从 `project.config.json`、`app.json` 和页面配置中收集工程信息，并处理以下主要文件：

| 输入 | 作用 | 当前实现 |
| --- | --- | --- |
| `.js` / `.ts` | App、页面、组件与公共逻辑 | 转换为模块并合并到各包的 `logic.js` |
| `.wxml` / `.ddml` | 页面和组件结构 | 转换为 Vue render 模块 |
| `.wxss` / `.ddss` | 小程序样式 | 处理作用域、`rpx`、资源路径与 `@import` |
| `.less` / `.scss` / `.sass` | 预处理样式 | 先转换为 CSS，再进入同一套样式流水线 |
| `.json` | App、页面和组件配置 | 汇总到 `main/app-config.json` |
| `.wxs` 与内联 `wxs` / `dds` | 视图脚本 | 编译到相应视图模块 |
| `miniprogram_npm/` | 小程序 npm 组件 | 按组件依赖关系解析并编译 |

编译器还支持通过编程入口追加自定义模板、样式和视图脚本扩展名。命令行参数与完整示例见 [DMCC 使用说明](../fe/packages/compiler/README.md)。

### 1.2 产物目录

以页面 `pages/index/index` 为例，当前 DMCC 的产物结构大致如下。文件命名属于编译器与运行时之间的内部契约，不应由业务代码自行拼接：

```text
<appId>/
├── main/
│   ├── app-config.json
│   ├── logic.js
│   ├── app.css
│   ├── pages_index_index.js
│   ├── pages_index_index.css
│   └── static/
└── <subpackage>/
    ├── logic.js
    ├── pages_detail_index.js
    └── pages_detail_index.css
```

这里有两个容易混淆的配置文件：

- `main/app-config.json` 由 DMCC 生成，包含 App 配置、页面/组件模块信息与项目名称，供运行时读取。
- 根目录 `config.json` 是宿主打包或发布阶段使用的包元数据，通常包含 `appId`、入口路径和版本号。仓库内的 `generate-app` 流程会在生成原生端小程序包时创建或更新它。

页面路径中的 `/` 会在视图和样式文件名中转换为 `_`。主包与每个分包分别拥有自己的 `logic.js`；页面视图和样式按页面拆分，容器只加载当前页面需要的文件。

### 1.3 四条编译流水线

#### 逻辑编译

逻辑编译器使用 OXC 解析 JavaScript / TypeScript，处理模块依赖、资源路径和兼容性提示，再由 esbuild 完成语法转换与压缩。App、页面和组件模块以 `modDefine()` 注册，运行时按模块路径加载：

```js
modDefine('app', function (require, module, exports) {
  App({})
})

modDefine('pages/index/index', function (require, module, exports) {
  Page({})
})
```

#### 视图编译

视图编译器解析 WXML / DDML，将条件、循环、事件、组件、模板、插槽和 WXS 等语义转换为 Vue render 模块。页面和其依赖的自定义组件会被收集到对应页面产物中。

#### 样式编译

样式编译器使用 PostCSS 与 Vue SFC 的作用域能力处理页面和组件样式，并完成 `rpx`、资源路径、自动前缀、压缩及 Less / Sass 预处理。组件样式随引用关系合并到页面样式产物。

#### 配置编译

配置编译器合并 App、页面、分包和组件声明，并处理 tabBar 图标等静态资源，最终生成 `main/app-config.json`。

编译页面、逻辑和样式时，DMCC 使用 Worker 并行执行三个任务；产物发布阶段再统一复制到目标目录。

## 2. 运行时分层

| 层 | 主要职责 | 典型实现 |
| --- | --- | --- |
| Service 逻辑层 | App / Page / Component 实例、生命周期、数据、API 调用 | Android / Harmony 使用 QuickJS，iOS 使用 JavaScriptCore，Web 使用 Web Worker |
| Render 渲染层 | 加载页面视图与样式、Vue 响应式渲染、DOM 事件与测量 | WebView 或 Browser 中的 Vue runtime |
| Container 容器层 | 页面栈、消息转发、资源加载、预热、权限和平台 API | Android、iOS、Harmony SDK 或 Web 容器 |
| Native 能力层 | 相机、定位、蓝牙、存储、网络及宿主扩展能力 | 各平台模块与 ExtModuleHandler |

逻辑层与渲染层不直接通信。所有跨层消息都经过容器，因此消息顺序、序列化边界和页面 `bridgeId` 是理解运行时行为的关键。

## 3. 两类消息通道

| 通道 | 用途 | 典型场景 |
| --- | --- | --- |
| `publish` | 容器转发逻辑层与渲染层之间的消息 | `setData()`、页面事件、组件创建与状态同步 |
| `invoke` | 调用容器或指定目标层的能力，并按需返回结果 | `wx.request()`、路由、系统 API、选择器查询 |

### 3.1 数据更新

```text
Page / Component.setData()
  → service 严格解析 key 并深拷贝写入逻辑数据
  → behavior observer、组件 observer 按注册顺序执行
  → service 生成不可变的 JSON 视图快照
  → container 通过 publish 转发
  → render 更新响应式状态
  → Vue 计算并更新必要的 DOM
  → render 在 nextTick 后确认回调
```

同一逻辑任务内的更新按模块批量传输，路径数组保留转义字段与数组下标的准确含义。数据 observer 引发的嵌套 `setData()` 会加入当前事务并继续按注册顺序排空；property observer 在数据 observer 阶段之后正序执行。初始化阶段的 `setData()` 回调会等到视图侧对应模块就绪后再刷新，避免业务回调早于真实渲染状态。

### 3.2 用户事件

```text
用户操作
  → render 收集事件与 dataset
  → container 通过 publish 转发
  → service 定位页面或组件实例
  → 执行业务方法
  → 可选 setData() 驱动下一次视图更新
```

### 3.3 原生 API

```text
wx.xxx()
  → service invokeAPI()
  → container 查找平台实现
  → native / Web API 执行
  → success / fail / complete 或 Promise 返回业务层
```

同名 API 在不同平台可能有不同实现或暂未接入，使用前应查看[能力参考](./API-Reference.md)，并用 `wx.canIUse()` 做运行时保护。

## 4. 页面与资源加载

原生端为页面维护逻辑路由记录，并由平台容器决定 WebView 的创建、复用、缓存与销毁策略。页面栈承载 `navigateTo`、`redirectTo`、`navigateBack`、`switchTab` 与 `reLaunch` 等操作。容器可以预热 WebView 以减少首次打开页面的初始化成本，但物理 WebView 数量不是业务可依赖的公开契约，页面栈深度与预热策略也需要由宿主控制。

小程序资源先由宿主提供，再复制或解压到各平台沙盒。运行时通过平台文件映射或资源加载器读取这些文件，而不是让小程序业务代码直接访问任意本地路径。内置包、沙盒目录和远程更新流程见[小程序包更新说明](./MiniProgram-Update.md)。

## 5. 设计边界

- **异步边界真实存在**：service、render 和 native 之间的消息不能依赖同一 JavaScript 微任务队列保证先后顺序。
- **页面可见性由容器驱动**：资源未就绪时应缓存最新可见状态，并在 `resourceLoaded` 后通过同一 service 通道发送；service 不根据实例创建状态推测 `pageShow`。
- **视图状态以 render 就绪为准**：需要 DOM 或组件布局的操作应放在 `onReady` 或明确的渲染完成回调之后。
- **平台能力不是天然一致**：service 暴露 API 入口不代表每个容器都已实现相同语义。
- **离线包不等于更新平台**：Dimina 提供包加载与基础远程更新链路，但发布、灰度、签名和运营策略仍由宿主负责。
- **小程序兼容以明确能力为准**：不要根据 Vue 或浏览器本身的能力推断小程序语法和 API 一定可用。

## 6. 源码入口

| 关注点 | 目录 |
| --- | --- |
| DMCC 编译器 | [`fe/packages/compiler`](../fe/packages/compiler) |
| Service 逻辑层 | [`fe/packages/service`](../fe/packages/service) |
| Render 渲染层 | [`fe/packages/render`](../fe/packages/render) |
| 内置组件 | [`fe/packages/components`](../fe/packages/components) |
| Web 容器 | [`fe/packages/container`](../fe/packages/container) |
| Android SDK | [`android/dimina`](../android/dimina) |
| iOS SDK | [`iOS/dimina`](../iOS/dimina) |
| Harmony SDK | [`harmony/dimina`](../harmony/dimina) |

下一步可继续阅读[生命周期](./Architecture-Lifecycle.md)或[能力参考](./API-Reference.md)。
