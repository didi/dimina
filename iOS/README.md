# Dimina iOS SDK

## 系统要求

- iOS 14.0+
- Xcode 16.0+（Swift 6 工具链）

SDK 的 `Package.swift` 使用 Swift tools 6.0，但源码当前以 Swift 5 language mode 编译。宿主不需要开启 Swift 6 严格并发模式。

## 快速接入

### 步骤 1: 添加 SDK 到项目

通过 Swift Package Manager 将 Dimina SDK 添加到 iOS 项目：

#### Swift Package Manager

在宿主应用的 Xcode 工程中选择：

`File > Add Package Dependencies...`

然后填写仓库地址：

```txt
https://github.com/didi/dimina.git
```

版本可固定为当前已发布版本；如果选择 `Up to Next Major Version`，发布前仍应检查实际解析到的版本。

#### 依赖安装失败排查

如果 Xcode 提示 `no versions of 'dimina' match the requirement`，先核对版本标签和工具链。这个错误发生在依赖解析阶段，尚未编译 SDK 源码。

以 `1.7.7` 为例，Xcode 的 **Exact Version** 填写 `1.7.7`，对应的 Git 标签是 `v1.7.7`。在终端检查远端是否提供该标签：

```bash
git ls-remote --tags https://github.com/didi/dimina.git 'refs/tags/v1.7.7' 'refs/tags/v1.7.7^{}'
xcodebuild -version
xcrun swift --version
```

- 如果查询失败，先检查 GitHub 网络连接或 Git 代理配置；如果查询成功但没有输出，所选版本尚未提供对应标签。
- 确认实际使用的是 Xcode 16.0+。终端的工具链可能与打开工程的 Xcode 不同；同时检查 **Xcode > About Xcode**。将宿主的 Swift language mode 改为 Swift 5，不能替代 SDK 要求的 Swift 6 工具链。
- 标签存在且 Xcode 版本满足要求时，取消添加窗口，执行 **File > Packages > Reset Package Caches**，重新添加依赖并执行 **Resolve Package Versions**，让 Xcode 重新读取远端标签。

若仍失败，在宿主工程目录执行依赖解析并保留完整日志，将下面的 `Host` 替换为实际工程名和 scheme；使用 workspace 的工程将 `-project Host.xcodeproj` 替换为 `-workspace Host.xcworkspace`：

```bash
xcodebuild -resolvePackageDependencies -project Host.xcodeproj -scheme Host
```

根据日志区分标签不可用、工具链不兼容、源码依赖冲突和二进制下载失败。只选择核心 `Dimina` product 时，SwiftPM 仍可能下载同包内的高德 XCFramework；这类下载错误需要检查 Release 附件的访问情况。

### 步骤 2: 准备小程序资源

将编译好的小程序压缩包放入 `iOS/dimina/Resources/JsApp.bundle` 文件夹，文件夹以小程序 ID 命名。示例工程可通过 `copy-shared-resources.sh` 从根目录 `shared/jsapp` 同步资源。每个小程序文件夹需包含以下内容：

1. `config.json` - 小程序配置文件，包含以下字段：

```json5
{
  "appId": "wx92269e3b2f304afc", // 小程序唯一标识
  "name": "小程序名称",
  "path": "example/index", // 小程序入口路径
  "versionCode": 1, // 启动小程序时会根据版本号确认是否需要更新
  "versionName": "1.0.0"
}
```

2. `[appId].zip` - 小程序代码包，文件名需与 appId 一致

目录结构示例：

```txt
JsApp.bundle/
  ├── wx92269e3b2f304afc/
  │   ├── config.json
  │   └── wx92269e3b2f304afc.zip
  └── wxbaf4b47de04f1d8a/
      ├── config.json
      └── wxbaf4b47de04f1d8a.zip
```

内置包会在启动时按 `versionCode` 复制或解压到应用沙盒目录后运行。动态下发、远程下载和 `wx.getUpdateManager` 的职责边界请参考[小程序包更新说明](../docs/MiniProgram-Update.md)。

### 步骤 3: 启动小程序

```swift
import Dimina
import SwiftUI

struct ContentView: View {
    var body: some View {
        Button("启动小程序") {
            launchMiniProgram()
        }
    }

    func launchMiniProgram() {
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
            let window = windowScene.windows.first
        {
            let navController = UINavigationController()

            // 创建一个新的 ContentView 作为根视图，可以自行替换
            let contentView = ContentView()
            let hostingController = UIHostingController(rootView: contentView)
            
            hostingController.navigationItem.title = "星河小程序"

            // 设置为根视图
            navController.viewControllers = [hostingController]
            window.rootViewController = navController

            // 创建小程序配置和实例
            let manager: DMPAppManager = DMPAppManager.sharedInstance()
            var appConfig: DMPAppConfig = DMPAppConfig(appName: "小程序名称", appId: "wx92269e3b2f304afc")
            appConfig.isDebugMode = true
            appConfig.updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json" // 可选：远程更新 manifest
            let app: DMPApp = manager.appWithConfig(appConfig: appConfig)

            // 设置导航
            app.getNavigator()!.setup(navigationController: navController)

            // 启动小程序
            Task { @MainActor in
                let launchConfig: DMPLaunchConfig = DMPLaunchConfig()
                await app.launch(launchConfig: launchConfig)
            }
        }
    }
}
```

卸载已安装包时，默认保留小程序 Storage 和持久文件；传入 `clearUserData: true` 才会一并清除：

```swift
try await DMPAppManager.sharedInstance().uninstallMiniProgram(
    appId: "wx92269e3b2f304afc"
)
```

并发更新、待更新包清理和各端完整行为见[小程序包更新说明](../docs/MiniProgram-Update.md)。

#### 调试模式与 vConsole

