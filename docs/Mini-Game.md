# 微信小游戏运行支持

Dimina 可从微信小游戏源码的入口形态识别运行类型，并在 Android、iOS、HarmonyOS 和 Web 上复用同一套 Service/Render 运行时启动 `game.js`。小游戏不创建 `App`、`Page` 或 WXML 页面实例，渲染入口是 `wx.createCanvas()`。

## 工程识别

DMCC 按以下顺序判断工程类型：

1. `project.config.json` / `project.private.config.json` 的 `compileType` 为 `game`；
2. 未声明 `compileType` 时，工程同时包含 `game.json` 与 `game.js`（或 `game.ts`），且不包含 `app.json`。

普通小程序仍使用 `app.json`、`app.js` 和页面列表。小游戏编译后统一生成以下入口：

```text
{appId}/
└── main/
    ├── app-config.json   # app.runtimeType = "game"，entryPagePath = "game"
    └── logic.js          # game.js 及其本地依赖
```

小游戏不生成 `app.css`、页面 CSS 或页面视图脚本。`game.json` 的原始字段会保留在 `app-config.json` 的 `app` 对象中，供后续容器能力继续扩展。

## 启动方式

Web 容器可省略页面路径，由配置判断运行类型和入口：

```js
await container.openApp({ appId: 'wx-game-app-id' })
```

Android、iOS 和 HarmonyOS 同样在解析 `app-config.json` 后读取 `app.runtimeType`。当值为 `game` 时，三端固定使用配置声明的 `game` 入口，并在发送给逻辑层和渲染层的 `loadResource` 消息中携带 `runtimeType: "game"`。因此小游戏识别不依赖宿主额外传一个平台专有开关。

## 当前运行能力

- 第一次调用 `wx.createCanvas()` 创建铺满渲染 WebView 的上屏 Canvas；后续调用创建离屏 Canvas。
- 支持 Canvas 2D、WebGL、`requestAnimationFrame` / `cancelAnimationFrame` 和 `wx.createImage()`。
- 支持 `wx.onTouchStart`、`onTouchMove`、`onTouchEnd`、`onTouchCancel` 及对应 `off*` API。
- 支持小游戏 `wx.onShow` / `offShow`、`wx.onHide` / `offHide`，并复用现有错误事件、系统信息、网络、存储等共享 `wx` API。
- `GameGlobal` 与小游戏全局 `global` 在执行 `game.js` 前建立。

同一个容器替换或重启小游戏 runtime 时，会在执行新的 `game.js` 前销毁旧 runtime 的 Canvas owner。旧上屏 canvas、事件监听、RAF、context、图片和 WebGL capability 都会释放；新 runtime 的第一次 `wx.createCanvas()` 再创建唯一的上屏 canvas。`resourceLoaded` 只更新当前 runtime 的能力信息，不会销毁刚由 `game.js` 创建的节点。页面卸载与显式退出走同一套 owner 清理，因此旧 runtime 的迟到 callback 或资源不能进入新 runtime。

Canvas 节点、状态、位图限制和 native 导出生命周期见 [Canvas 运行架构](./canvas-architecture.md)。

首版目标是运行以 Canvas 为主的小游戏入口，并非一次性覆盖微信小游戏的全部专属能力。开放数据域、游戏圈按钮、好友关系链、小游戏分包和独立 Worker 等专属接口目前未提供；业务应继续用 `wx.canIUse()` 做能力保护。

## 本地验证

前端运行时：

```sh
cd fe
pnpm --filter compiler test
pnpm --filter service test
pnpm --filter render test
pnpm --filter fe-container-sdk test
pnpm build
pnpm generate:sdk
```

`pnpm generate:sdk` 会把最新 Service/Render 打进 `shared/jssdk/main.zip`。Android Gradle、iOS 资源复制脚本和 Harmony Hvigor 构建随后从 `shared/jssdk` 同步同一份产物。编译和单元测试通过不等于真机图形性能、触摸延迟或 WebGL 驱动兼容性验收，发布前仍需在三端真机上运行目标游戏包。
