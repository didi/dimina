# Canvas 运行架构

[文档中心](./README.md) · [能力参考](./API-Reference.md) · [微信小游戏运行](./Mini-Game.md)

Dimina 同时支持旧版 `wx.createCanvasContext()`、`<canvas type="2d">` / `SelectorQuery.fields({ node: true })`，以及小游戏和离屏 Canvas。下面四条入口最终共用渲染层的真实 `HTMLCanvasElement`，但定位方式、调用协议和生命周期不同。

## 入口与节点模型

| 入口 | 定位方式 | 主要用途 |
| --- | --- | --- |
| `<canvas canvas-id="id">` + `wx.createCanvasContext()` | `canvas-id` 与当前页面或自定义组件实例 | 旧版批量绘图、像素读写和导出 |
| `<canvas type="2d" id="id">` + SelectorQuery | `id` 查询后取得 `node` | Canvas 2D / WebGL 节点 API |
| `wx.createOffscreenCanvas()` | 逻辑层创建的 node id | 不显示在页面中的 2D / WebGL 绘制 |
| 小游戏 `wx.createCanvas()` | 当前小游戏 runtime | 第一个节点上屏，后续节点离屏 |

新编译产物把 `<canvas>` 统一编译为 `dd-canvas`。组件根节点承载小程序声明的 `id`、`dataset`、布局、边框和插槽，内部 `HTMLCanvasElement` 承载实际绘图。两者通过共享的非 `data-*` DOM property 显式关联，因此：

- SelectorQuery 的尺寸、位置、`id` 和 `dataset` 来自组件根节点；`node` 来自内部 canvas。
- 框架归属信息不会进入小程序事件的 `target.dataset`。
- slot 中出现其他 canvas 或组件内部结构变化时，不会改变 `node` 的目标。

运行时仍识别旧编译包中的原生 `<canvas>`。旧包与新基础库组合运行时，页面查询不会落到自定义组件的私有 canvas，自定义组件根节点本身就是 canvas 的情况也能被当前组件作用域解析。

## `canvas-id` 作用域

旧版 `canvas-id` 的唯一性范围是“页面 + 自定义组件实例”。相同组件的两个实例可以各自使用 `canvas-id="chart"`；同一实例内重复时只有成功登记的 canvas 可被解析。

登记由当前 `canvas-id` 和 `type` 共同决定：

- 没有 `type` 的 legacy canvas 参与 `canvas-id` 登记。
- 带 `type` 的节点不参与 legacy 登记，也不会被 `createCanvasContext()` 选中。
- 动态修改 `canvas-id` 或 `type` 会释放旧登记并重新 claim；同一轮更新中等待旧 owner 让出后，候选节点会重新解析。

归属和 active 状态使用 DOM property，而不是 CSS selector 或 `dataset`。resolver 比较属性原值，因此特殊字符 id 不会改变查询语义，也不能注入联合 selector。

## 绘制顺序

legacy API 先按页面或组件作用域解析 `canvas-id`，再把操作交给真实 canvas 的队列：

1. 同一作用域内的 lookup 串行，避免节点动态挂载或改 id 时后发请求越过先发请求。
2. lookup 完成后立即释放作用域队列。
3. 同一真实 canvas 的绘制、像素读写和导出串行；不同 canvas 互不阻塞。

`draw(reserve)` 的 `reserve` 只决定像素去留，不决定绘图状态：两种取值下新批次都从默认样式、变换和裁剪区开始，官方示例里第二批没重设 `fillStyle` 时画出来就是默认黑色。`reserve:false` 通过重建 backing store 一次清掉像素与状态；`reserve:true` 不能动 backing store，改由每批开头的一层基线 `save` 帧承载整批状态，下一批开始时弹回默认值而画面不动。批内未配平的 `restore()` 停在批边界，弹不走基线帧——真实 canvas 对空栈 `restore()` 同样是空操作。微信 iOS 的底层字号跨批次泄漏，两条重置路径都保留 `font`。

