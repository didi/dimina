# Dimina 文档中心

Dimina（星河小程序）由 DMCC 编译器、逻辑层与渲染层运行时、内置组件，以及 Android、iOS、Harmony 和 Web 容器组成。本目录用于解释这些模块如何协作，并提供能力边界、生命周期和小程序包更新等专题说明。

> 如果你只想运行示例，请先回到[项目首页](../README.md#最快上手)。这里更适合准备接入 SDK、排查跨端差异或参与框架开发的读者。

## 按目标开始

| 你的目标 | 建议先读 | 接下来 |
| --- | --- | --- |
| 了解 Dimina 如何工作 | [架构总览](./Architecture-Diagram.md) | [实现细节](./Architecture-Details.md) |
| 判断某项能力是否可用 | [能力参考](./API-Reference.md) | 对应平台的 SDK 接入文档 |
| 排查页面或组件初始化时序 | [生命周期](./Architecture-Lifecycle.md) | `service` / `render` 运行时源码与测试 |
| 接入内置包或远程更新 | [小程序包更新](./MiniProgram-Update.md) | 对应平台的 Bundle Loader 实现 |
| 查看 WebSocket API、事件与平台限制 | [WebSocket 能力](./websocket-architecture.md) | 对应平台的 Manager 与校验源码 |
| 参与前端框架开发 | [前端工程说明](../fe/README.md) | [贡献指南](../CONTRIBUTING.md) |

## 核心阅读路径

1. [架构总览](./Architecture-Diagram.md)：从源码、编译产物到四端容器的完整链路。
2. [实现细节](./Architecture-Details.md)：编译器产物结构、双线程模型、通信通道与页面容器。
3. [生命周期](./Architecture-Lifecycle.md)：App、页面和组件的关键调用时机与约束。
4. [能力参考](./API-Reference.md)：模板标签、内置组件、API 和扩展 Bridge 的支持状态。
5. [小程序包更新](./MiniProgram-Update.md)：内置包、远程 manifest、校验、安装与 `wx.getUpdateManager()`。
6. [WebSocket 能力](./websocket-architecture.md)：公开 API、`SocketTask` 方法、事件数据、连接规则与平台限制。

## 平台接入

| 平台 | 逻辑执行环境 | 视图容器 | 接入文档 |
| --- | --- | --- | --- |
| Android | QuickJS | Android WebView | [Android SDK](../android/README.md) |
| iOS | JavaScriptCore | WKWebView | [iOS SDK](../iOS/README.md) |
| Harmony | QuickJS | Harmony WebView | [Harmony SDK](../harmony/dimina/README.md) |
| Web | Web Worker | Browser | [前端框架与容器](../fe/README.md) |

## 仓库模块

```text
dimina/
├── fe/          # DMCC、service、render、组件和 Web 容器
├── android/     # Android SDK、QuickJS 引擎与示例
├── iOS/         # iOS SDK 与示例
├── harmony/     # Harmony SDK 与示例
├── shared/      # 各原生端共享的小程序包与 JS SDK
├── docs/        # 架构、能力和机制文档
└── static/      # README 与文档引用的图片
```

## 文档约定

- 文档中的“逻辑层”指运行小程序业务逻辑与生命周期的 service runtime；“渲染层”指 Vue 驱动的 render runtime。
- `publish` 用于逻辑层和渲染层之间经容器转发的消息；`invoke` 用于逻辑层或渲染层调用容器能力。
- 能力表表示仓库当前确认的实现状态，不等同于微信小程序完整能力集合；业务代码仍应使用 `wx.canIUse()` 做运行时保护。
- 编译产物目录中的根 `config.json` 是宿主包元数据；`main/app-config.json` 是 DMCC 根据小程序配置生成的运行时配置，两者职责不同。

## 本地验证

前端文档涉及的命令以 `fe/` 为工作目录：

```sh
cd fe
pnpm install
pnpm compile
pnpm test
pnpm lint
```

提交文档变更前，请至少确认相对链接有效、示例路径与当前仓库一致，并在修改能力表后运行：

```sh
cd fe
pnpm --filter compiler sync:compat
git diff -- packages/compiler/src/common/compatibility-reference.js
```

确认生成文件的变化与能力表一致；如果能力名称没有变化，生成文件应保持不变。该检查用于确保编译器的兼容性提示与[能力参考](./API-Reference.md)同步。
