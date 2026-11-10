# 宿主管理小程序版本与胶囊

Android、iOS、Harmony 提供宿主 SDK 接口，供 App 自行下载、安装及选择小程序版本。对应 #336：

| 需求 | Dimina 接口 |
| --- | --- |
| 查询已安装包 | `isExistsApp(appId)` |
| 查询已安装版本 | `getAppVersionInfo(appId)` |
| 从本地包安装 | `installMiniProgram(appId, packagePath)` |
| 配置胶囊显隐 | Android `setShowCapsule`；iOS / Harmony `showCapsule` |

`isExistsApp` 检查磁盘上已展开且包含必要文件的包，不是运行实例是否存在；仅有内置 ZIP、尚未展开时不算已安装。版本查询返回 `config.json` 信息；没有完整包时返回 Android / iOS 的 `null / nil` 或 Harmony 的 `undefined`。appId 必须合法，查询涉及磁盘读取。

## 安装包格式

本地安装接收 **Dimina ZIP**。`packagePath` 是宿主可读的本地文件绝对路径，不是网络地址。

ZIP 根目录至少包含：

```text
config.json
main/app-config.json
main/logic.js
```

页面样式、视图与分包文件也应完整放入 ZIP。`main/` 等文件来自 DMCC 编译产物。版本元信息由宿主打包时放入根目录 `config.json`：

```json
{"appId":"demo","name":"业务页面","path":"pages/index/index","versionCode":1,"versionName":"1.0.0"}
```

安装前校验 appId、非负整数版本号及必要文件，先在临时目录解压，再发布；校验失败保留旧包。支持首次安装、升级、同版本替换和降级，安装器不会主动删除源 ZIP；请将它放在独立的宿主下载目录，不要放入被替换的安装目录。SDK 会写入 `hostManaged: true`，使完整的宿主管理包不被较高版本的内置底包覆盖；文件缺失时仍可触发原有恢复流程。

安装会关闭该 appId 的运行实例并清理旧的待更新包，保留 Storage 和用户文件。安装完成后由宿主显式启动，不自动跳转页面。安装期间不要启动同一小程序；新启动请求会被拒绝。完全由宿主管理版本时，请不要配置 `updateManifestUrl`，避免同时启用远程更新；需要恢复普通底包策略时可先调用 `uninstallMiniProgram`（默认保留用户数据）。

## Android

```kotlin
val sdk = Dimina.init(context, Dimina.DiminaConfig.Builder()
    .setShowCapsule(false)
    .build())

val installed = sdk.isExistsApp("demo")
val version = sdk.getAppVersionInfo("demo")?.optInt("versionCode")
sdk.installMiniProgram("demo", zipFile.absolutePath) { result ->
    result.onSuccess { info ->
        // 安装完成后按宿主需要启动；页面入口可从 info 获取。
    }.onFailure { error ->
        // 展示安装失败并保留旧版本。
    }
}
```

## iOS

```swift
let manager = DMPAppManager.sharedInstance()
manager.showCapsule = false
let installed = manager.isExistsApp(appId: "demo")
let version = try manager.getAppVersionInfo(appId: "demo")?["versionCode"] as? Int
let info = try await manager.installMiniProgram(appId: "demo", packagePath: zipURL.path)
```

安装接口在 MainActor 调用，内部异步完成。启动仍使用 `appWithConfig(...).launch(...)`。

## Harmony

```typescript
const manager = DMPAppManager.sharedInstance()
manager.initialize(uiAbilityContext) // 首次查询或安装前提供宿主 Context
manager.showCapsule = false
const installed = manager.isExistsApp('demo')
const version = manager.getAppVersionInfo('demo')?.versionCode
const info = await manager.installMiniProgram('demo', zipPath)
```

之后仍使用 `appWithConfig(...).startDimina(...)` 启动。

## 胶囊边界

胶囊默认显示。这是 SDK 全局启动配置，应在创建小程序页面前设置，不作为运行中动态显隐 API。隐藏后，使用默认导航栏的栈底页面会显示返回箭头，点击返回宿主（由其他小程序打开时返回上一个小程序）；子页面仍返回上一页。自定义导航栏页面需由宿主或业务提供退出入口，可使用既有 `closeMiniProgram` 或 `hideMiniProgram`。该配置只隐藏胶囊，不隐藏导航栏，不改变页面的系统安全区或 `getMenuButtonBoundingClientRect` 几何结果。

