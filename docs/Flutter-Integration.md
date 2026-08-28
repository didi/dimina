# Flutter 宿主接入 Dimina

本文说明如何在现有 Flutter 应用的原生壳中接入 Dimina Android、iOS 和 Harmony SDK。代码片段用于说明宿主需要建立的通道、导航、资源和生命周期契约；可运行实现见 [Flutter 三端接入示例](../examples/flutter/README.md)。

## 接入模型

推荐把 Dimina 作为原生全屏页面启动：

```text
Flutter 页面
  └─ MethodChannel: com.didi.dimina/host
       ├─ Android Activity -> Dimina Android SDK
       ├─ iOS UINavigationController -> Dimina iOS SDK
       └─ Harmony NavPathStack -> Dimina Harmony SDK
```

Dimina 页面由各端原生 SDK 管理，不是 Flutter `PlatformView`。这种方式可以继续使用 SDK 已有的页面栈、胶囊按钮、原生组件、权限请求和 App/Page 生命周期实现。只有业务确实要求把小程序嵌入 Flutter 布局的一部分时，才应另外评估 `PlatformView`；本文不覆盖该模式。

## 支持范围

| 平台 | Flutter 宿主要求 | Dimina 要求 |
| --- | --- | --- |
| Android | Flutter v2 embedding、可取得当前 `Activity` | API 26+、Java 17、ARM64 |
| iOS | Runner 可执行 Swift、可取得当前 `UIViewController` | iOS 14+、Swift 6、Xcode 16+ |
| Harmony | 使用支持 OHOS/Harmony 的 Flutter SDK，并能编写 ArkTS 插件 | HarmonyOS 5.0.0+、API 12 |

Flutter 官方 Add-to-app 文档目前覆盖 Android、iOS、macOS 和 Web；Harmony 端需要使用项目实际选定的 OHOS/Harmony Flutter 发行版。接入前应固定 Flutter SDK、DevEco Studio、Harmony SDK 和 `flutter_ohos` 版本，避免只依赖浮动分支。

