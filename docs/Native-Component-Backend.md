# Android 原生组件承载后端

`NativeComponentBackend` 将原生 View 的承载方式从组件实现中抽出。地图、cover-view、cover-image 和原生 web-view 共用同一个页面后端。旧版 Render 发送的原生视频消息也通过这个后端处理。地图服务商通过 `MapProvider` 扩展，承载方式通过 `NativeComponentBackendFactory` 扩展。

## 职责与调用链

```text
Render 的组件消息 / 布局 / 触摸
  → NativeComponentHost
      → 组件实例 / MapProvider：SDK 属性、命令、事件、生命周期
      → NativeComponentBackend：挂载、布局、裁剪、层级、触摸、移除
```

| 接口 | 约定 |
| --- | --- |
| `attach(id, type, view, onVisibilityChanged)` | 接收尚无 parent 的 View；同一后端内 id 唯一；布局可见性改变时通知组件 |
| `updateLayout(id, layout)` | 接收不可变的 CSS 坐标快照，由后端转换和应用 |
| `dispatchTouch(message)` | 处理 Render 转发的多指触摸；无需转发的后端可返回 false |
| `updatePageBackgroundColor(color)` | 更新页面底色；有原生组件展示时不能用不透明 WebView 盖住组件 |
| `detach(id)` | 先取消尚未结束的手势，再移除自己承载的 View |
| `destroy()` | 幂等清理本页面的挂载和监听；此后不再接收新组件 |

后端不销毁 SDK 实例。Host 在后端移除视图之后调用组件 `release`，地图再调用 provider 的 `destroy`。地图根据后端可见性和 Activity 前后台状态决定 `resume/pause`。其他组件保留各自原有的播放和生命周期语义。

所有接口和注册操作在主线程调用。每个页面创建独立后端，不共享 id、触摸状态或视图。旧页面的后端被清理后不能复用；新页面由工厂重新创建。布局、挂载和命令仍通过现有 NativeComponentHost 路径发送。

## 默认实现与扩展

默认使用 `WebViewUnderlayBackend`，无需增加初始化代码。现有 `NativeComponentHost(activity, webView, overlay) { message -> … }` 构造方式保留，由它调用工厂；也可以通过接受 `NativeComponentBackend` 的构造方法显式注入。

宿主在打开小程序前注册工厂。例如，下面使用现有实现并显式配置 WebView 恢复时的页面底色：

```kotlin
import android.graphics.Color
import com.didi.dimina.ui.view.nativecomponent.NativeComponentBackends
import com.didi.dimina.ui.view.nativecomponent.WebViewUnderlayBackend

NativeComponentBackends.setFactory { context ->
    WebViewUnderlayBackend(
        webView = context.webView,
        layer = context.nativeLayer,
        pageBackgroundColor = Color.WHITE,
    )
}

// 恢复默认工厂；已有页面继续使用原后端。
NativeComponentBackends.resetFactory()
```

自定义实现替换工厂返回值即可。工厂必须每次返回新实例。`context` 提供当前 Activity、WebView 和原生组件层；默认后端要求原生层与 WebView 的位置和尺寸对齐，并位于 WebView 下方，现有容器已满足此约定。

默认后端初始底色为白色，DiminaActivity 在创建 Host 时传入页面配置颜色，运行时背景 API 也通过 Host 更新后端。原生组件展示期间保持 WebView 透明，移除后恢复最新配置色。WebView 的页面底色独立于 `View.background`，不能通过读取 background 推断；自定义容器应显式传入 `pageBackgroundColor` 或调用更新接口。普通 background drawable 另外保存和恢复。

## 能力边界

默认后端的 `capabilities`：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `name` | `webview-underlay` | 系统 WebView 下方承载原生层 |
| `requiresTransparentDomAncestors` | true | 原生组件及其 DOM 祖先需要透明背景 |
| `requiresDomTouchForwarding` | true | 使用现有 DOM 命中与触摸转发 |
| `embedsIntoDom` | false | 未接入浏览器的 DOM 合成层 |
| `supportsPageBackground` | true | 接收根页面纯色背景，由原生底层绘制 |

地图挂载成功时通过 `nativeComponentBackend.supportsPageBackground` 协商页面底色承载。只有明确支持的后端才启用根页面纯色转移；其他能力仍供原生宿主查询，注册后端不会自动改变 embed 和触摸协议。

默认后端保留现有兼容行为：同步页面滚动和尺寸变化；将 CSS 坐标转换为原生像素；用 `clipBounds` 裁剪且保留完整 View 尺寸；地图位于原生 cover 组件下方；隐藏或卸载时取消手势；最后一个可见组件移除后恢复 WebView 底色。清理只移除本后端挂载的 View，不清空宿主原生层中的其他子视图。

这次抽象覆盖 Android，未改变 iOS/Harmony 的承载实现。它也没有消除系统 WebView 下方承载方案的限制：不支持任意 CSS stacking context、复杂 mask、旋转/斜切变换等完整 DOM 合成。地图 SDK 仍需提供适合承载的视图；当前高德使用 TextureMapView。

后续接入有原生 embed 能力的 WebView 内核时，可以在此边界实现新的后端，但还需要对应内核、Render 节点关联、布局/触摸协议以及 SDK 渲染适配。仅替换这个工厂不会获得完整同层渲染。

源码入口：[`NativeComponentBackend.kt`](../android/dimina/src/main/kotlin/com/didi/dimina/ui/view/nativecomponent/NativeComponentBackend.kt)、[`NativeComponentLayout.kt`](../android/dimina/src/main/kotlin/com/didi/dimina/ui/view/nativecomponent/NativeComponentLayout.kt)、[`WebViewUnderlayBackend.kt`](../android/dimina/src/main/kotlin/com/didi/dimina/ui/view/nativecomponent/WebViewUnderlayBackend.kt)。地图 SDK 扩展见[地图接入](./Map-Integration.md)。
