# Dimina Harmony SDK

## 介绍

可以快速将已有的小程序接入到 HarmonyOS 应用中，支持小程序的启动、跳转、分享、消息推送等能力。

## 系统环境

- HarmonyOS 5.0.0+
- compatibleSdkVersion: 12
- minSdkVersion: 12

## 快速接入

### 步骤 1：安装说明

```sh
ohpm install @didi-dimina/dimina
```

### 步骤 2：初始化

在应用的 EntryAbility 中初始化 DMPApp：

```ts
const dmpConfig: DMPEntryContext = {
  getContext: (): common.UIAbilityContext => {
    return this.context;
  },
  getWindowStage: (): window.WindowStage => {
    return windowStage;
  }
};
DMPApp.init(dmpConfig);
```

### 步骤 3：配置路由

在已经存在的 Navigation 中绑定 routerFactory。如果业务侧已经定义了 routerFactory，需要合并 Dimina 的页面路由：

```ts
  Navigation(this.pageInfos) {
        .....
  }
  .navDestination(this.routerFactory)

  @Builder
  routerFactory(name: string, paramMap: Map<string, Object>) {
    if (name == DMPPage.ROUTE_NAME) {
      DMPPage({ uri: name, param: paramMap });
    } else if (name == DMPPhotoPreview.ROUTE_NAME) {
      DMPPhotoPreview({ uri: name, param: paramMap });
    }
  }
```

### 步骤 4：引入小程序业务代码

将编译好的小程序压缩包放入 `entry/src/main/resources/rawfile/jsapp` 文件夹，文件夹以小程序 ID 命名。仓库示例工程会在构建时从根目录 `shared/jsapp` 自动复制资源到该目录。每个小程序文件夹需包含以下内容：

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
rawfile/
  └── jsapp/
      ├── wx92269e3b2f304afc/
      │   ├── config.json
      │   └── wx92269e3b2f304afc.zip
      └── wxbaf4b47de04f1d8a/
          ├── config.json
          └── wxbaf4b47de04f1d8a.zip
```

内置包会在启动时按 `versionCode` 解压到应用沙盒版本目录后运行。动态下发、远程下载和 `wx.getUpdateManager` 的职责边界请参考[小程序包更新说明](../../docs/MiniProgram-Update.md)。

### 步骤 5：创建小程序并启动

1. 创建小程序实例

```ts
const appConfig: DMPAppConfig = new DMPAppConfig("小程序名称", "appId")//appId 小程序唯一标识
appConfig.isDebugMode = true
appConfig.updateManifestUrl = "https://example.com/jsapp/appId.json" // 可选：远程更新 manifest
this.app = DMPAppManager.sharedInstance().appWithConfig(appConfig)
```

2. 绑定当前NavPathStack

```ts
this.app.router.init(this.pageInfos)
this.app.startPackageLoader(getContext(this) as common.UIAbilityContext)
```

3. 启动配置

```ts
const launchConfig: DMPLaunchConfig = new DMPLaunchConfig()
launchConfig.openType = DMPOpenType.NavigateTo
this.app.launch(launchConfig)
```

`DMPApp` 可以由宿主持有，但 `closeDimina()` 会释放其 Worker、页面和原生监听。再次打开同一实例时，
仍需按上述顺序调用 `startPackageLoader()` 和 `launch()`；SDK 会重新注册应用并完整重建临时运行态。
如果宿主自行维护 appId 到实例的映射，不要在已有新实例运行时复用更早关闭的同 appId 实例。

宿主主动关闭小程序时，调用统一退出入口：

```ts
await this.app.closeMiniProgram()
```

该入口会通过 `DMPAppManager.exitMiniProgram` 完成生命周期派发、运行时回收，并在存在来源小程序时恢复来源。`closeDimina()` 是底层关闭原语，不负责跨小程序来源恢复。

卸载已安装包时，默认保留小程序 Storage 和持久文件；第二个参数传 `true` 才会一并清除：

```ts
await DMPAppManager.sharedInstance().uninstallMiniProgram('appId')
await DMPAppManager.sharedInstance().uninstallMiniProgram('appId', true)
```

并发更新、待更新包清理和各端完整行为见[小程序包更新说明](../../docs/MiniProgram-Update.md)。

### 调试模式与 vConsole

当 `appConfig.isDebugMode = true`，或当前 HAP 为 debug 包时，SDK 会在加载 pageFrame 时追加 `?vconsole=1`。

JSSDK 直接依赖 vConsole，并随 pageFrame 静态同步打包；只有检测到该启用标记时，pageFrame 才会在 render 初始化前同步初始化 vConsole。

逻辑层 QuickJS 的断点、单步、变量查看和表达式求值需要 Debug HAP、DMCC `--sourcemap`
产物及显式调试端口。完整配置与 HDC 端口转发步骤见
[Harmony 逻辑层 JavaScript 断点调试](../../docs/JavaScript-Debugging.md)。
