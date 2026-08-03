# @dimina/fe-container-sdk

Web 端小程序容器运行时 SDK：管理小程序的启动、导航栈与生命周期。

- 核心不含 UI——应用列表、手机壳等展示由宿主提供；SDK 附带一个可选的极简状态栏 `createDefaultShell()`。
- 分层对齐 Android / iOS / Harmony 三端的「管理器 + App 实例」模型。
- `fe/packages/container` demo 是参考消费者实现。

## 快速开始

```bash
npm install @dimina/fe-container-sdk
```

```js
import { createContainer } from '@dimina/fe-container-sdk'
import '@dimina/fe-container-sdk/style.css' // 容器视图结构样式（导航栏/页面栈/动画），必须显式引入

const container = createContainer({
	mount: document.getElementById('root'), // 必填：容器根元素
})

await container.openApp({ appId: 'wx92269e3b2f304afc', path: 'example/index' })
```

- 包以预构建 `dist/`（ESM）分发；`CreateContainerOptions` / `ContainerInstance` / `ShellAdapter` 等契约类型随包导出，TS 宿主可直接 `import type`。
- 零配置即可启动：不传 `shell` 时状态栏几何降级为全 0 矩形，不传 `getAppInfo` 时不发起任何元信息请求，不调用 `setRootView` 也能正常 `openApp`/`closeApp`。

`openApp()` 能真正打开页面，还需要两份资源就位：小程序编译产物（下一节）和渲染层宿主页 `pageFrame.html`（再下一节）。

## 小程序资源约定

SDK 本身不产出、也不内置任何小程序，`appId`/`path` 只是 URL 拼接参数。`openApp()` 之前须把小程序编译产物按固定目录结构放到 `resourceBaseUrl` 指向的位置：

```
resourceBaseUrl/
└── {appId}/
    └── main/                   # 主包，目录名固定叫 main
        ├── app-config.json     # 必需：全局配置（app.pages 页面列表 / window 样式 / modules 等）
        ├── app.css             # 全局样式
        ├── logic.js            # 逻辑层 bundle，加载进 Worker 运行
        ├── pages_index.js      # 每个页面一份 JS/CSS，pagePath 里的 "/" 替换成 "_"
        └── pages_index.css     # 例如 pagePath "pages/index" -> "pages_index.js/.css"
```

加载规则：

- `openApp({appId, path})` 请求 `${resourceBaseUrl}${appId}/main/app-config.json`，`path` 必须是其 `app.pages` 数组里的一项。请求 404 / 网络失败 / JSON 非法不会静默空白，走 `onAppLaunchError` 通知宿主。
- `pageFrameUrl`（缺省 `resourceBaseUrl/pageFrame.html`）是另一份独立资源，不在 `{appId}/` 目录下。
- `getAppInfo(appId)` 返回的 `{name, logo}` 仅用于展示（如启动屏文案），与 `app-config.json` 加载互不依赖。

真实例子见 `fe/packages/container/public/wx6d707864656d6f01/`（单页面）；带分包的见 `wxbaf4b47de04f1d8a/`（`main/` 之外还有平级的 `sub_xxx/` 分包目录，各自一份 `logic.js`）。

产物不绑定任何编译器，目录结构符合约定即可。本仓库的产物由内置编译器生成：`fe/example/{projectName}/` 是小程序源码（appId 取 `project.config.json` 的 `appid` 字段），在 `fe/`（pnpm workspace 根）跑 `pnpm compile` 编译到 `fe/packages/container/public/{appId}/`，demo 再把 `public/` 当静态资源托管、原样作为 `resourceBaseUrl`。

## 页面渲染帧宿主页面

`resourceBaseUrl` 目录下需提供一个 `pageFrame.html`：

- 脚本入口 `import` 本包的 `@dimina/fe-container-sdk/pageFrame` 与 `@dimina/fe-container-sdk/pageFrame.css`。
- 参考实现见 `fe/packages/container/src/pageFrameEntry.js` + 同目录 `pageFrame.html`。
- 该子路径入口仅提供 ESM，只会以 `<script type="module">` 形式在 iframe 里加载。

## 配置项（CreateContainerOptions）

