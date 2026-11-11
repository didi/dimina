# 小程序包更新说明

[文档中心](./README.md) · [架构图](./Architecture-Diagram.md) · [能力参考](./API-Reference.md)

本文说明 Dimina 中小程序包的默认更新模型、运行时加载目录，以及接入远程动态下发时需要由宿主完成的工作。

## 平台支持

| 能力 | Android | iOS | Harmony | Web |
| --- | --- | --- | --- | --- |
| 随宿主发布内置包 | 支持 | 支持 | 支持 | 使用静态资源部署 |
| 无底包时根据 ManifestUrl 首次安装 | 支持 | 支持 | 支持 | 支持远程静态目录 |
| `updateManifestUrl` 远程更新 | 支持 | 支持 | 支持 | 暂未提供 |
| `wx.getUpdateManager()` | 支持 | 支持 | 支持 | 支持，默认返回无更新 |
| 宿主卸载已安装包 | 支持 | 支持 | 支持 | 由站点部署管理 |

Android、iOS 与 Harmony 会下载 manifest 中的 zip 并安装到沙盒。Web 不解压 native zip，而是根据 manifest 直接加载已部署的编译产物目录；Web 的资源版本仍由站点部署和缓存策略管理。

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

Harmony 在每次准备启动包时分别比较内置小程序包和 JSSDK 的资源版本，不依赖宿主应用的 `versionCode` 是否变化。资源版本相同或更低时沿用缓存，不重复解压；更高版本的远程缓存不会被旧底包覆盖。由宿主接管的小程序包仍以宿主管理结果为准。该检查在启动包准备阶段执行，已保留的运行实例需要销毁后重新启动，才会重新准备资源。

## `wx.getUpdateManager` 的职责

`wx.getUpdateManager()` 提供的是小程序侧感知更新状态和触发重启的 API：

- `onCheckForUpdate(callback)`：宿主检查更新后通知是否存在新版本。
- `onUpdateReady(callback)`：新包已经准备好，可以在业务确认后调用 `applyUpdate()`。
- `onUpdateFailed(callback)`：新包下载、校验或安装失败。
- `applyUpdate()`：激活已经准备好的新包，再由宿主重启或重载当前小程序。

小程序侧 API 本身不执行远程包下载、签名校验、灰度策略、回滚策略和包目录选择。配置 `updateManifestUrl` 后，三端 SDK 的内置更新器会负责基础下载、哈希校验和待更新包管理；签名、灰度、回滚等生产策略仍需要由宿主 App 或业务包管理平台实现。

没有远程更新能力时，宿主应通知 `onCheckForUpdate({ hasUpdate: false })`，避免业务侧一直等待更新检查结果。

## 动态下发接入流程

当前 Android / iOS / Harmony SDK 已内置远程自主更新的基础流程。宿主只需要为小程序配置 `updateManifestUrl`，SDK 会在小程序启动后自动拉取 manifest、比较 `versionCode`、下载 zip、校验并安装到沙盒目录，然后通过 `wx.getUpdateManager()` 通知业务代码。

同一个配置也支持无底包首次安装。启动时如果找不到可运行的 `main/app-config.json` 和 `main/logic.js`，SDK 会在初始化 service/render 之前拉取 manifest、校验 `appId`、下载并直接激活远程包，再继续正常启动。已有本地包时仍保持原来的快速启动和后台更新检查，不会阻塞启动。

首次安装是建立本地基线，不会发送 `onUpdateReady()`；安装失败会终止本次启动，也不会伪装成“无更新”。宿主可以在网络恢复后重试启动。

远程 manifest 支持以下格式，也兼容外层包一层 `data` 字段：

```json5
{
  "appId": "wx92269e3b2f304afc",
  "name": "小程序名称",
  "path": "example/index",
  "versionCode": 2,
  "versionName": "1.0.1",
  "packageUrl": "https://example.com/jsapp/wx92269e3b2f304afc-2.zip",
  "sha256": "可选，zip 文件的 SHA-256",
  "webBaseUrl": "https://example.com/web-apps/"
}
```

字段说明：

