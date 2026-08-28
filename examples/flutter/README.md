# Dimina Flutter 接入示例

该工程展示 Flutter 宿主如何通过统一 `MethodChannel` 接入仓库内的 Dimina Android、iOS 和 Harmony SDK。它使用原生全屏容器，不使用 `PlatformView`。

## 工程关系

- Dart 通道：`lib/dimina_host.dart`
- Android 宿主：`android/app/src/main/kotlin/.../MainActivity.kt`
- iOS 宿主：`ios/Runner/AppDelegate.swift`
- Harmony 宿主：`ohos/entry/src/main/ets/`
- 示例小程序：仓库根目录 `shared/jsapp/`

Android、iOS 和 Harmony 均通过相对路径依赖当前仓库源码，适合验证正在开发的 SDK。复制到独立业务仓库时，请按各端 README 换成固定版本依赖，并把小程序资源放入业务工程对应目录。

## 应用图标

源图位于 `assets/app_icon.png`；如需重新生成各端尺寸，请在 macOS 仓库根目录执行：

```bash
swift examples/flutter/tool/generate_app_icons.swift
```

## Android

要求 Flutter 3.47.1+、Java 17、Android API 26+ 和 ARM64 设备：

```bash
cd examples/flutter
flutter pub get
flutter run -d <android-device-id>
```

Gradle 将仓库的 `shared/` 作为只读 assets 根目录，因此小程序保持在 `jsapp/<appId>/`，并通过 composite build 使用 `android/dimina`。

## iOS

Dimina SDK 支持 iOS 14+；当前 Flutter 3.47 模板的 Runner 部署目标是 iOS 15，并要求 Swift 6/Xcode 16+ 工具链：

```bash
cd examples/flutter
flutter pub get
flutter run -d <ios-device-or-simulator-id>
```

Runner 通过本地 Swift Package 引用仓库根目录。包内已携带 `JsApp.bundle`；真机运行前需要在 Xcode 配置业务团队签名。示例 `Info.plist` 提供了常用能力的权限文案，生产应用应按实际使用范围删减并本地化。

## Harmony

Harmony 端必须使用支持 OHOS/Harmony 的 Flutter SDK；标准 Flutter stable 不会生成 `flutter.har`：

```bash
# 先把 PATH 切换到 OpenHarmony-SIG/Harmony Flutter SDK
cd examples/flutter
flutter pub get
flutter run -d <harmony-device-id>
```

OHOS Flutter 工具会生成 `ohos/har/flutter.har`、Flutter assets 和插件注册文件。示例的 ArkTS 工程通过本地 ohpm 依赖使用 `harmony/dimina`，Hvigor 构建时从 `shared/jsapp` 同步小程序包。首次运行前还需在 DevEco Studio 配置签名。

## 验收路径

1. 打开默认 `wx92269e3b2f304afc`。
2. 从小程序胶囊关闭并返回 Flutter 页面。
3. 再次打开，然后使用 Flutter 页的“关闭小程序”按钮验证宿主主动关闭。
4. 切换前后台，确认 Flutter 没有重复转发 App/Page 生命周期。

更完整的资源、生命周期和生产接入边界见 [`../../docs/Flutter-Integration.md`](../../docs/Flutter-Integration.md)。
