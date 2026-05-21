# Dimina 共享资源

此目录包含被多个 Dimina 平台实现（Android、iOS、Harmony）共同使用的共享资源。

## 问题背景

Dimina 作为一个跨平台的小程序框架，同时支持 Android、iOS 和 Harmony 操作系统。在原有的代码仓库结构中，小程序资源文件和 SDK 文件存在重复：

- Android 平台：
  - 小程序资源：`android/app/src/main/assets/jsapp/[appId]/`
  - SDK 资源：`android/dimina/src/main/assets/jssdk/`
- iOS 平台：
  - 小程序资源：`iOS/dimina/Resources/JsApp.bundle/[appId]/`
  - SDK 资源：`iOS/dimina/Resources/JsSdk.bundle/`
- Harmony 平台：
  - 小程序资源：`harmony/entry/src/main/resources/rawfile/jsapp/[appId]/`
  - SDK 资源：`harmony/dimina/src/main/resources/rawfile/jssdk/`

这种重复导致以下问题：

1. 维护成本高（需要在多处更新相同文件）
2. 仓库体积增大
3. 平台之间可能出现资源不一致

## 优化方案

为解决上述问题，我们实施了共享资源方案，将所有平台的小程序资源统一管理在一个共享目录中，并在构建过程中自动复制到各平台特定位置。

## 目录结构

- `jsapp/`：包含被 Android、iOS 和 Harmony 平台共同使用的小程序包
  - `[appId]/`：每个小程序的目录，以其唯一的 appId 命名
    - `config.json`：小程序的配置文件
    - `[appId].zip`：编译好的小程序包
- `jssdk/`：包含被 Android、iOS 和 Harmony 平台共同使用的 SDK 文件
  - `config.json`：SDK 的配置文件
  - `main.zip`：SDK 核心文件

```txt
dimina/
├── shared/
│   ├── jsapp/
│   │   ├── [appId1]/
│   │   │   ├── config.json
│   │   │   └── [appId1].zip
│   │   └── [appId2]/
│   │       ├── config.json
│   │       └── [appId2].zip
│   └── jssdk/
│       ├── config.json
│       └── main.zip
```

## 使用方法

此目录中的资源在构建过程中会自动复制到相应的平台特定位置：

### 小程序资源 (jsapp)

- Android：`app/src/main/assets/jsapp/`
- iOS：`Resources/JsApp.bundle`
- Harmony：`entry/src/main/resources/rawfile/jsapp/`

### SDK 资源 (jssdk)

- Android：`dimina/src/main/assets/jssdk/`
- iOS：`Resources/JsSdk.bundle/`
- Harmony：`dimina/src/main/resources/rawfile/jssdk/`

## 添加新的小程序

要添加新的小程序：

1. 在 `jsapp/` 下创建一个以小程序 appId 命名的新目录
2. 添加 `config.json` 配置文件
3. 添加编译好的小程序包（`.zip` 文件）

示例：

```txt
shared/jsapp/wx92269e3b2f304afc/
├── config.json
└── wx92269e3b2f304afc.zip
```

## 共享资源配置

每个平台的构建过程包含将这些共享资源复制到相应位置的脚本：

### Android 平台

- 在 `android/app/build.gradle.kts` 中添加构建任务 `copySharedJsappToAssets`，实现 JSApp 的资源复制；
- 在 `android/dimina/build.gradle.kts` 中添加构建任务 `copySharedJssdkToAssets`，实现 JSSDK 的资源复制。

### iOS 平台

在 iOS 项目中添加了 `copy-shared-resources.sh` 脚本，该脚本在构建过程中会自动执行，将共享资源复制到相应的 bundle 目录中。

要在 Xcode 中设置此脚本：

1. 打开 Xcode 项目
2. 选择目标（Target）
3. 选择「Build Phases」选项卡
4. 点击「+」按钮，选择「New Run Script Phase」
5. 将新添加的 Run Script 阶段重命名为 "Copy Shared Resources"
6. 点击并拖动这个阶段，将其放在 "Copy Bundle Resources" 阶段之前
7. 将以下命令添加到脚本框中：

   ```bash
   "${SRCROOT}/copy-shared-resources.sh"
   ```

### Harmony 平台

在 `harmony/hvigorfile.ts` 中添加配置阶段完成之后执行的回调函数，实现资源复制功能。