- `appId` 必须与当前启动的小程序一致。
- 已有本地包时，`versionCode` 必须大于当前版本才会触发更新；首次安装直接以 manifest 版本建立基线。
- `packageUrl` 是小程序 zip 包地址；也兼容字段名 `downloadUrl` 或 `url`。
- `sha256` 可选，配置后 SDK 会校验 zip 内容；普通更新不一致会触发 `onUpdateFailed()`，首次安装则终止启动。
- `webBaseUrl` 仅供 Web 使用，表示包含 `<appId>/` 目录的静态资源根地址；省略时使用 manifest 所在目录。

当前内置更新器会校验 HTTP 响应、`appId`、`versionCode`、可选 SHA-256，以及资源包中的必需文件。它不内置包签名、证书链、灰度发布、下载大小上限或服务端回滚策略；生产环境需要由宿主或发布平台补齐这些策略。

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
4. 确认 manifest 的 `appId` 与当前小程序一致；配置了 `sha256` 时校验 zip 内容。
5. 解压到 staging 目录，并校验目录结构，至少应包含 `main/app-config.json`、`main/logic.js`，以及实际使用到的分包目录。
6. 将通过校验的新包写入待更新目录；首次安装时直接建立当前版本。
7. 通知小程序 `onCheckForUpdate({ hasUpdate: true })`。
8. 包准备完成后通知 `onUpdateReady()`。
9. 业务调用 `updateManager.applyUpdate()` 后，SDK 原子切换当前版本，宿主重启或重载当前小程序并加载新资源。未调用前，正在运行及下次普通启动仍使用旧版本。

如果已经发现更高版本，但下载、校验或安装失败，内置更新器会通知 `onUpdateFailed()`，并继续保留旧版本包。manifest 拉取或解析在确认新版本之前失败时，当前实现按“无可用更新”处理，不会进入更新失败回调。

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

无底包时只需要保留宿主已知的 `appId`，名称、入口和版本由 manifest/编译产物提供：

```kotlin
val miniProgram = MiniProgram(
    appId = "wx92269e3b2f304afc",
    path = null,
    updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
)
Dimina.getInstance().startMiniProgram(activity, miniProgram)
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

Android 会将远程包准备到 `${filesDir}/jsapp/.pending/<appId>/`。更新准备好后，业务调用 `applyUpdate()` 才会原子替换 `${filesDir}/jsapp/<appId>/`，随后销毁当前逻辑引擎并重新启动小程序。

### iOS 接入

创建 `DMPAppConfig` 时配置 `updateManifestUrl`：

```swift
var appConfig = DMPAppConfig(appName: "小程序名称", appId: "wx92269e3b2f304afc")
appConfig.updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
let app = DMPAppManager.sharedInstance().appWithConfig(appConfig: appConfig)
```

iOS 会将远程包准备到 `Documents/Dimina/.pending/<appId>/`。即使 `JsApp.bundle` 中没有该 `appId`，首次 `launch` 也会先完成 manifest 安装。更新准备好后，业务调用 `applyUpdate()` 才会原子替换 `Documents/Dimina/<appId>/`，重建 service 引擎、重新读取新包配置并 relaunch 到入口页。

### Harmony 接入

创建 `DMPAppConfig` 时配置 `updateManifestUrl`：

```ts
const appConfig = new DMPAppConfig("小程序名称", "wx92269e3b2f304afc")
appConfig.updateManifestUrl = "https://example.com/jsapp/wx92269e3b2f304afc.json"
const app = DMPAppManager.sharedInstance().appWithConfig(appConfig)
```

Harmony 会将远程包解压到 `${filesDir}/dimina/<appId>/<versionCode>/`，但普通更新只在 `${filesDir}/dimina/<appId>/.pending/config.json` 记录待激活版本。即使 rawfile 中没有该 `appId` 的底包，首次启动也会在包加载阶段先安装 manifest 包。更新准备好后，业务调用 `applyUpdate()` 才会原子更新当前 `config.json`，并走 `updateApp()` 重启链路从新版本目录加载。

## 宿主卸载小程序

Android、iOS 与 Harmony 都提供宿主侧卸载接口。卸载会先使同一 `appId` 的排队中更新失效，关闭正在运行的小程序，再串行删除当前包、待更新包、下载临时文件和版本记录，避免下载回调在卸载后重新写回文件。

默认 `clearUserData = false`，保留小程序的 Storage 和持久文件；临时文件及包资源仍会删除。传入 `true` 才会连同 Storage 和持久文件一起清除。内置于宿主的小程序被卸载后，下次启动会从宿主资源重新安装，默认保留的数据不会被重装过程覆盖。

### Android

```kotlin
Dimina.getInstance().uninstallMiniProgram("wx92269e3b2f304afc") { result ->
    result.onFailure { error ->
        // 处理卸载失败
    }
}

