# Dimina iOS SDK

## 系统要求

- iOS 14.0+
- Swift 6.0+
- Xcode 16.0+

## 快速接入

### 步骤 1: 添加 SDK 到项目

您可以通过以下方式将 Dimina SDK 添加到您的 iOS 项目中：

#### Swift Package Manager

在 Xcode 中打开 `dimina.xcodeproj`，选择：

`File > Add Package Dependencies...`

然后填写仓库地址：

```txt
https://github.com/didi/dimina.git
```

版本选择 `Up to Next Major Version`，或按需要固定到具体版本。

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

#### 调试模式与 vConsole

iOS Debug 构建会自动尝试启用 vConsole；也可以通过 `appConfig.isDebugMode = true` 在指定小程序上启用。启用后，SDK 会在加载 pageFrame 时追加 `?vconsole=1`。

JSSDK 直接依赖 vConsole，并随 pageFrame 静态同步打包；只有检测到该启用标记时，pageFrame 才会在 render 初始化前同步初始化 vConsole。


### 关闭小程序

当不再需要小程序时，可以关闭它：

```swift
app.destroy()
```

## 权限处理

小程序可能需要访问设备的各种权限，如相机、位置等。请确保在 Info.plist 中添加相应的权限描述：

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
