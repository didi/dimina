# Web 端 AI 小程序生成

[文档中心](./README.md) · [Web 容器 SDK](../fe/packages/container-sdk/README.md) · [编译器](../fe/packages/compiler/README.md)

Web 首版提供模型适配、源码生成、浏览器本地编译、隔离预览和本地保存。模型由宿主开发者提供，可以运行在云端；编译和小程序执行不经过编译服务器。Android、iOS、Harmony 的生成接入尚未实现。

## 运行示例

```sh
cd fe
pnpm install
pnpm dev
```

打开 Web 演示，在顶部切换「AI 创建」，或点击手机应用列表中的「用 AI 创建小程序」。工作区使用演示中原有的手机预览，切换组件演示和 AI 创建不会跳转页面；可通过 `/?workspace=generator` 直接进入。旧的 `/generator.html` 地址自动跳转到这个工作区。在「模型连接」中选择接口协议，填写自己的模型接口地址、模型名称和访问令牌，然后描述需求。模型服务或网关需允许示例站点跨域访问。

工作区支持继续对话修改、取消、源码编辑后重新编译、导入/导出完整源码工程、打开本地应用、恢复上一版和删除。源码及编译产物保存在 IndexedDB；应用运行数据单独保存。生成的小程序会显示在演示应用列表中。离开 AI 工作区时取消生成并释放预览，重新进入时从本地恢复；模型配置和源码草稿在本次页面内保留。只有编译、首屏渲染和保存成功后才替换当前版本，启动期间的存储写入先暂存，失败时保留原应用。

生成、自动修复、本地编译、启动和保存状态会同步显示在模拟器中，完成后自动进入小程序预览。停止或失败时显示对应提示；已有小程序时，可点击「返回小程序」继续使用上一个已保存版本。

源码编辑区使用 Prism 按所选文件高亮 JavaScript、JSON、WXML（含插值）和 WXSS。输入、选择、复制粘贴和撤销继续由原生文本框处理，高亮层随滚动、尺寸变化和文件切换同步更新。

也可以导入源码 ZIP 或符合协议的工程 JSON，独立验证本地编译和运行。生产构建使用 `pnpm build`；工作区随 Web 演示一同输出，支持子路径部署。

## 源码导入与导出

「导出源码」下载以应用名称命名的 ZIP，包含整个小程序工程的应用入口、页面、组件、工具模块及样式、配置，保留原有目录结构和 UTF-8 内容，同时补齐 `project.config.json` 和 `README.md`。解压后的项目可以继续编辑，并按说明使用 Dimina 编译器构建。

源码编辑区中尚未编译的修改也会一并导出，便于保存开发中的草稿；重新导入运行时仍需通过工程校验和本地编译。压缩包内容仅为源码、项目配置和使用说明。

「导入源码」支持上述 ZIP（源码位于根目录或一个外层目录中），同时兼容原有 `{ name, files }` JSON。导入后创建独立的小程序及运行数据空间。导入文件上限为 2 MiB，源码继续遵循 80 个文件和 1 MiB 的限制。

## 开发者接入

`@dimina/generator` 是仓库中的独立工作区包。模型接入通过 `provider.generate(request)` 完成：

```js
import {
  createGenerator, createPreview, createProjectStore,
} from '@dimina/generator'

const provider = {
  async generate({ system, prompt, files, messages, signal }) {
    // 适配开发者自己的模型 SDK 或服务。
    return myModel.generateProject({ system, prompt, files, messages, signal })
  },
}
const generator = createGenerator({ provider })
const store = createProjectStore()
const preview = createPreview({ mount: document.getElementById('preview') })
const controller = new AbortController()

const project = await generator.generate({
  prompt: '创建一个待办清单',
  signal: controller.signal,
  // 修改已有小程序时传 project: existingProject。
})
await preview.open(project, {
  signal: controller.signal,
  beforeCommit: () => store.put(project),
})
```

返回值可以是工程对象、工程 JSON 字符串，或逐段输出 JSON 文本的 `AsyncIterable<string>`。生成请求携带当前源码、用户指令和有限的对话历史。默认在工程校验或编译失败后携带失败源码及诊断自动修复一次；`maxRepairs: 0` 可以关闭。取消操作通过 `AbortSignal` 传播，编译 Worker 会终止。