- [Flutter Add-to-app](https://docs.flutter.dev/add-to-app)
- [OpenHarmony-SIG Flutter](https://gitee.com/openharmony-sig/flutter_flutter)
- [OpenHarmony Flutter Channel](https://gitee.com/openharmony-sig/flutter_samples/blob/master/ohos/docs/04_development/%E5%A6%82%E4%BD%95%E4%BD%BF%E7%94%A8Flutter%E4%B8%8E%E9%B8%BF%E8%92%99%E9%80%9A%E4%BF%A1%20FlutterChannel.md)

## 统一 Dart 通道

三个原生壳使用同一个通道名和参数结构。初始化在原生应用启动阶段完成，不需要从 Dart 重复调用。

```dart
import 'package:flutter/services.dart';

final class DiminaHost {
  static const MethodChannel _channel = MethodChannel('com.didi.dimina/host');

  static Future<bool> openMiniProgram({
    required String appId,
    required String name,
    required String path,
    required int versionCode,
    required String versionName,
    String? updateManifestUrl,
  }) async {
    return await _channel.invokeMethod<bool>('openMiniProgram', <String, Object?>{
          'appId': appId,
          'name': name,
          'path': path,
          'versionCode': versionCode,
          'versionName': versionName,
          'updateManifestUrl': updateManifestUrl,
        }) ??
        false;
  }

  static Future<bool> closeMiniProgram(String appId) async {
    return await _channel.invokeMethod<bool>('closeMiniProgram', <String, Object?>{
          'appId': appId,
        }) ??
        false;
  }
}
```

参数约定：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `appId` | String | 小程序唯一标识，不能为空 |
| `name` | String | 展示名称 |
| `path` | String | 首次进入页面；iOS/Harmony 通过 launch config 传入 |
| `versionCode` | int | 内置包版本；Android 构造 `MiniProgram` 时使用 |
| `versionName` | String | 展示版本 |
| `updateManifestUrl` | String? | 可选远程更新 manifest |

`openMiniProgram` 的 `true` 表示原生侧已接受启动请求，不等于首屏已经完成渲染。需要“首屏可见”业务信号时，应由小程序通过扩展 Bridge 主动回传，不要用固定延时推测。

## Android

先按 [Android SDK 接入说明](../android/README.md)添加并固定 Dimina 依赖。生产项目不建议使用浮动的 `latest.release`。

### 插件职责

Android 启动入口需要真实 `Activity`，因此承接 MethodChannel 的插件必须实现 `ActivityAware`。`onAttachedToEngine` 只负责 SDK 初始化；当前 Activity 在 `onAttachedToActivity` 和配置变更回调中维护。

```kotlin
class DiminaFlutterPlugin :
    FlutterPlugin,
    MethodCallHandler,
    ActivityAware {

    private lateinit var channel: MethodChannel
    private var activity: Activity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        Dimina.init(
            binding.applicationContext,
            Dimina.DiminaConfig.Builder()
                .setDebugMode(BuildConfig.DEBUG)
                .build(),
        )
        channel = MethodChannel(binding.binaryMessenger, "com.didi.dimina/host")
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val args = call.arguments as? Map<*, *> ?: emptyMap<String, Any?>()
        when (call.method) {
            "openMiniProgram" -> {
                val host = activity
                if (host == null) {
                    result.error("NO_ACTIVITY", "Flutter Activity is not attached", null)
                    return
                }
                try {
                    val appId = args["appId"] as String
                    val miniProgram = MiniProgram(
                        appId = appId,
                        name = args["name"] as String,
                        path = args["path"] as String,
                        versionCode = (args["versionCode"] as Number).toInt(),
                        versionName = args["versionName"] as String,
                        updateManifestUrl = args["updateManifestUrl"] as? String ?: "",
                    )
                    Dimina.getInstance().startMiniProgram(host, miniProgram)
                    result.success(true)
                } catch (error: Throwable) {
                    result.error("OPEN_FAILED", error.message, null)
                }
            }

            "closeMiniProgram" -> {
                val appId = args["appId"] as? String
                result.success(
                    appId != null && Dimina.getInstance().closeMiniProgram(appId),
                )
            }

            else -> result.notImplemented()
        }
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel.setMethodCallHandler(null)
    }
}
```

需要的主要 import：

```kotlin
import android.app.Activity
import com.didi.dimina.Dimina
import com.didi.dimina.bean.MiniProgram
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
```

不要在 `onDetachedFromActivityForConfigChanges()` 中关闭小程序；该回调也会在旋转、窗口重建等配置变化时发生，不代表用户退出。

## iOS

先按 [iOS SDK 接入说明](../iOS/README.md)通过 Swift Package Manager 引入 Dimina。Flutter 宿主不能照搬原生示例里替换 `window.rootViewController` 的做法；应该从当前 Flutter 控制器 present 一个由 Dimina 独占的 `UINavigationController`。

### 宿主适配器

宿主需要按 `appId` 强持有 `DMPApp`，关闭后再移除引用：

```swift
import Dimina
import Flutter
import UIKit

@MainActor
final class DiminaFlutterHost {
    private var apps: [String: DMPApp] = [:]

    func open(arguments: [String: Any], from presenter: UIViewController) async throws -> Bool {
        guard let appId = arguments["appId"] as? String,
              let name = arguments["name"] as? String else {
            return false
        }

        let navigationController = UINavigationController()
        await withCheckedContinuation { continuation in
            presenter.present(navigationController, animated: true) {
                continuation.resume()
            }
        }

        var config = DMPAppConfig(appName: name, appId: appId)
        config.isDebugMode = _isDebugAssertConfiguration()
        config.updateManifestUrl = arguments["updateManifestUrl"] as? String

        let app = DMPAppManager.sharedInstance().appWithConfig(appConfig: config)
        app.getNavigator()?.setup(navigationController: navigationController)
        apps[appId] = app

        var launch = DMPLaunchConfig()
        launch.openType = .navigateTo
        launch.appEntryPath = arguments["path"] as? String
        await app.launch(launchConfig: launch)
        return true
    }

    func close(appId: String) async throws -> Bool {
        guard let app = apps[appId] else { return false }
        try await app.closeMiniProgram()
        apps.removeValue(forKey: appId)
        return true
    }
}
```

`DMPApp.closeMiniProgram()` 会先走导航和 App/Page 隐藏链路，再销毁运行时；不要用 `app.destroy()` 代替可见小程序的正常关闭。

### Channel 回调

在 `AppDelegate` 或自有 Flutter plugin 中注册通道。所有 UIKit 和 Dimina 调用都留在 `MainActor`：

```swift
let channel = FlutterMethodChannel(
    name: "com.didi.dimina/host",
    binaryMessenger: flutterViewController.binaryMessenger
)
let diminaHost = DiminaFlutterHost()

channel.setMethodCallHandler { call, result in
    let arguments = call.arguments as? [String: Any] ?? [:]
    Task { @MainActor in
        do {
            switch call.method {
            case "openMiniProgram":
                result(try await diminaHost.open(
                    arguments: arguments,
                    from: flutterViewController
                ))
            case "closeMiniProgram":
                let appId = arguments["appId"] as? String ?? ""
                result(try await diminaHost.close(appId: appId))
            default:
                result(FlutterMethodNotImplemented)
            }
        } catch {
            result(FlutterError(
                code: "DIMINA_FAILED",
                message: error.localizedDescription,
                details: nil
            ))
        }
    }
}
```

如果 Runner 外层还有 `UINavigationController`、登录页或其他 modal，请把实际可见的 presenter 传给适配器，不能固定假设 `window.rootViewController` 就是 `FlutterViewController`。

## Harmony

先按 [Harmony SDK 接入说明](../harmony/dimina/README.md)安装 HAR。Harmony 的 Flutter 发行版与插件 API 可能随所选分支变化，下列代码使用 OpenHarmony-SIG 文档中的 `FlutterPluginBinding`、`MethodChannel`、`MethodCall` 和 `MethodResult` 结构。

### EntryAbility 初始化

Dimina 必须获得真实 `UIAbilityContext` 和 `WindowStage`：

```ts
const dmpConfig: DMPEntryContext = {
  getContext: (): common.UIAbilityContext => this.context,
  getWindowStage: (): window.WindowStage => windowStage
}
DMPApp.init(dmpConfig)
```

### 合并 ArkUI Navigation

Dimina 页面依赖宿主 `NavPathStack`。Flutter 页面所在的 ArkUI 宿主必须保留一个可供通道适配器使用的 `pageInfos`，并把 Dimina 的两个目标合并到现有 `routerFactory`：

```ts
Navigation(this.pageInfos) {
  // FlutterPage 或宿主自己的页面
}
.navDestination(this.routerFactory)

@Builder
routerFactory(name: string, paramMap: Map<string, Object>) {
  if (name === DMPPage.ROUTE_NAME) {
    DMPPage({ uri: name, param: paramMap })
  } else if (name === DMPPhotoPreview.ROUTE_NAME) {
    DMPPhotoPreview({ uri: name, param: paramMap })
  } else {
    // 宿主已有路由
  }
}
```

### 宿主适配器

```ts
export class DiminaFlutterHost {
  private readonly apps = new Map<string, DMPApp>()

  constructor(
    private readonly context: common.UIAbilityContext,
    private readonly pageInfos: NavPathStack
  ) {}

  async open(arguments: Map<string, Object>): Promise<boolean> {
    const appId = arguments.get('appId') as string
    const name = arguments.get('name') as string
    const config = new DMPAppConfig(name, appId)
    config.updateManifestUrl = arguments.get('updateManifestUrl') as string | undefined

    const app = DMPAppManager.sharedInstance().appWithConfig(config)
    app.router.init(this.pageInfos)

    const launch = new DMPLaunchConfig()
    launch.openType = DMPOpenType.NavigateTo
    launch.appEntryPath = arguments.get('path') as string
    const accepted = new Promise<boolean>((resolve: (success: boolean) => void) => {
      launch.completion = (success: boolean): void => resolve(success)
    })

    await app.startPackageLoader(this.context, launch)
    app.launch(launch)
    this.apps.set(appId, app)
    return accepted
  }

  async close(appId: string): Promise<boolean> {
    const app = this.apps.get(appId)
    if (!app) return false
    await app.closeMiniProgram()
    this.apps.delete(appId)
    return true
  }
}
```

在 Flutter OHOS 插件的 `onAttachedToEngine` 中创建同名通道，并把 `openMiniProgram`、`closeMiniProgram` 转交给上面的宿主适配器：

```ts
this.channel = new MethodChannel(
  binding.getBinaryMessenger(),
  'com.didi.dimina/host'
)
this.channel.setMethodCallHandler({
  onMethodCall: (call: MethodCall, result: MethodResult): void => {
    // 参数由所用 Flutter OHOS codec 转换为 Map 后，调用 host.open / host.close。
  }
})
```

MethodChannel 插件本身拿不到 ArkUI 组件的 `NavPathStack` 时，应由页面创建 `DiminaFlutterHost` 后注入插件或放入明确的宿主状态容器；不要在插件里再创建一套独立 `Navigation`。

## 小程序资源打包

建议在 Flutter 仓库中维护一份编译产物源目录，在三个原生构建阶段复制，而不是把压缩包只声明为 Flutter assets。目标路径必须分别满足：

| 平台 | 最终包内路径 |
| --- | --- |
| Android | `android/app/src/main/assets/jsapp/<appId>/` |
| iOS | Runner target 中的 `JsApp.bundle/<appId>/` |
| Harmony | `entry/src/main/resources/rawfile/jsapp/<appId>/` |

每个 `<appId>` 目录包含：

```text
<appId>/
├── config.json
└── <appId>.zip
```

`config.json` 至少包含 `appId`、`name`、`path`、`versionCode` 和 `versionName`。三端必须复制同一版 zip 和配置；不要让 Android、iOS、Harmony 分别维护版本号。

iOS 的 `JsApp.bundle` 必须加入 Runner target 的 Copy Bundle Resources。SDK 会先查自身 Swift Package 资源，再回退到 `Bundle.main` 中的 `JsApp.bundle`，因此宿主内置包可以放在 Runner 主 bundle。

## 生命周期责任边界

- 不要把 Flutter `AppLifecycleState` 手工转发成小程序 `App.onShow/onHide`。Android Activity、iOS UIApplication 通知和 Harmony WindowStage 已由原生 SDK 统一记账，重复转发会产生双回调。
- Flutter 路由暂时被覆盖、系统权限框弹出、Activity 配置变化都不等于关闭小程序。
- 用户明确关闭时调用 `closeMiniProgram`。该入口会走 Page 隐藏、App 隐藏和运行时回收；退出整个小程序不会额外发送 `Page.onUnload`。
- MethodChannel detach 只释放通道和宿主引用，不应顺带销毁仍在运行的 Dimina 实例。
- iOS/Harmony 适配器必须强持有 `DMPApp`；正常关闭完成后删除引用。Android 运行实例由 SDK 按 `appId` 管理。
- 同一 `appId` 的 open/close 应在宿主侧串行处理。关闭尚未完成时不要立即创建第二个同 `appId` 实例。

## 接入验收

至少验证以下路径：

1. 冷启动 Flutter 应用后首次打开小程序。
2. 关闭小程序后返回原 Flutter 页面，再次打开同一 `appId`。
3. 小程序位于第二页时切后台、回前台，只有当前页收到 Page 生命周期。
4. 系统权限框、分享面板和 Android 配置变化不会误判为小程序退出。
5. Flutter 主动调用 `closeMiniProgram` 时，Page.onHide 先于 App.onHide，且不产生 Page.onUnload。
6. 三端内置包版本一致，远程更新失败时仍能回退到可运行版本。
7. 相机、定位、蓝牙、局域网等能力所需权限已经写入各端原生配置。

构建成功只能证明原生依赖和代码能够链接；真机权限、返回动画、生命周期顺序和资源更新仍需分别验证。