### 胶囊背景色

未显式配置时，胶囊跟随页面的 `navigationBarTextStyle` 和 `wx.setNavigationBarColor`：黑色前景使用白色底色，白色前景使用半透明深色底色。宿主可在首次启动小程序前设置全局胶囊底色，显式设置会覆盖自动底色。下面三种写法都使用约 50% 不透明度的白色。透明度作用于填充色，图标、边框和点击区域保持原有行为。Android 和 iOS 在填充色不透明时保留默认阴影；半透明或全透明时不绘制阴影，避免底色叠加变暗。

- Android 在初始化 SDK 的 `DiminaConfig.Builder` 上调用 `.setCapsuleBackgroundColor(0x80FFFFFF.toInt())`，参数是 ARGB 颜色整数。
- iOS 在主线程设置 `DMPAppManager.sharedInstance().capsuleBackgroundColor = UIColor.white.withAlphaComponent(0.5)`。Objective-C 可在 `DMPObjCManager.shared` 上设置同名属性。
- Harmony 设置 `DMPAppManager.sharedInstance().capsuleBackgroundColor = '#80FFFFFF'`，属性接受 ArkUI 的 `ResourceColor`。

### 胶囊图标颜色

宿主可在首次启动小程序前设置全局 `capsuleIconColor`，同时作用于“更多”的三个圆点和“关闭”的圆环及中心圆点。未显式设置时，图标随页面切换黑白模式，黑色模式使用 `#1F1F1F`，白色模式使用白色；显式设置后保持宿主指定颜色。图标颜色支持透明度，与胶囊背景色独立；边框、分隔线、尺寸和点击区域保持原有行为。透明图标仍可点击，宿主应按背景色选择可辨识的图标颜色。

- Android 在 `DiminaConfig.Builder` 上调用 `.setCapsuleIconColor(0xFFFFFFFF.toInt())`，参数为 ARGB 颜色整数。
- iOS 在主线程设置 `DMPAppManager.sharedInstance().capsuleIconColor = .white`；Objective-C 可通过 `DMPObjCManager.shared.capsuleIconColor` 设置 `UIColor`。
- Harmony 设置 `DMPAppManager.sharedInstance().capsuleIconColor = '#ffffff'`，属性接受 ArkUI 的 `ResourceColor`。

例如，深色胶囊搭配白色图标：

```kotlin
Dimina.init(this, Dimina.DiminaConfig.Builder()
    .setCapsuleBackgroundColor(0xFF17202A.toInt())
    .setCapsuleIconColor(0xFFFFFFFF.toInt())
    .build())
```

```swift
let manager = DMPAppManager.sharedInstance()
manager.capsuleBackgroundColor = UIColor(white: 0.1, alpha: 1)
manager.capsuleIconColor = .white
```

```typescript
const manager = DMPAppManager.sharedInstance()
manager.capsuleBackgroundColor = '#17202a'
manager.capsuleIconColor = '#ffffff'
```

### 默认启动页和 Android 多任务窗口

在首次启动小程序前配置，默认均为 `true`：

```kotlin
Dimina.init(this, Dimina.DiminaConfig.Builder()
    .setEnableMultiTask(false)
    .setShowLaunchLoading(false)
    .build())
```

`setEnableMultiTask(false)` 让 Android 小程序页面进入宿主任务栈，不再创建独立的最近任务卡片。关闭或隐藏小程序时退出其页面，返回宿主或来源小程序；该模式不保留已退出页面，再次进入会重新加载。默认 `true` 保持独立任务及页面保活行为。此配置不限制同时运行的小程序数量；iOS、Harmony 当前直接使用宿主导航容器，没有对应的独立任务卡片配置。

`setShowLaunchLoading(false)` 关闭 SDK 默认的小程序启动遮罩。iOS、Harmony 对应配置如下：

```swift
DMPAppManager.sharedInstance().showLaunchLoading = false
```

```typescript
DMPAppManager.sharedInstance().showLaunchLoading = false
```

启动页开关同时作用于普通页和 tab 页，不影响资源加载、页面 ready、tabBar、胶囊，以及业务主动调用的 `showLoading`。关闭后，内容仍需等待实际加载完成，SDK 不再用默认启动页遮挡加载过程。
