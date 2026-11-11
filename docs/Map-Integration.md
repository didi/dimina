# 地图接入与 provider 扩展

移动端接入地图**原生 SDK**：Android、iOS、HarmonyOS 首个 provider 为高德；Web 使用高德 JS API 2.0。厂商依赖为可选接入，核心容器不强制依赖高德。小程序使用同一套 `map` 和 `wx.createMapContext()`。

## 架构与扩展约定

| 层级 | 职责 |
| --- | --- |
| 小程序 | 声明属性、绑定事件、调用 MapContext |
| Service / Render | 按页面、组件实例和地图 id 查找目标；命令排队、超时、回调结算、销毁 |
| 移动端传输适配器 | 创建原生占位节点；发送 mapMount / mapUpdate / mapContext / mapUnmount；同步布局 |
| 原生宿主 | 承载 View / UIView / ArkUI Builder，派发触摸与事件，管理生命周期 |
| Android 承载后端 | 独立于地图 provider，统一处理原生组件挂载、布局、裁剪、层级和触摸 |
| 地图 provider | 转换厂商属性和命令，创建并释放 SDK 实例 |
| 集成应用 | 注册 provider、提供平台 Key、确认隐私授权、声明定位权限 |

原生接口分别位于 Android `map/MapProvider.kt`、iOS `Map/DMPMapProvider.swift`、HarmonyOS `Map/DMPMapProvider.ets`。接口包含 `create`、`update`、`invoke`、`destroy` 和 `ready/event/error` 回调，Android 另有 `resume/pause`，Harmony 的可选 `detach` 用于释放重建中的原生节点并保留地图状态。SDK 可接收命令后才能报告 ready；初始化失败应释放部分创建的资源。所有原生接口在 UI 线程调用，销毁应可重复执行。

接入其他地图 SDK 时，实现对应平台接口并通过 `MapProviders` / `DMPMapProviders` 注册和选择即可。无需修改 Map.vue、Service、编译器或小程序。注册表只影响随后创建的地图，已有实例保持其 provider。厂商对象和 Key 不经过小程序桥接。

`update` 接收完整属性快照，适配器只应用发生变化的字段，避免无关 setData 重置用户拖动位置或命令新增的标记。`invoke` 返回命令结果；不支持的方法必须失败，不能返回伪成功。

## Android

仓库示例 App 不预置高德接入配置。宿主负责提供平台 Key、隐私授权和定位权限，并在打开小程序前注册 provider。

适配器独立发布为 `com.github.didi.dimina:map-amap`，与核心 SDK 使用同一版本。发布包含此配置的新 tag 后，宿主可从 JitPack 接入（旧 tag 不会自动补发）：

```kotlin
// repositories 中需包含 maven("https://jitpack.io")
implementation("com.github.didi.dimina:map-amap:<与核心一致的版本>")
```

该依赖会传递引入核心 SDK 和固定版本的高德 SDK；核心 SDK 本身不引入高德。仓库源码集成仍可使用：

```kotlin
// 宿主 app/build.gradle.kts
implementation(project(":map-amap"))
```

在打开小程序之前，在主线程注册：

```kotlin
import com.didi.dimina.map.MapProviders
import com.didi.dimina.map.amap.AMapProvider

MapProviders.register("amap", AMapProvider(apiKey) { privacyConsentGranted })
```

`apiKey` 与 `privacyConsentGranted` 由宿主提供。适配器确认同意后才调用高德隐私初始化和创建地图。模块使用 Maven `com.amap.api:3dmap-location-search:11.2.100_loc11.2.100_sea9.8.1`；不要再同时引入另一个版本的高德地图/定位聚合包。

地图展示只需网络权限；定位另需在宿主 manifest 声明：

```xml
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
```

定位使用 DiminaActivity 的授权流程，接受粗略或精确位置授权。不请求后台定位。可选模块的 manifest 已包含以下定位服务，由 manifest merger 合并进宿主：