| 字段 | 说明 |
|---|---|
| `mount` | 必填，容器根元素 |
| `shell.getStatusBarRect` | 宿主提供状态栏几何（`{top,left,width,height,...}`），用于自定义导航栏 / 胶囊按钮布局对齐 |
| `shell.updateStatusBarColor` | 状态栏前景色（黑/白）变化通知，供宿主壳联动切换深浅色 |
| `resourceBaseUrl` | 小程序资源请求基路径，缺省 `/`。经真实 `URL` 解析归一化为绝对 URL（相对路径按 `window.location.origin` 解析），畸形输入同步抛错。宿主部署在非根路径时必须显式传入 |
| `pageFrameUrl` | 渲染层 iframe 的 URL，缺省基于归一化后的 `resourceBaseUrl` 解析出 `pageFrame.html`；同样经 `URL` 解析，畸形输入同步抛错 |
| `allowedOrigins` | `resourceBaseUrl`/`pageFrameUrl` 最终解析出的 origin 白名单（如 `[location.origin]`）。不传不限制来源；传了则两者（含走缺省值解析出的 origin）都必须精确命中，否则 `createContainer()` 同步抛错 |
| `apiNamespaces` | 额外 API 命名空间（如 `['qd']`），每个小程序 `getApiNamespaces()` 都会返回它 |
| `urlSync` | 地址栏路由同步。由 `application.syncUrl()` 统一从**当前展示栈栈顶实例**派生并回写——只要栈顶变化（打开/切前台/关闭后露出下一个/全部关闭）就会同步，不由某个小程序的内部导航各自决定。缺省 `true` 沿用内置 `QueryRouter`（`history.replaceState` 改写地址栏 `?appId=&entry=&page=`；无小程序打开时清除）；传 `false` 完全关闭；传 `{ syncStack(appId, stack), clear(), buildShareUrl?(appId, stack) }` 自定义适配器接管（例如接入宿主自身的 hash-router），此时 SDK 不再自己碰 `history`；可选的 `buildShareUrl` 供小程序菜单的"复制链接"使用，不实现时该菜单项直接隐藏而不是拼一个打不开的地址。**多容器**：同一地址栏无法让两个都用内置 `QueryRouter`、且都不传 `instanceKey` 的容器共存（固定 query key 会互相覆盖）——给每个容器传各自不同的 `instanceKey` 即可都保留 `urlSync: true`（见下一行）；不想用命名空间方案时也可只给其中一个容器留 `urlSync: true`，其余传 `false` 或各自的自定义适配器 |
| `instanceKey` | 多容器场景下给这个容器实例一个稳定身份 key：内置 `QueryRouter` 的地址栏 query key 会按这个 key 命名空间化（如 `appId` → `appId__{instanceKey}`），多个容器各自传不同的 `instanceKey` 即可都安全使用缺省 `urlSync: true`，不再互相覆盖，各自的 `clear()` 也只删自己命名空间下的 key。不传时行为与该特性存在之前完全一致（不加命名空间）。对自定义 `urlSync` 适配器没有约束力——只影响内置 `QueryRouter` |
| `storageSync` | `wx.setStorage`/`getStorage`/`removeStorage`/`clearStorage`/`getStorageInfo` 的落地位置，key 按 `` `${appId}_${key}` `` 命名空间隔离，与 `fe/packages/container` 旧实现字节级一致。缺省 `true` 沿用内置 `window.localStorage`；传 `false` 完全关闭（5 个方法都不再触碰 `localStorage`，且一律以 `fail` 收场，不会假装成功却读不回数据）；传 `{ getItem, setItem, removeItem, length, key }` 自定义适配器接管（方法形状对齐 `window.localStorage` 的最小子集），例如路由到宿主自己的存储介质。**已知限制**：`appId`/`key` 本身含下划线时纯字符串拼接不是单射，不同 `(appId, key)` 组合可能拼出相同的底层 key（如 `appId="a_b"+key="c"` 与 `appId="a"+key="b_c"`），`clearStorage` 的前缀匹配同理可能误删/漏删；这是 Web `localStorage` 单一扁平 keyspace 的固有限制（Android/iOS 原生实现按 appId 分独立存储实例规避了这个问题，Web 侧暂不引入不兼容旧数据的新 key 格式来解决）。**多容器**：命名空间只按 appId 区分，两个各自 `createContainer()`、都用默认 `storageSync: true` 的容器打开同一个 `appId` 时会写到完全相同的 `localStorage` key、互相覆盖——与 `urlSync` 的多容器碰撞同构，多容器场景请给其中至少一个容器传自定义适配器（例如按容器实例追加命名空间前缀） |
| `getAppInfo(appId)` | 小程序元信息提供者，可同步或异步返回 `{name?, logo?} \| null \| undefined`，缺省返回 `{}` |
| `onAppLaunchError(error, {appId})` | 小程序启动失败（配置不可达/为空/非法等）通知。`openApp` 不因此 reject（与 Native 端「打开成功但内容加载失败走回调」对称）；容器销毁打断不触发 |
| `apis` | 启动阶段注册的容器级 API（`{name: handler}`），等价于拿到容器实例后立刻逐个调用 `registerApi`，但保证严格早于任何 `openApp()`（见下方「registerApi 边界」） |
| `extModules` | 启动阶段注册的第三方扩展模块（`{name: handler}`），等价于立刻逐个调用 `registerExtModule` |