生成器本身不写入应用库，宿主使用预览的 `beforeCommit` 完成持久化事务。预览启动失败时不会执行该回调；回调失败也不会替换已有预览。

`createProjectStore()` 提供 `get(id)`、`list()`、`put(project)` 和 `delete(id)`。`preview.destroy()` 销毁当前和正在启动的预览。宿主退出工作区时应同时取消生成和销毁预览。

预览应覆盖完整的设备视口，让容器处理标准导航栏的状态栏留白。宿主自行绘制状态栏时，可通过 `createPreview({ mount, statusBarHeight, onStatusBarColorChange })` 传入其未缩放的 CSS 像素高度，并在颜色回调中同步状态栏图标。回调参数仅为 `black` 或 `white`，由页面配置或 `wx.setNavigationBarColor` 驱动，与胶囊内图标保持一致；候选版本启动、保存成功后才提交其颜色。独立预览默认状态栏高度为 0。

## HTTP 模型接入

### Chat Completions 兼容接口

示例页面默认选择「OpenAI 兼容（DeepSeek 等）」。可填写服务基础地址或完整的 `/chat/completions` 地址；例如 `https://api.deepseek.com` 自动补全为 `https://api.deepseek.com/chat/completions`，`https://your-service.example/v1` 补全为 `https://your-service.example/v1/chat/completions`，已填写完整路径时不会重复追加。

DeepSeek 可填写模型名称 `deepseek-flash`，并使用自己的访问令牌，详见 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/)。代码接入方式：

```js
import { createHttpProvider } from '@dimina/generator'

const provider = createHttpProvider({
  url: 'https://api.deepseek.com',
  protocol: 'chat-completions',
  model: 'deepseek-flash',
  headers: { Authorization: `Bearer ${accessToken}` },
})
```

适配器发送 `model`、`messages` 和 `stream: false`，把生成规范、当前源码和对话历史转换为聊天消息，再从 `choices[0].message.content` 读取工程 JSON 文本。此模式需要填写模型名称，使用非流式文本输出；不适用于 Responses 等其他协议。Anthropic 服务请选择下文的 Messages 模式。

### Anthropic Messages 接口