iOS Debug 构建会自动尝试启用 vConsole；也可以通过 `appConfig.isDebugMode = true` 在指定小程序上启用。启用后，SDK 会在加载 pageFrame 时追加 `?vconsole=1`。

JSSDK 直接依赖 vConsole，并随 pageFrame 静态同步打包；只有检测到该启用标记时，pageFrame 才会在 render 初始化前同步初始化 vConsole。

启用后，逻辑线程的 `console.log/info/warn/error/debug` 和 `wx.request` 请求记录会转发到 vConsole。`MiniProgram Storage` 是当前小程序 MMKV 缓存的编辑面板，通过原生 MMKV 快照读取，普通与加密存储用 `encrypted` 字段区分，支持以 JSON 新增、编辑值和确认删除，操作立即生效并重新读取 MMKV；也可点击 Refresh 手动刷新；vConsole 自带的 Storage 页仍显示 WebView 存储。未开启调试时不采集这些数据，目前不包含上传、下载和 WebSocket 流量。


### 关闭小程序

当不再需要小程序时，可以关闭它：

```swift
try await app.closeMiniProgram()

// MainActor 上销毁全部小程序实例，保留持久化数据
try await DMPAppManager.sharedInstance().destroyAllMiniPrograms()
```

`closeMiniProgram()` 会先完成页面退出、App/Page 隐藏和可能存在的来源小程序恢复，再销毁运行时。`destroy()` 是底层资源回收入口，不应代替可见小程序的正常关闭。

## Objective-C 工程接入

OC 工程也通过上面的 Swift Package Manager 步骤添加 **Dimina** product，不需要把宿主迁移为 Swift。以下 `DMPObjC*` 接口需使用包含本次适配的源码版本；旧版本没有这些类。

在 `.m` 文件导入 SwiftPM 生成的模块（`Enable Modules (C and Objective-C)` 设为 `YES`，不需要宿主 Bridging Header）：

```objc
@import Dimina;
```

在主线程创建实例，并接入宿主现有的 `UINavigationController`：

```objc
DMPObjCManager *manager = DMPObjCManager.shared;
[manager setupWithApiNamespaces:@[]];
DMPObjCAppConfig *config = [[DMPObjCAppConfig alloc]
    initWithAppName:@"小程序名称" appId:@"wx92269e3b2f304afc"];
config.isDebugMode = YES; // 按需开启，线上通常关闭
// 没有内置包时，设置真实的远程 manifest 地址：
// config.updateManifestUrl = @"https://your-server/jsapp/wx92269e3b2f304afc.json";
DMPObjCApp *app = [manager appWithConfig:config];
[app setupWithNavigationController:self.navigationController];

DMPObjCLaunchConfig *launch = [DMPObjCLaunchConfig new];
launch.query = @{ @"from": @"objc-host" };
launch.launchAnimated = @YES;
[app launchWithConfig:launch completion:^(BOOL launched) {
    if (!launched) {
        NSLog(@"小程序启动失败或有操作正在进行");
    }
}];
```

- 宿主需持有 `DMPObjCApp`，后续可调用 `hideWithCompletion:` 保留后台实例、`closeWithCompletion:` 正常退出并销毁，或 `[manager destroyAllMiniProgramsWithCompletion:...]` 销毁全部实例。这些关闭接口的回调参数是 `NSError *`，成功为 `nil`，不会清除持久化用户数据。
- 管理器和实例接口在主线程调用，异步完成回调也在主线程执行一次。启动返回 `YES` 表示原生启动路径成功，不代表 JS 页面已触发 `onReady`。
- `appEntryPath`、`query`、`scene`、`referrerInfo` 等启动字段与 Swift 版本一致。可选布尔值使用 `NSNumber *`，`nil` 保留 SDK 默认值，显式关闭应传 `@NO`。启动配置在调用时复制，之后修改不会影响本次启动。
- 首次启动前设置导航容器；同一实例再次进入时直接调用 `launchWithConfig:completion:`，避免重复重设导航栈。
- 资源格式与 Swift 接入相同。使用远程 SPM 依赖时，可配置 `updateManifestUrl` 下载首包；内置包方式需随本地 SDK 的 `Resources/JsApp.bundle` 打包。当前 SPM 优先读取 SDK 自身的资源 bundle，不能仅把业务包放到宿主 bundle 并假定会覆盖它。

可复制的完整控制器示例：[DMPExampleViewController.h](Examples/ObjectiveC/DMPExampleViewController.h)、[DMPExampleViewController.m](Examples/ObjectiveC/DMPExampleViewController.m)。把它们加入链接了 Dimina product 的 OC target，将控制器放入宿主导航栈，再从按钮调用 `openMiniProgram`。示例中的 appId 和资源/manifest 需替换成实际小程序。

可在仓库根目录运行 `bash iOS/Examples/ObjectiveC/verify.sh`，构建真实 SwiftPM SDK 并编译 arm64/x86_64 模拟器 OC 示例；这项检查不包含启动运行或真机验证。

此适配覆盖宿主启动与实例生命周期；Swift 扩展模块、地图 provider 等协议暂未通过此 OC facade 导出。

## 权限处理

如果小程序会使用相机、位置等系统能力，需要在 `Info.plist` 中添加对应的权限说明：

```xml
<key>NSCameraUsageDescription</key>
<string>小程序需要使用您的相机</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>小程序需要使用您的位置信息</string>
```


## 示例项目

运行命令：
```bash
open iOS/dimina.xcodeproj
```

使用 Xcode 打开 `dimina.xcodeproj` 可以查看示例项目。示例工程构建前会执行 `copy-shared-resources.sh`，将根目录 `shared/jsapp` 和 `shared/jssdk` 中的资源同步到 `iOS/dimina/Resources`。