```js
const container = createContainer({
	mount: document.getElementById('root'),
	shell: {
		getStatusBarRect: () => hostShell.getStatusBarRect(),
		updateStatusBarColor: color => hostShell.setStatusBarColor(color),
	},
	resourceBaseUrl: '/static/miniapp/',
	apiNamespaces: ['qd'],
	getAppInfo: appId => hostApi.fetchAppInfo(appId),
})
```

## 容器 API（ContainerInstance）

| 成员 | 说明 |
|---|---|
| `application` | 导航栈应用实例（挂载在 `mount` 下） |
| `openApp({appId, path?, scene?, destroy?, restoreStack?})` | 打开/前置小程序；同 appId 二次打开复用缓存实例；`destroy: true` 先销毁其他 appId 的实例；resolve 为打开的 miniApp 实例。`path` 省略时入口页取 `restoreStack[0]`（pagePath + query 对象直传，`QueryRouter.parse()` 的 `stack` 可直接回传）；两者都缺失则 reject |
| `closeApp(miniApp?)` | 关闭（不销毁）当前/指定小程序 |
| `registerExtModule(name, handler)` | 注册第三方扩展 bridge 模块 |
| `registerApi(name, handler)` | 容器级注册/覆盖 API（小程序侧经 `wx.xxx` / 命名空间调用），对已打开和之后打开的小程序都生效；`this` 为触发调用的 miniApp 实例 |
| `setRootView(view)` | 可选注入根视图（宿主自定义首页，如应用列表页） |

补充语义：

- 同一容器内连续 `openApp()` 串行排队：前一次完整呈现（含入场动画）后才处理下一次，即使不 `await` 也不会互相打断。
- miniApp 实例另支持实例级 `registerApi(name, handler)`（后写覆盖容器级同名注册）与 `getApiNamespaces()`。

### registerApi 边界

- 容器级注册优先于容器内置实现（可覆盖 `scanCode` 这类容器承接的 API）；已在 `@dimina/service` 逻辑层内置实现的 API（调用不出 worker）无法从容器侧覆盖。
- 在首个 `openApp()` 之前完成的注册，名字在逻辑层 `Object.keys(wx)` 中可枚举（供 Taro 等按名建表的框架识别）；之后补注册的名字仍可调用，但不保证可枚举。`createContainer({apis, extModules})` 即保证注册早于任何 `openApp()`。

## 默认状态栏壳（可选）

不想自己实现 shell 适配器时，用 `createDefaultShell()`：渲染一条极简无品牌状态栏（默认 44px 高、显示 HH:MM 时间、随页面 `navigationBarTextStyle` 切换深浅色），并实现好 `getStatusBarRect` / `updateStatusBarColor`：

```js
import { createContainer, createDefaultShell } from '@dimina/fe-container-sdk'

const shell = createDefaultShell({ mount: document.getElementById('shell-host') })
const container = createContainer({ mount: document.getElementById('root'), shell })
// 不再需要时：shell.destroy()
```

选项：`mount`（提供则自动 prepend，不传则自行插入 `shell.el`）、`height`（默认 44）、`showTime`（默认 true）。返回的方法可安全解构成裸函数引用传递。