Canvas node API 在逻辑层积累 operation，flush 后由渲染层逐条结算。每条 operation 的异常独立返回，图片加载、像素 Promise、RAF callback 和状态反馈都绑定到 node owner；成功、失败、取消或销毁只允许一个终态。

Canvas 2D 状态以渲染层宿主 context 为最终权威。逻辑层提供同步的 optimistic getter，并以单调序号接收宿主 readback；迟到反馈不能覆盖新值。`save()` / `restore()`、`reset()` 和 backing size 变化会同步更新状态栈。宿主没有 `reset()` 时，渲染层通过重建同尺寸 backing store 清除像素、路径、clip、save stack 和绘图状态，再返回完整状态快照。

## 位图与传输预算

所有公开入口在分配或序列化前使用同一组限制，渲染层还会对旧基础库和直接 bridge 消息再次校验：

| 边界 | 限制 |
| --- | --- |
| canvas 单边 | 最大 4096 像素 |
| RGBA backing store / 导出目标 | 最大 32 MiB，即 8,388,608 像素 |
| `canvasGetImageData` / `canvasPutImageData` JSON 传输 | 按每通道最坏四个字符计费，最大 2,097,152 像素 |
| native 导出 | 每个 app 最多 2 个未结算请求，并同时限制累计 Base64 载荷 |

尺寸检查覆盖组件 `renderWidth` / `renderHeight`、布局同步、node width / height setter、离屏和小游戏创建、legacy 像素 API 与 `canvasToTempFilePath`。超限请求在创建输出 canvas、`getImageData()`、`Array.from()` 或 `toDataURL()` 之前失败。

`canvasToTempFilePath` 的缺省目标尺寸按源尺寸和设备 pixel ratio 计算，显式 `destWidth` / `destHeight` 保持调用方值；最终尺寸仍受上述单边和总像素限制。

## 导出与 runtime 生命周期

渲染层编码后，三端各自解码并发布临时文件，都不阻塞收到 bridge 消息的那个调用点：Android 在 `Dispatchers.IO`、iOS 在按 app 和 generation 划分的后台串行队列上执行；HarmonyOS 的 bridge 入口必须同步返回，因此校验留在同步段，解码与写盘交给主线程上的异步串行队列，配合异步文件 API 完成。每个请求都绑定 app owner 和 runtime generation：

- 退出、重启或替换 runtime 时先推进 generation，并取消尚未开始的旧请求。
- 已经开始的请求在真正结束前继续占用计数和字节预算，不能让新 runtime 绕过峰值限制。
- 旧 generation 的结果不能投递给新逻辑层；如果文件已经发布，会立即删除。
- success / fail 与 complete 在同一串行域结算，销毁不能插入“检查通过”和“发送 callback”之间。

页面卸载或小游戏替换时，逻辑层会向渲染层发送 node dispose。渲染层随后清理 DOM canvas、事件监听、RAF、context、图片和 node 所属资源；逻辑层同时清理 callback、WebGL capability 和上屏 / 离屏 canvas 引用。

## 源码入口

| 范围 | 文件 |
| --- | --- |
| 编译到 `dd-canvas` | `fe/packages/compiler/src/common/utils.js`（`tagWhiteList` 收录 `canvas`）、`fe/packages/compiler/src/core/view-compiler.js`（`dd-` 前缀规则） |
| 组件与 DOM contract | `fe/packages/components/src/component/canvas/Canvas.vue`、`fe/packages/common/src/core/dom-contract.js` |
| 公共位图预算 | `fe/packages/common/src/core/canvas-limits.js` |
| legacy API | `fe/packages/service/src/api/core/ui/canvas/index.js` |
| Canvas node proxy | `fe/packages/service/src/api/core/ui/canvas/canvas-node.js` |
| resolver、回放、导出与 node 资源 | `fe/packages/render/src/core/runtime.js` |
| native 导出 | Android `ImageApi.kt`、iOS `ImageAPI.swift`、HarmonyOS `DMPContainerBridgesModule+Canvas.ets` |
