# web-view 局部嵌入（Dimina 扩展）

`embedded` 是 **Dimina 扩展属性**，不属于微信小程序规范。本文的局部嵌入示例适用于 Dimina；跨平台项目需通过平台分支或降级方案处理该扩展，不能依赖微信端支持此属性。

`web-view` 支持通过 `embedded="{{true}}"` 在页面中嵌入 H5 卡片、表单和图表。Android、iOS、Harmony 和 Web 使用同一渲染层组件，以宿主 WebView 内的 iframe 承载局部内容。未开启时沿用原有承载模式。

## 页面接入

```xml
<!-- embedded 为 Dimina 扩展属性，本示例适用于 Dimina -->
<view class="container">
  <view>页面头部</view>
  <web-view
    id="form"
    embedded="{{true}}"
    src="{{formUrl}}"
    style="width: 100%; height: 400rpx; border-radius: 24rpx;"
    bindmessage="onMessage"
    bindload="onLoad"
    binderror="onError"
  />
  <view>页面底部操作栏</view>
</view>
```

| 属性 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| embedded | Boolean | false | **Dimina 扩展属性**。开启局部嵌入；可动态切换 |
| src | String | 空字符串 | H5 地址；局部模式支持 HTTP(S) 地址及可解析为 HTTP(S) 的相对地址 |

局部模式参与普通 CSS 布局，默认宽度为父容器的 `100%`、高度为 `150px`，建议业务显式设置高度。可用 `class`、`style` 和动态数据设置尺寸、圆角、隐藏状态、定位及层级；可以放进 `scroll-view`，随父容器滚动和裁剪。页面中的普通视图可按 CSS 层叠规则遮挡它。H5 内部有独立滚动区域和输入焦点，父页无法直接访问跨域 H5 的 DOM。

修改 `src` 会创建新的 iframe，原 H5 的输入、滚动位置和 JavaScript 状态会被清除。组件移除、重新创建或切换承载模式时，同样会释放旧实例；旧实例的消息不再进入页面事件。

## H5 消息与 SDK

H5 需要加载包含局部通道支持的 `jdimina_next.js`。在仓库的 `fe/` 目录运行：

```sh
pnpm --filter jdimina-next build
```

将 `fe/packages/jdimina/dist/jdimina_next.js` 部署到 H5 自己可访问的静态资源地址，然后在 H5 中引用：

```html
<script src="/assets/jdimina_next.js"></script>
<script>
  wx.miniProgram.getEnv(function (env) {
    if (env.miniprogram) {
      wx.miniProgram.postMessage({ data: { status: 'ready' } })
    }
  })
</script>
```

局部模式不会向跨域 H5 自动注入脚本；已部署的旧版 SDK 需要随 H5 更新。SDK 在子帧中通过 `postMessage` 通道联系所属组件，在原生顶层网页中继续使用原生桥。

小程序侧接收消息：

```js
Page({
  onMessage(event) {
    // 每次消息即时触发，data 是包含本次业务数据的数组。
    const payload = event.detail.data[0]
    console.log(payload.status)
  },
})
```

局部通道支持 `wx.miniProgram.postMessage`、`getEnv`，以及 `navigateTo`、`navigateBack`、`redirectTo`、`switchTab`、`reLaunch` 路由调用。路由由所属页面的逻辑层处理；其余宿主原生 API 不通过局部通道开放，需要由 H5 发送业务消息，再由小程序决定是否调用。组件只接收自身当前 iframe 发出的消息，多实例之间互不转发。

无需 SDK 时，H5 也可以使用 `window.parent.postMessage(payload, targetOrigin)`，其中 `targetOrigin` 为宿主页面实际来源；局部组件会按 `event.detail.data = [payload]` 交付原始消息。已有 Web 全屏模式的原始消息结构保持不变。

## 加载事件与部署条件

| 事件 | detail | 触发条件 |
| --- | --- | --- |
| load | `{ src }` | 当前 iframe 触发浏览器 `load` |
| error | `{ url, fullUrl, errMsg }` | 地址协议或宿主能力不受支持，或当前 iframe 触发浏览器 `error` |
| message | `{ data: [payload] }` | 当前 H5 发送业务消息；每次即时交付 |

`load` 表示浏览器完成 iframe 加载事件，不代表 H5 业务初始化成功。浏览器不会可靠地将跨域 HTTP 错误、网络失败或嵌入策略拦截报告为 iframe `error`；需要确认业务就绪时，应让 H5 用 `postMessage` 主动通知。

