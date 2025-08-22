# Dimina Android SDK

[![dimina](https://jitpack.io/v/didi/dimina.svg)](https://jitpack.io/#didi/dimina)

## 系统要求

- Android SDK: 最低 API 26 (Android 8.0)
- Java 17
- Gradle 8.0+
- 仅支持 ARM64 架构 (arm64-v8a)

## 快速接入

### 步骤 1: 添加 JitPack 仓库

在项目根目录的 `settings.gradle` 或 `settings.gradle.kts` 文件中添加：

```kotlin
dependencyResolutionManagement {
    repositories {
        // 其他仓库...
        maven { url = uri("https://jitpack.io") }
    }
}
```

### 步骤 2: 添加依赖

在应用模块的 `build.gradle` 或 `build.gradle.kts` 文件中添加：

#### Groovy DSL

```groovy
dependencies {
    // Dimina 核心库
    implementation 'com.github.didi.dimina:dimina:latest.release'
}
```

#### Kotlin DSL

```kotlin
dependencies {
    // Dimina 核心库
    implementation("com.github.didi.dimina:dimina:latest.release")
}
```

### 步骤 3: 初始化 SDK

在应用的 `Application` 类中初始化 Dimina SDK：

```kotlin
import com.didi.dimina.Dimina

class MyApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        Dimina.init(this, Dimina.DiminaConfig.Builder()
            // 是否启用调试模式：影响日志显示
            // 调试模式不检测 App 是否已更新，都会进入 JSSDK 和 JSApp 的更新检测逻辑
            .setDebugMode(true)
            .build()
        )
    }
}
```

### 步骤 4: 启动小程序

将编译好的小程序压缩包放入 `assets/jsapp` 文件夹，文件夹以小程序id命名。每个小程序文件夹需包含以下内容：

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

2. `[appId].zip` - 小程序代码包，文件名需与appId一致

目录结构示例：

```txt
assets/
  └── jsapp/
      ├── wx92269e3b2f304afc/
      │   ├── config.json
      │   └── wx92269e3b2f304afc.zip
      └── wxbaf4b47de04f1d8a/
          ├── config.json
          └── wxbaf4b47de04f1d8a.zip
```

启动小程序：

```kotlin
// 从 config.json 文件创建 MiniProgram 对象
val miniProgram = MiniProgram(
    appId = "wx92269e3b2f304afc",  // 小程序唯一标识
    name = "小程序名称",      // 小程序名称
    versionCode = 1,            // 版本号
    versionName = "1.0.0",      // 版本名称
    path = "example/index"       // 小程序入口路径
)

// 启动小程序
Dimina.getInstance().startMiniProgram(context, miniProgram)
```

## 模块说明

- **dimina**: 核心库，包含小程序运行环境、UI组件和生命周期管理
- **engine-qjs**: QuickJS JavaScript引擎，提供高性能的JS执行环境
