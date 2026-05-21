# 小程序包更新说明

本文说明 Dimina 中小程序包的默认更新模型、运行时加载目录，以及接入远程动态下发时需要由宿主完成的工作。

## 默认更新模型

Dimina 默认不内置远程包管理平台。框架采用的是「宿主 App 提供小程序包，SDK 解压或复制到沙盒目录后运行」的模型。

小程序包通过 `config.json` 描述版本信息：

```json5
{
  "appId": "wx92269e3b2f304afc",
  "name": "小程序名称",
  "path": "example/index",
  "versionCode": 1,
  "versionName": "1.0.0"
}
```

其中 `versionCode` 是覆盖安装判断的主要依据。发布新内置包时需要递增 `versionCode`，否则 SDK 会认为本地沙盒包已经是最新版本。

## 内置包加载路径

各端接入文档中的资源目录是内置包来源，不一定是运行时直接读取的位置。当前各端的默认行为如下：

| 平台 | 内置包来源 | 运行时加载位置 |
| ---- | ---------- | -------------- |
| Android | `app/src/main/assets/jsapp/<appId>/<appId>.zip` | `${filesDir}/jsapp/<appId>/` |
| iOS | `Resources/JsApp.bundle/<appId>/<appId>.zip` | `Documents/Dimina/<appId>/` |
| Harmony | `entry/src/main/resources/rawfile/jsapp/<appId>/<appId>.zip` | `${filesDir}/dimina/<appId>/<versionCode>/` |

Android 端 WebView 通过 `https://appassets.androidplatform.net/jsapp/` 映射到 `${filesDir}/jsapp/`。iOS 端会从 `Documents/Dimina/<appId>/main/logic.js`、`Documents/Dimina/<appId>/main/app-config.json` 等位置读取。Harmony 端按 `versionCode` 建立版本目录，并通过当前缓存配置选择正在使用的版本。

因此，内置包随宿主 App 发版更新是默认支持的。宿主升级后，SDK 会比较新包和本地缓存包的 `versionCode`，在新版本更高时覆盖沙盒中的小程序包。

## `wx.getUpdateManager` 的职责

`wx.getUpdateManager()` 提供的是小程序侧感知更新状态和触发重启的 API：

- `onCheckForUpdate(callback)`：宿主检查更新后通知是否存在新版本。
- `onUpdateReady(callback)`：新包已经准备好，可以在业务确认后调用 `applyUpdate()`。
- `onUpdateFailed(callback)`：新包下载、校验或安装失败。
- `applyUpdate()`：通知宿主重启或重载当前小程序，使新的沙盒包生效。

它不负责远程包下载、签名校验、灰度策略、回滚策略和包目录选择。这些能力需要由宿主 App 或业务自建包管理平台实现。

没有远程更新能力时，宿主应通知 `onCheckForUpdate({ hasUpdate: false })`，避免业务侧一直等待更新检查结果。

## 动态下发接入流程

当前 Android / iOS / Harmony SDK 已内置远程自主更新的基础流程。宿主只需要为小程序配置 `updateManifestUrl`，SDK 会在小程序启动后自动拉取 manifest、比较 `versionCode`、下载 zip、校验并安装到沙盒目录，然后通过 `wx.getUpdateManager()` 通知业务代码。

远程 manifest 支持以下格式，也兼容外层包一层 `data` 字段：

```json5
{
  "appId": "wx92269e3b2f304afc",
  "name": "小程序名称",
  "path": "example/index",
  "versionCode": 2,
  "versionName": "1.0.1",
  "packageUrl": "https://example.com/jsapp/wx92269e3b2f304afc-2.zip",
  "sha256": "可选，zip 文件的 SHA-256"
}
```

字段说明：

- `appId` 必须与当前启动的小程序一致。
- `versionCode` 必须大于本地已安装版本才会触发更新。
- `packageUrl` 是小程序 zip 包地址；也兼容字段名 `downloadUrl` 或 `url`。
- `sha256` 可选，配置后 SDK 会校验 zip 内容，不一致则触发 `onUpdateFailed()`。

远程 zip 包需要包含运行时资源目录，至少应包含：

```txt
main/
├── app-config.json
└── logic.js
```

SDK 会根据 manifest 生成沙盒根目录下的 `config.json`。如果 zip 内也包含 `config.json`，会以 manifest 生成的配置为准。

完整流程如下：