在「模型连接」中选择「Anthropic Messages（Claude 等）」，填写自己的服务地址、该服务提供的模型名称及 API Key。支持 `https://api.anthropic.com`、`https://api.anthropic.com/v1` 或完整的 `https://api.anthropic.com/v1/messages`，不会重复追加路径；自有网关也可以使用此协议。接口定义见 [Anthropic Messages 文档](https://platform.claude.com/docs/en/api/messages/create)。

```js
const provider = createHttpProvider({
  url: 'https://api.anthropic.com',
  protocol: 'anthropic-messages',
  model: modelName,
  headers: { 'x-api-key': accessToken },
  maxTokens: 8192,
})
```

适配器把生成规范放入顶层 `system`，将当前源码与对话历史转为 `user` / `assistant` 消息，发送 `max_tokens` 和 `stream: false`，并拼接返回 `content` 中的 `text` 块作为工程 JSON。多轮修改、编译错误自动修复和取消操作继续沿用同一流程。

为兼容常见 Messages 网关，默认发送 `anthropic-version: 2023-06-01`；开发者可通过 `headers` 覆盖版本。浏览器直连同时发送 `anthropic-dangerous-direct-browser-access: true`，服务需允许相应请求头及当前页面来源跨域访问。`maxTokens` 默认 8192，达到输出上限时会提示简化需求或提高上限。

### 自定义工程网关

已有网关可选择「自定义工程网关」。SDK 的 `createHttpProvider({ url, protocol: 'gateway', model?, headers? })` 默认使用此模式，向开发者配置的完整地址发送 POST JSON，不追加路径：

```json
{
  "system": "生成规范和 Web 能力范围",
  "prompt": "用户本次需求",
  "model": "开发者可选的模型标识",
  "files": {},
  "messages": [{ "role": "user", "content": "用户本次需求" }]
}
```

网关把模型输出转换为以下工程对象，返回 `application/json`：

```json
{
  "name": "计数器",
  "files": {
    "app.json": "{\"pages\":[\"pages/index\"]}",
    "app.js": "App({})",
    "pages/index.js": "Page({data:{count:0},add(){this.setData({count:this.data.count+1})}})",
    "pages/index.wxml": "<view>{{count}}<button bindtap=\"add\">增加</button></view>",
    "pages/index.wxss": "view { padding: 40rpx; }"
  }
}
```

每次返回完整工程；修改时沿用既有功能和存储 key。`appId` 及编译配置由客户端确定，模型不提供运行时模块、编译产物或宿主代码。HTTP 适配器不携带 Cookie，不跟随重定向；示例中的令牌只存于当前页面内存，刷新后清空。公开产品应由开发者自己的网关管理长期凭据和额度。

## 编译与运行边界

- 输入为 JavaScript、WXML、WXSS、JSON；最多 80 个文件、1 MiB 源码、12 个主包页面。支持标准页面及本地自定义组件。暂不开放分包、npm 安装、TypeScript、Less/Sass 和外部资源。
- `@dimina/compiler/browser` 复用 DMCC 的逻辑、视图、样式和配置编译器，使用内存文件系统、OXC Wasm、esbuild Wasm。浏览器样式构建保留作用域及 rpx 转换，不运行桌面端前缀数据库和 CSS 压缩。每个任务独占 Worker，任务完成、失败、取消或超时后终止。
- 预览继续使用 Dimina service/render 和 Web 容器。新增 `resourceContents` / `resourceUrls` 供宿主传入本地产物，`runtimeAssets` 供可信宿主注入运行时资源，`miniApp.whenReady()` 等待首屏就绪；原有 URL 目录加载方式继续可用。
- 生成预览运行于仅允许脚本的 sandbox iframe，渲染层通过 MessagePort 通信。它无法读取宿主页 DOM、Cookie 或 localStorage，网络请求及外部脚本受 CSP 限制，相机、麦克风和定位未授权。应用通过限定于自身 ID 的存储通道持久化数据。
- Web 存储使用异步 `wx.setStorage/getStorage/removeStorage/clearStorage`；当前 Web 容器不提供同步存储语义。生成预览面向个人工具类小程序，地图、蓝牙、Canvas、系统权限、宿主扩展及跨 frame DOM 等场景需要额外适配。
- 页面加载后，已保存的小程序可以断网重新打开和使用；首次打开站点、加载编译器以及云端生成需要网络。当前没有离线站点壳或 Service Worker 缓存，不能保证关闭浏览器后断网访问站点。
- 首版将 Wasm 随编译 Worker 打包，未压缩约 22 MB，仅在编译时加载。预览运行时约 2 MB；后续可以再拆分编译资产和缓存。
- 原生 JSSDK 打包按构建清单排除生成器专用资源，同时保留 service、pageFrame JS/CSS。

## 验证

```sh
cd fe
pnpm --filter @dimina/generator... build
pnpm --filter @dimina/container build
pnpm --filter @dimina/generator test
pnpm --filter @dimina/generator exec playwright install chromium
pnpm --filter @dimina/generator test:browser
```

浏览器回归使用真实发布构建、真实 Wasm 编译器和真实运行容器，只拦截外部模型响应。覆盖 Chat Completions 基础地址接入、Anthropic Messages、自定义网关、按钮、输入、条件与循环、本地模块、数据持久化、刷新后重开、断网运行、自动修复、版本恢复、失败编辑保留旧版、隔离及移动端布局。可通过 `DIMINA_CHROME_PATH` 指定已安装的 Chromium，通过 `DIMINA_TEST_ARTIFACTS` 指定截图目录。

子路径验证：以 `GITHUB_ACTIONS=1 pnpm --filter @dimina/container build` 生成 `/dimina/` 构建，再使用 `DIMINA_TEST_BASE=/dimina/ pnpm --filter @dimina/generator test:browser`。模型输出质量、真实服务的鉴权/CORS、Firefox/Safari 和原生端需要另行验证。