```xml
<service android:name="com.amap.api.location.APSService" android:exported="false" />
```

### 同层渲染兼容

承载逻辑由独立的 `NativeComponentBackend` 接口管理，默认实现为 `WebViewUnderlayBackend`。地图、视频、cover-view、cover-image 和内嵌 web-view 共用该抽象；宿主可以按页面创建后端，地图 provider 继续只负责厂商 SDK。注册方法、接口契约与后续内核接入边界见[原生组件承载后端](./Native-Component-Backend.md)。

Android 使用仓库现有的原生组件兼容路径：原生组件层位于透明 WebView 下方，Render 中保留 `application/view` embed 和 `data-dimina-native-*` 触摸目标。高德适配器使用 **TextureMapView**，使地图参与普通 View 合成，避免 GLSurfaceView 的独立 Surface 穿透与滚动黑边（[高德说明](https://a.amap.com/lbs/static/unzip/Android_Map_Doc/3D/com/amap/api/maps/TextureMapView.html)）。没有依赖仅新版本 WebView 才具备的厂商同层接口。

- 复用现有多指触摸桥接，支持拖动、双指缩放及取消；DOM 顶层命中为按钮时由页面处理。
- 页面滚动、嵌套 scroll-view、尺寸改变、祖先 hidden/class/style 改变时同步矩形；用原生 clipBounds 裁剪，保持地图原尺寸，避免滚动时改变相机可视范围。
- 原生 cover-view / cover-image 的层级高于地图，不依赖挂载先后顺序。
- 页面清理时销毁地图；Activity 前后台切换及地图隐藏时同步暂停/恢复。

这条兼容路径有明确限制：**地图及其 DOM 祖先背景必须透明**，否则 WebView 中的不透明背景仍会盖住下方原生地图。应把页面背景设在宿主容器，或放在地图区域之外的兄弟节点。它不等同于任意 CSS 的完整同层合成；旋转/斜切 transform、复杂 mask、圆角祖先裁剪、CSS 动画位移和多个原生组件的任意 CSS stacking context 不在支持范围。升级或更换系统 WebView 后仍需真机验证合成、滚动与触摸；单元测试不能证明 GPU 合成效果。

## iOS

仓库示例 App 不预置高德接入配置。Swift Package 用户在 Xcode 的 **Add Package Dependencies** 中添加主仓库 `https://github.com/didi/dimina.git`，选择包含地图 product 的版本或分支，并链接 `DiminaMapAMap`。它依赖同一个 package 的 `Dimina` 核心 target；只链接核心 product 不会链接高德，但 SwiftPM 解析时仍可能下载二进制 target。

`DiminaMapAMap` product 从 1.7.6 开始提供，1.7.5 及更早的 tag 不包含它；1.7.6 tag 发布前可按包含该改动的分支或 commit 接入。离线接入仍可下载 Release 中的 `DiminaMapAMap-<version>.zip`，解压后使用 **Add Local**。

将 SwiftPM 下载的 `MAMapKit.xcframework/ios-arm64/MAMapKit.framework/AMap.bundle`（或本地包的 `Resources/AMap.bundle`）加入宿主 **Copy Bundle Resources**，因为高德从应用主 bundle 查找地图资源。宿主仍需提供平台 Key 和实际隐私授权状态。不要重复链接另一份高德 Framework。

打包脚本固定 AMap3DMap **11.2.100**、AMapFoundation **1.9.1** 的官方下载及 SHA-256，转换为 XCFramework。官方二进制只含 **arm64 真机和 x86_64 模拟器**；Apple Silicon 上需使用 x86_64/Rosetta 模拟器或真机，不支持 arm64 模拟器。[完整包说明](../iOS/MapAMap/README.md)。

在主线程注册：

```swift
import Dimina
import DiminaMapAMap

DMPMapProviders.register("amap", provider: DiminaMapAMap.DMPAMapProvider(
    apiKey: apiKey,
    hasPrivacyConsent: { privacyConsentGranted }
))
```

定位需在应用 Info.plist 添加 `NSLocationWhenInUseUsageDescription`，说明实际用途。适配器在请求定位时申请前台权限；拒绝或未配置用途说明返回错误。

UIView 在 WKWebView 的原生 overlay 中显示，支持页面滚动及矩形祖先裁剪、区域外触摸穿透。**当前 HTML slot 无法覆盖这层原生地图**；不要把必要的操作按钮放在地图内部，示例操作按钮和说明均在地图外。“点按地图上的标记查看地点”是地图上方的文字提示，实际点击目标是地图标记。此限制与 Android/Harmony 的承载方式不同。

## HarmonyOS NEXT

仓库示例 App 不预置高德接入配置。宿主需自行添加模块依赖、提供平台 Key 和实际的隐私授权状态，并在打开小程序前注册 provider。

可选 HAR 为 `@didi-dimina/map-amap`，依赖固定版本的 Dimina、`@amap/amap_lbs_map3d:11.2.0` 与 `@amap/amap_lbs_common:11.2.0`。适配器发布到 OHPM 后，在宿主模块目录安装与核心一致的版本：

```sh
ohpm install @didi-dimina/map-amap@<与核心一致的版本>
```

仓库源码集成仍可使用本地模块：

```json
{ "dependencies": { "@didi-dimina/map-amap": "file:../map_amap" } }
```

在 UIAbility 初始化后、打开小程序前注册：

```ts
import { DMPMapProviders } from '@didi-dimina/dimina'
import { DMPAMapProvider } from '@didi-dimina/map-amap'

DMPMapProviders.register('amap', new DMPAMapProvider(context, apiKey, () => privacyConsentGranted))
```

`context` 为宿主 UIAbilityContext。宿主声明 `ohos.permission.INTERNET`；定位另需 `ohos.permission.APPROXIMATELY_LOCATION` 和 `ohos.permission.LOCATION`，在 module.json5 中配置真实的 reason 与 usedScene。适配器按需发起运行时授权。

原生地图通过现有 Web native/map embed → DMPNodeController → 高德 MapViewComponent 承载；用唯一 mapViewName 关联 SDK 回调，多个地图不会共用实例。不要使用旧版 Harmony Java SDK 的接入步骤，参考 [HarmonyOS NEXT 地图文档](https://lbs.amap.com/api/harmonyosnext-map3d-sdk/guide/create-map/show-map)。发布元数据已使用正式 Dimina 版本依赖；仓库工程级 `overrides` 将其映射回本地源码，发布时无需手工修改依赖。

同层 `NodeContainer` 使用 embed 的实际尺寸约束内容，px 通过所属 `UIContext` 转成 vp 并保留小数；尺寸状态在创建、更新、销毁时同步，避免整页地图纹理缩放到较小 embed 后变形。高德 `getMapAsync` 完成初始化后通知 ready；地图结果和事件通过 `ContainerToRender` 发给小程序 Render，不能走内嵌 `<web-view>` 的 `subController` 通道。

## Web

### 运行仓库中的 Web 演示

在高德控制台申请 **Web 端（JS API）** 的 Key。`serviceHost` 和 `securityJsCode` 在框架中均为可选项，可同时为空；按 Key 的实际设置选填，服务端要求见[高德说明](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)。原生 SDK 的平台 Key 不用于此处。

复制 `fe/packages/container/.env.example` 为同目录的 `.env.local`，填写：

```dotenv
VITE_AMAP_WEB_KEY=你的Web端Key
VITE_AMAP_PRIVACY_CONSENT=true
```

最后一项表示你同意在本地演示中使用高德地图服务；未同意时保留 false。保存后重启 Web 开发服务，进入“基础组件演示 → Map”。生产部署可改用 `VITE_AMAP_SERVICE_HOST=https://你的域名/_AMapService`，并在服务端配置安全密钥。所有 `VITE_` 变量会进入前端产物，`.env.local` 仅避免误提交，不会把它们变成服务端秘密。

演示入口会将配置安装到每个 pageFrame，缺少 Key 或授权时显示对应原因，不请求地图服务；不会因 `serviceHost` 和 `securityJsCode` 为空阻止加载。演示已提供 `getLocation`：点击“回到我的位置”时按需加载高德定位插件，请求一次定位并转换为 GCJ-02；不使用 IP 城市定位兜底。定位要求浏览器授权及安全上下文（HTTPS 或 localhost），加载插件和定位合计最多等待 10 秒；页面销毁后忽略晚到结果。接口说明见[高德 Web 定位文档](https://lbs.amap.com/api/javascript-api-v2/guide/services/geolocation)。生产宿主应通过自己的授权流程提供 `authorize`，不要照搬本地演示的固定授权开关。

pageFrame 产物也用于原生 SDK，因此演示配置仅在 Web 容器设置 `mapRenderer=web` 后生效，原生端仍使用原生 provider。已有的宿主自定义配置优先。

### 集成自己的 Web 宿主

Web 宿主在**每一个渲染 pageFrame 的 window** 上、创建小程序页面前配置。仅在父窗口或小程序 App() 中设置无效：

```js
window.__DIMINA_MAP_CONFIG__ = {
  provider: 'amap',
  providerOptions: { amap: {
    key: 'YOUR_AMAP_WEB_KEY',
    serviceHost: 'https://your-host.example/_AMapService',
  } },
  authorize: () => hostPrivacy.ensureMapConsent(),
  getLocation: ({ type, signal }) => hostLocation.getLocation({ type, signal }),
  timeout: 15000,
}
```

`hostPrivacy`、`hostLocation` 为宿主自行实现的对象。`authorize` 必须返回或 resolve true，之后才加载 SDK。`getLocation` 必须返回 GCJ-02 坐标；仅 show-location 或无坐标 moveToLocation 时调用。浏览器原始 WGS-84 不能直接当作 GCJ-02 使用。

生产环境按[高德安全密钥说明](https://developer.amap.com/api/javascript-api-v2/guide/abc/jscode) 配置 serviceHost 服务代理；开发环境可传 securityJsCode，但会暴露在客户端。预加载的宿主可传 `providerOptions.amap.AMap` 并自行负责授权前不加载。自动加载器按 document 复用 SDK，拒绝同一 document 内不同 Key/安全配置混用。

Web 自定义 provider 的类型从 `@dimina/components/map-provider` 导入；在配置 `providers` 中注册 `{ create(context) }`，返回 `{ update, invoke, destroy }`。context 包含 element、props、options、signal、emit、getLocation。销毁/中止后不得继续修改地图或发事件，异步创建晚返回的实例会被立即销毁。

移动端默认选择 `native` 传输适配器，无需这段 Web 配置；未注册原生 provider 时明确失败，不自动回退到 JS SDK。Web 容器会标记 mapRenderer=web，避免手机浏览器误走原生桥接。

## 基础能力与差异

兼容目标参考[微信 map 组件](https://developers.weixin.qq.com/miniprogram/dev/component/map.html)。当前支持以下基础子集：

| 能力 | Android 原生 | iOS 原生 | Harmony 原生 | Web |
| --- | --- | --- | --- | --- |
| 中心/缩放/拖动 | 支持 | 支持 | 支持 | 支持 |
| markers 增删改、默认图钉、title/文本气泡 | 支持 | 支持 | 支持 | 支持 |
| 自定义 iconPath | 未实现 | 未实现 | 未实现 | 完整 URL；不解析包内相对路径 |
| polyline / circles / polygons | 基础样式 | 基础样式 | 基础样式 | 基础样式 |
| 定位点/移动到当前位置 | 高德原生定位 | 高德原生定位 | 高德原生定位 | 宿主一次定位 |
| show-scale | 支持 | 支持 | 支持 | 支持 |
| show-compass | 支持 | 支持 | 支持 | 支持 |
| min/max-scale、rotate/skew | 支持 | 支持 | 支持 | 支持，使用 3D 视图 |
| includePoints padding | 最大边距的对称留白 | 四边 | 最大边距的对称留白 | 四边 |

四端高德适配器实现以下 17 个 MapContext 方法。坐标为 GCJ-02，屏幕坐标以地图左上角为原点，单位为 CSS px；桥接层按地图实际尺寸换算原生像素。

| 方法 | 参数 / 结果 |
| --- | --- |
| getCenterLocation / getScale / getRegion | 返回 `{longitude,latitude}` / `{scale}` / `{southwest,northeast}` |
| getRotate / getSkew | 返回 `{rotate}` / `{skew}`，单位为度 |
| toScreenLocation / fromScreenLocation | `{longitude,latitude}` → `{x,y}` / `{x,y}` → `{longitude,latitude}` |
| moveToLocation | 指定经纬度，或通过已授权的定位能力获取当前位置 |
| includePoints | `points`、`padding`；padding 顺序为 `[top,right,bottom,left]` |
| addMarkers / removeMarkers | `markers, clear` / `markerIds` |
| setCenterOffset | `offset: [x,y]`，每项范围为 0.25～0.75，默认 `[0.5,0.5]` |
| setBoundary | `southwest, northeast`，限制可移动范围；不接受跨日界线的边界 |
| translateMarker | `markerId, destination, duration, rotate, autoRotate, moveWithRotate`；支持 `animationEnd` |
| moveAlong | `markerId, path, duration, autoRotate, precision`；path 至少包含两个点 |
| addArc / removeArc | `id, start, end, pass/angle, width, color` / `id` |

动画默认持续 1000ms，0 表示立即到达终点。translateMarker 未设置 moveWithRotate 且未开启 autoRotate 时，旋转和平移分别使用 duration；其他情况同时执行。moveAlong 按各段实际距离分配时间，动画结束后返回 success/complete；translateMarker 在成功结束后额外执行 animationEnd。删除、替换标记、再次移动同一标记、原生页面暂停/卸载或销毁地图会取消旧动画，通过 fail/complete 结束旧调用，不触发 animationEnd。

moveAlong 设置正数 precision 时，按行进距离触发 interpolatepoint，包含 `{markerId,longitude,latitude,animationStatus}`；animationStatus 为 interpolating 或 complete。事件频率受显示帧率限制，不补发同一帧跨过的每一个距离刻度。未设置 precision 时不发送插值事件。

弧线在渲染层按 Mercator 坐标一次采样，四端使用相同路径。非零 angle 优先于 pass；同 ID 替换，独立于 polyline 属性。当前不支持跨日界线的弧线、Mercator 极区或共线的三个点，这些输入通过 fail 返回错误。

动画在各端地图实例内执行，不逐帧跨 Service/Render/Native 桥发送坐标。路径距离在启动时计算，逐帧通过二分查找定位路段。命令队列保持启动顺序，动画期间允许读取、更新和删除标记；超时计入动画时长。每次操作结束即移除取消监听，避免长时间使用地图时积累已经完成的回调。

四端派发 tap、markertap、callouttap、regionchange、rendersuccess、error。regionchange 包含 begin/end、centerLocation、scale；不能识别来源时 causedBy 为 update。Web 另有 updated。标记 id 可省略；显式 id 为唯一整数，建议限定在 32 位范围，支持 0 和负数。无 ID 标记独立保存，不占用数字 ID；点击与气泡事件不返回 markerId。addMarkers 默认替换同 ID 标记、追加无 ID 标记，clear=true 替换全量；修改 markers 属性也替换全量。removeMarkers 仅删除指定的显式 ID，无 ID 标记通过属性全量更新或 clear 清理。Harmony 节点重建保留两类标记。

原生气泡使用 SDK 默认样式，未实现 callout.display 的 ALWAYS、多气泡及富文本。Web InfoWindow 同时显示一个气泡。卫星/路况/室内、POI、聚合、图片覆盖图层、个性化/可视化图层、擦除路线、定位图标设置、调起外部地图、截图与 SelectorQuery.context 获取 MapContext 尚未实现。独立的 getLocation/openLocation/持续定位接口仍需宿主接入，不等同于地图内定位；保留的组件属性声明不代表对应能力已经实现。

## 使用与失败处理

完整示例位于[基础组件演示的地图页](../examples/miniprogram/base/pages/map)，从基础示例首页的 **Map** 入口进入，与其他基础组件共用 appid 和打包流程。示例不含 Key 和厂商依赖。

```xml
<map id="places" longitude="{{longitude}}" latitude="{{latitude}}"
  markers="{{markers}}" binderror="onMapError" />
```

```js
Page({
  data: { longitude: 116.397428, latitude: 39.90923, markers: [] },
  onReady() {
    this.map = wx.createMapContext('places')
    this.map.getCenterLocation({
      success: result => console.log(result.longitude, result.latitude),
      fail: error => console.log(error.errMsg),
    })
  },
  onMapError(event) { console.log(event.detail.errMsg) },
})
```

自定义组件使用 `wx.createMapContext('places', this)`。上下文分别记录通信所用的 `bridgeId` 和查找组件所用的页面/组件实例 `__id__`，两者不能混用。上下文记住创建页和组件归属，跨页后不会误操作新页的同名地图；重复 id、地图不存在或页面已销毁返回失败。

命令在 SDK 初始化后顺序执行。缺少 provider/Key、隐私拒绝、定位拒绝、不支持的方法均有错误；success/fail 后调用 complete，不传回调时返回 Promise。初始化与命令默认 15 秒超时；命令超时会销毁实例，避免晚完成的操作在报告失败后继续修改地图，重试需重建组件。

SDK 隐私授权与系统定位权限分别处理，Key 使用对应平台产品并配置包名/签名或 Bundle ID。隐私拒绝时不初始化 SDK。地图自身的定位能力与独立 `wx.getLocation` 的原生实现分别接入。

## 验证边界

回归覆盖授权前不加载、provider 替换/配置隔离、命令顺序、卸载与超时、页面/组件作用域、错误与回调结算、标记与坐标映射，以及 Android 裁剪与多指转发。Web SDK 测试使用调用记录替身，不访问真实地图服务。

原生编译和这些回归不能证明真实底图、Key 校验、GPU 合成或定位效果。使用合法平台 Key 后仍需分别验收真机：地图/标记、缩放拖动、scroll-view 裁剪、覆盖按钮、多地图、页面重建、前后台、拒绝权限后恢复、弱网/错误 Key、不同系统 WebView 版本。

## 发布可选地图适配器

- Android：根 `jitpack.yml` 显式安装 `engine_qjs`、`dimina`、`map-amap` 的 Maven publication。可用 `./gradlew :map-amap:publishReleasePublicationToMavenLocal` 本地检查 AAR、源码包和 POM。
- iOS：Release 工作流生成本地 Swift Package ZIP 和两个 XCFramework ZIP；主仓库直接提供 `DiminaMapAMap` product，具体步骤见 [Swift Package 发布说明](../iOS/MapAMap/README.md#发布维护)。本地执行 `python3 scripts/package-ios-amap.py --version <核心版本> --output /tmp/dimina-map-release` 仅生成文件，不上传。
- Harmony：`bash harmony/upload.sh --build-only` 构建两个 release HAR；确认发布凭据后，`bash harmony/upload.sh` 依次发布核心和地图适配器。若核心该版本已发布，可单独执行 `ohpm publish harmony/map_amap/build/default/outputs/default/map_amap.har`。

以上配置在新版本实际发布后才形成可用的远程制品；不能将本地构建成功等同于 JitPack/OHPM 已上线。地图 Key、隐私授权和地图功能的真机验证仍由接入流程完成。