H5 服务端必须允许宿主来源嵌入：`Content-Security-Policy: frame-ancestors` 和 `X-Frame-Options` 可能阻止显示。HTTPS 宿主加载 HTTP H5、第三方 Cookie、登录跳转和键盘行为还受浏览器及宿主系统策略影响。推荐使用 HTTPS，并在实际宿主设备上验证登录和表单流程。

Android 宿主还需同时支持 AndroidX WebKit 的 `WEB_MESSAGE_LISTENER` 与 `DOCUMENT_START_SCRIPT`，以便把原生桥限制在受信主帧。旧内核保留原有全屏承载，局部模式触发 `error`。接入时需同步更新原生 SDK 与渲染资源；仅替换前端资源无法给旧版宿主补充隔离通道。iOS 保持原生桥仅接受主帧消息，Harmony 按实际调用帧地址校验原生代理。

更新宿主安装包后，还应核对端侧实际使用的 `jssdkVersion`。渲染资源有独立的版本和缓存；新资源的 `versionCode` 必须高于已缓存版本，才能触发替换。旧运行时可能将 `embedded` 当作普通属性继续创建原生占位节点，不能仅凭宿主安装成功判断局部模式已生效。

底层接口见 [Android WebViewCompat](https://developer.android.com/reference/androidx/webkit/WebViewCompat) 和 [Harmony 调用帧地址](https://developer.huawei.com/consumer/en/doc/harmonyos-references-V14/js-apis-webview-V14/)。

## 验证

组件与 SDK 单元测试覆盖承载模式切换、原生实例释放、消息来源隔离、回调和动态 `src`。浏览器集成用例会编译 WXML，并跨域加载 H5 与 SDK，检查尺寸、圆角、遮挡、滚动、输入、消息及重建：

```sh
cd fe
pnpm --filter components test
pnpm --filter jdimina-next test
DIMINA_CHROME_PATH="/path/to/chrome" pnpm --filter generator test:browser:web-view
```

浏览器用例中的平台 UA 用于验证渲染分支，不替代 Android、iOS、Harmony 的系统 WebView 真机验收。

### 真机验证记录（2026-11-11）

同一份 WXML 测试页及当前源码打包的运行时已在以下设备验证：

| 检查项 | iPhone 14 Pro / iOS 27.2 | HUAWEI Mate 60 Pro / OpenHarmony 7.0.0.111 | PLK110 / Android 17 |
| --- | --- | --- | --- |
| 400rpx 高度 | 209.59 CSS px | 206.93 CSS px | 193.83 CSS px |
| 动态调整为 280rpx | 146.72 CSS px，输入值保留 | 144.85 CSS px，输入值保留 | 135.68 CSS px，输入值保留 |
| 圆角、普通视图遮挡与点击归属 | 通过 | 通过 | 通过 |
| 父 scroll-view 滚动、裁剪及 H5 内部滚动 | 通过 | 通过 | 通过 |
| H5 输入、焦点与系统软键盘 | 自动化输入通过；手动点入确认软键盘并留存截图 | 真实触摸输入通过，系统软键盘截图已检查 | 真实触摸输入通过，系统软键盘截图已检查 |
| getEnv 回调与 postMessage | 回调返回 miniprogram=true，消息到达所属页面 | 回调返回 miniprogram=true，消息到达所属页面 | 回调返回 miniprogram=true，消息到达所属页面 |
| 主、副 iframe 消息隔离 | 通过 | 通过 | 两个实例分别点击上报，消息无串发 |
| src 换址与组件销毁后重建 | 新文档加载并重新完成消息握手 | 新文档加载并重新完成消息握手 | 新文档加载并重新完成消息握手，换址后输入值清空 |

iOS 使用真机 UI 自动化完成点击、输入和拖动，鸿蒙使用设备触摸与输入命令完成相同操作，并结合运行时 DOM 尺寸、页面事件和系统截图核对结果。鸿蒙还实测了父子帧消息往返、旧 Window 消息过滤及子帧直接调用宿主原生代理被拒绝。

Android 使用系统 WebView 144.0.7559.132，通过设备触摸、拖动和输入命令完成相同操作，并核对当前运行时实际创建的 iframe、DOM 尺寸和系统截图。父子帧消息往返、旧 Window 消息过滤均通过；跨域 H5 子帧中无法访问宿主渲染原生桥。测试 H5 使用 HTTPS，独立测试包仅信任本地测试证书，未放宽正式宿主的混合内容策略。

以上记录覆盖局部布局、基本交互和消息链路；不代表所有机型、登录流程或第三方 Cookie 策略均已验证。