// 明确清除 Storage 与持久文件
Dimina.getInstance().uninstallMiniProgram(
    appId = "wx92269e3b2f304afc",
    clearUserData = true,
)
```

### iOS

```swift
try await DMPAppManager.sharedInstance().uninstallMiniProgram(
    appId: "wx92269e3b2f304afc"
)

// 明确清除 Storage 与持久文件
try await DMPAppManager.sharedInstance().uninstallMiniProgram(
    appId: "wx92269e3b2f304afc",
    clearUserData: true
)
```

### Harmony

```ts
await DMPAppManager.sharedInstance().uninstallMiniProgram('wx92269e3b2f304afc')

// 明确清除 Storage 与持久文件
await DMPAppManager.sharedInstance().uninstallMiniProgram(
  'wx92269e3b2f304afc',
  true
)
```

### Web 行为

Web 容器可以直接通过 `manifestUrl` 启动未预置在 `appList.json` 中的小程序：

```text
https://container.example.com/?manifestUrl=https%3A%2F%2Fcdn.example.com%2Fminiapps%2Fmanifest.json
```

也可以由宿主代码调用：

```js
await AppManager.openApp({
  manifestUrl: 'https://cdn.example.com/miniapps/manifest.json',
  scene: 1001,
  destroy: true,
}, application)
```

Web 会从 `webBaseUrl/<appId>/main/app-config.json`、`logic.js` 以及页面资源直接加载编译产物，不下载或解压 `packageUrl`。manifest 和静态资源跨域时，资源服务器需要允许 CORS。远程构建中的图片等静态资源应使用可部署前缀（例如设置 `ASSETS_PATH_PREFIX`），避免写死到容器站点根路径。

Web 端的 `UpdateManager` 仍默认通知“无更新”；版本切换由站点发布、HTTP 缓存、Service Worker 或宿主策略负责。

## 写入默认沙盒目录

如需自建更完整的包管理平台，最小改造方式仍然是把远程包解压到框架当前已经读取的沙盒目录：

- Android：`${filesDir}/jsapp/<appId>/`
- iOS：`Documents/Dimina/<appId>/`
- Harmony：`${filesDir}/dimina/<appId>/<versionCode>/`，并同步更新 `<appId>/config.json` 中的当前包配置。

Android 还需要更新本地记录的 `versionCode`，避免后续启动时被旧的内置包逻辑覆盖。iOS 通过沙盒中的 `<appId>/config.json` 与内置包比较版本。Harmony 需要让缓存配置指向新的版本目录。

如果业务不希望覆盖默认沙盒目录，而是希望直接选择某个下载目录运行，则需要额外扩展宿主侧 bundle path 或 bundle resolver 入口，让运行时显式读取业务指定的包路径。

## 生产环境建议

- manifest 与 zip 使用 HTTPS，并在发布系统中固定可信域名。
- 生产包建议始终填写 `sha256`；如需防止发布源被篡改，还应由宿主增加签名校验，而不只依赖哈希。
- 在下载前由宿主检查 Content-Length 或流式累计大小，设置包体上限与磁盘空间保护。
- 将发布灰度、版本撤回和最低可用版本放在服务端策略中；客户端继续保留最后一个可运行版本。
- 安装前除必需文件外，还应校验入口页面、分包目录和业务需要的静态资源是否完整。
- 记录 manifest 版本、下载耗时、校验结果、安装结果和回滚原因，便于定位线上更新失败。

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

该代码只处理更新状态和用户确认。配置 `updateManifestUrl` 后，新包下载、校验、安装和待更新目录切换由 SDK 内置更新器处理；签名、灰度发布、服务端回滚和包体限制仍由宿主或发布平台负责。

## 宿主自行安装与管理版本

无需远程 manifest 的 App 内嵌场景，可使用[宿主管理小程序版本与胶囊](./Host-Package-Management.md)中的本地 ZIP 安装、版本查询和胶囊显隐配置。