1. 拉取远端 manifest，至少包含 `appId`、`versionCode`、`versionName`、下载地址和校验信息。
2. 与本地已安装包的 `versionCode` 比较，只处理更高版本。
3. 下载 zip 到临时目录或 staging 目录。
4. 校验 hash、签名、包大小和 manifest，确认 `appId`、`versionCode` 与当前小程序一致。
5. 解压到 staging 目录，并校验目录结构，至少应包含 `main/app-config.json`、`main/logic.js`，以及实际使用到的分包目录。
6. 原子替换到对应平台的运行时加载目录，或更新平台已有的版本目录和当前版本记录。
7. 通知小程序 `onCheckForUpdate({ hasUpdate: true })`。
8. 包准备完成后通知 `onUpdateReady()`。
9. 业务调用 `updateManager.applyUpdate()` 后，宿主重启或重载当前小程序，加载新版本资源。

如果下载、校验或安装失败，应通知 `onUpdateFailed()`，并保留旧版本包继续运行。

### Android 接入

手动创建 `MiniProgram` 时传入 `updateManifestUrl`：

```kotlin
val miniProgram = MiniProgram(
    appId = "wx92269e3b2f304afc",
    name = "小程序名称",
    path = "example/index",
    versionCode = 1,
    versionName = "1.0.0",
    updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
)
```

如果通过示例工程读取 `config.json` 创建小程序，也可以在内置 `config.json` 中增加可选字段：

```json5
{
  "appId": "wx92269e3b2f304afc",
  "name": "小程序名称",
  "path": "example/index",
  "versionCode": 1,
  "versionName": "1.0.0",
  "updateManifestUrl": "https://example.com/jsapp/wx92269e3b2f304afc.json"
}
```

Android 会将远程包安装到 `${filesDir}/jsapp/<appId>/`。更新准备好后，业务调用 `applyUpdate()` 会销毁当前逻辑引擎并重新启动小程序，从新沙盒包加载。

### iOS 接入

创建 `DMPAppConfig` 时配置 `updateManifestUrl`：

```swift
var appConfig = DMPAppConfig(appName: "小程序名称", appId: "wx92269e3b2f304afc")
appConfig.updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
let app = DMPAppManager.sharedInstance().appWithConfig(appConfig: appConfig)
```

iOS 会将远程包安装到 `Documents/Dimina/<appId>/`。更新准备好后，业务调用 `applyUpdate()` 会重建 service 引擎、重新读取新包配置并 relaunch 到入口页。

### Harmony 接入

创建 `DMPAppConfig` 时配置 `updateManifestUrl`：

```ts
const appConfig = new DMPAppConfig("小程序名称", "wx92269e3b2f304afc")
appConfig.updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
const app = DMPAppManager.sharedInstance().appWithConfig(appConfig)
```

Harmony 会将远程包安装到 `${filesDir}/dimina/<appId>/<versionCode>/`，并更新 `${filesDir}/dimina/<appId>/config.json` 指向新版本。更新准备好后，业务调用 `applyUpdate()` 会走现有 `updateApp()` 重启链路，从新的版本目录加载。

## 写入默认沙盒目录

如需自建更完整的包管理平台，最小改造方式仍然是把远程包解压到框架当前已经读取的沙盒目录：

- Android：`${filesDir}/jsapp/<appId>/`
- iOS：`Documents/Dimina/<appId>/`
- Harmony：`${filesDir}/dimina/<appId>/<versionCode>/`，并同步更新 `<appId>/config.json` 中的当前包配置。

Android 还需要更新本地记录的 `versionCode`，避免后续启动时被旧的内置包逻辑覆盖。iOS 通过沙盒中的 `<appId>/config.json` 与内置包比较版本。Harmony 需要让缓存配置指向新的版本目录。

如果业务不希望覆盖默认沙盒目录，而是希望直接选择某个下载目录运行，则需要额外扩展宿主侧 bundle path 或 bundle resolver 入口，让运行时显式读取业务指定的包路径。

## 小程序侧示例

小程序业务代码可以按微信小程序的常见方式接入：

```js
const updateManager = wx.getUpdateManager()

updateManager.onCheckForUpdate((res) => {
  if (!res.hasUpdate) {
    return
  }
})

updateManager.onUpdateReady(() => {
  wx.showModal({
    title: '更新提示',
    content: '新版本已经准备好，是否重启应用？',
    success(res) {
      if (res.confirm) {
        updateManager.applyUpdate()
      }
    },
  })
})

updateManager.onUpdateFailed(() => {
  wx.showToast({
    title: '更新失败',
    icon: 'none',
  })
})
```

该代码只处理更新状态和用户确认。实际的新包获取、安装和失败回滚仍由宿主侧负责。
