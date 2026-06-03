# Dimina 能力参考指南

## 语法差异

Vue 作为底层的渲染框架，自然会与小程序的语法存在一定的差异。这些差异点需要我们在框架中进行适配，或者要求业务代码做些许的改造，以实现无缝迁移。例如：

相比微信小程序，具有以下语法和实现差异：

- **具名插槽的显示逻辑**

    在小程序中，具名插槽可以同名且能同时渲染显示，而 Vue 的插槽机制会默认覆盖同名插槽。对此，需要为小程序的插槽机制设计一套适配逻辑。比如 `<text slot="info">成功</text><text slot="info">失败</text>`，后面的文案不会显示。

- **组件属性的默认值**

    小程序中，组件属性如果为空字符串，会默认解析为 `false`；而在 Vue 中，空字符串会被解析为 [`true`](https://github.com/vuejs/vue/issues/4710)。这种行为差异需要在属性处理逻辑中进行适配。
    另外针对字符串类型的组件属性，如果未赋值，微信小程序会处理成空字符串（伴有提示：`received type-uncompatible value: expected <String> but get null value. Use empty string instead.`），但是星河不会处理而是直接透传，这一点请注意。

- **循环内的访问限制**

    在小程序中，`wx:for` 标签用于在元素上直接进行循环操作，并允许直接在该元素上使用 `wx:if` 直接访问循环实例的属性。Vue 的 `v-for` 不支持这个特性，需要修改访问属性的方法移动到下一级节点。

## 组件列表

| 组件               |
| ------------------ |
| block              |
| button             |
| canvas             |
| checkbox           |
| checkbox-group     |
| cover-image        |
| cover-view         |
| form               |
| icon               |
| image              |
| input              |
| label              |
| movable-area       |
| movable-view       |
| navigation-bar     |
| navigator          |
| picker             |
| picker-view        |
| picker-view-column |
| progress           |
| radio              |
| radio-group        |
| rich-text          |
| scroll-view        |
| slider             |
| slot               |
| swiper             |
| swiper-item        |
| switch             |
| template           |
| text               |
| textarea           |
| video              |
| view               |
| web-view           |
| wxs                |
| include            |
| import             |

说明：

- 该列表包含运行时内置组件，以及编译期支持的 WXML 模板标签（如 `slot`、`template`、`wxs`、`include`、`import`）。
- 同层渲染组件 `video` 已支持 Android / iOS / Harmony。
- tabBar 已支持 Android / iOS / Harmony。

### Android 同层渲染限制

Android 端当前不修改系统 WebView / Chromium 内核，因此同层渲染不是浏览器内核级的 DOM 合成能力，而是通过「原生组件在 WebView 背后 + WebView 按需透明 + Web 命中测试转发手势」实现。该方案能满足 HTML 元素覆盖在原生 `video` 上方的常见场景，但存在以下限制：

- 仅支持已接入原生背板方案的组件；当前主要用于 `video`。
- 原生组件不真正参与 DOM 渲染树、CSS `z-index` 层叠和浏览器 compositor 合成。
- HTML 元素可以覆盖在原生组件上方；原生组件只能通过透明占位区域显示出来。
- 暂不支持 CSS `clip-path`、复杂 `transform`、filter、mask、非矩形裁剪等效果与原生组件同步。
- 手势以 Web 侧命中测试为准：触摸命中原生占位节点时转发给原生组件，命中 HTML 覆盖元素时由 WebView 自己处理。
- WebView 透明仅在存在可见原生组件时按需开启，组件全部卸载或隐藏后会恢复默认背景。

## 模板语法支持

| 能力       | 支持说明                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| `slot`     | 支持默认插槽、具名插槽，以及 `slot="{{name}}"` 形式的动态插槽。具名插槽会转换为 Vue 插槽语法。                |
| `template` | 支持通过 `<template name="...">` 定义模板，并通过 `<template is="..." data="...">` 使用模板。模板内容会在编译期收集并注入。 |
| `wxs`      | 支持内联 WXS 和 `src` 外链 WXS；支持 WXS 内部 `require` 相对路径依赖，npm 组件内的 WXS 路径会做适配。          |
| `include`  | 支持将目标 WXML/DDML 文件中除 `template`、`wxs`、`dds` 外的内容内联到当前位置；`include` 节点上的条件属性会保留并包裹到生成节点上。 |
| `import`   | 支持导入目标 WXML/DDML 文件中的 `template` 与相关 WXS 依赖，导入节点本身会在编译期移除。                      |

## 自定义全局 API 命名空间

Dimina 支持宿主应用注册自定义的全局 API 命名空间，使小程序可以通过自定义前缀（如 `custom.xxx()`）调用 API，等同于 `wx.xxx()` 的效果。

### 使用场景

适用于以下情况：

- 希望小程序使用品牌专属的 API 命名空间（如 `myapp.xxx`）
- 需要与现有小程序代码保持兼容性的同时，提供自有品牌标识
- 多租户场景下，不同宿主应用可配置不同的命名空间

### 宿主接入方式

#### Web（JavaScript）

```js
import { AppManager } from '@dimina/container'

// 在初始化应用前配置
AppManager.setup({ apiNamespaces: ['qd', 'myapp'] })
```

#### Android

```kotlin
val config = Dimina.DiminaConfig.Builder()
    .addApiNamespace("myapp")
    .build()
    
Dimina.getInstance().init(context, config)
```

#### iOS

```swift
DMPAppManager.sharedInstance().setup(apiNamespaces: ["myapp"])
```

#### HarmonyOS

```ts
DMPApp.init(context, { apiNamespaces: ["myapp"] })
```

## API 列表

| 分类          | API 名称                         | Android | iOS | Harmony | Web |
| ------------- | -------------------------------- | ------- | --- | ------- | --- |
| 基础          | env                              | ✓       | ✓   | ✓       | ✓   |
|               | canIUse                          | ✓       | ✓   | ✓       | ✗   |
| 基础 - 更新   | getUpdateManager                 | ✓       | ✓   | ✓       | ✓   |
| 基础 - 系统   | openSystemBluetoothSetting       | ✓       | ✗   | ✗       | ✗   |
|               | getWindowInfo                    | ✓       | ✓   | ✓       | ✗   |
|               | getSystemSetting                 | ✓       | ✓   | ✓       | ✗   |
|               | getSystemInfoSync                | ✓       | ✓   | ✓       | ✗   |
|               | getSystemInfoAsync               | ✓       | ✓   | ✓       | ✓   |
|               | getSystemInfo                    | ✓       | ✓   | ✓       | ✗   |
| 路由          | reLaunch                         | ✓       | ✓   | ✓       | ✓   |
|               | redirectTo                       | ✓       | ✓   | ✓       | ✓   |
|               | navigateTo                       | ✓       | ✓   | ✓       | ✓   |
|               | navigateBack                     | ✓       | ✓   | ✓       | ✓   |
| 界面 - 交互   | showToast                        | ✓       | ✓   | ✓       | ✓   |
|               | showModal                        | ✓       | ✓   | ✓       | ✓   |
|               | showLoading                      | ✓       | ✓   | ✓       | ✓   |
|               | showActionSheet                  | ✓       | ✓   | ✓       | ✓   |
|               | hideToast                        | ✓       | ✓   | ✓       | ✓   |
|               | hideLoading                      | ✓       | ✓   | ✓       | ✓   |
| 界面 - 导航栏 | setNavigationBarTitle            | ✓       | ✓   | ✓       | ✓   |
|               | setNavigationBarColor            | ✓       | ✓   | ✓       | ✓   |
| 界面 - 滚动   | pageScrollTo                     | ✓       | ✓   | ✓       | ✓   |
| 界面 - 菜单   | getMenuButtonBoundingClientRect  | ✓       | ✓   | ✓       | ✓   |
| 界面 - 动画   | createAnimation                  | ✓       | ✓   | ✓       | ✓   |
| 界面 - Canvas | createCanvasContext              | ✓       | ✓   | ✓       | ✓   |
|               | createOffscreenCanvas            | ✓       | ✓   | ✓       | ✓   |
|               | canvasToTempFilePath             | ✓       | ✓   | ✓       | ✓   |
| WXML          | createSelectorQuery              | ✓       | ✓   | ✓       | ✓   |
|               | createIntersectionObserver       | ✓       | ✓   | ✓       | ✓   |
| 网络          | request                          | ✓       | ✓   | ✓       | ✓   |
|               | downloadFile                     | ✓       | ✓   | ✓       | ✗   |
|               | uploadFile                       | ✓       | ✓   | ✓       | ✗   |
| 数据缓存      | setStorageSync                   | ✓       | ✓   | ✓       | ✗   |
|               | getStorageSync                   | ✓       | ✓   | ✓       | ✗   |
|               | removeStorageSync                | ✓       | ✓   | ✓       | ✗   |
|               | clearStorageSync                 | ✓       | ✓   | ✓       | ✗   |
|               | setStorage                       | ✓       | ✓   | ✓       | ✓   |
|               | getStorage                       | ✓       | ✓   | ✓       | ✓   |
|               | removeStorage                    | ✓       | ✓   | ✓       | ✓   |
|               | clearStorage                     | ✓       | ✓   | ✓       | ✓   |
|               | getStorageInfoSync               | ✓       | ✓   | ✓       | ✗   |
|               | getStorageInfo                   | ✓       | ✓   | ✓       | ✓   |
| 媒体 - 图片   | saveImageToPhotosAlbum           | ✓       | ✓   | ✓       | ✗   |
|               | previewImage                     | ✓       | ✓   | ✓       | □   |
|               | compressImage                    | ✓       | ✓   | ✓       | ✗   |
|               | chooseImage                      | ✓       | ✓   | ✓       | ✗   |
| 媒体 - 视频   | chooseMedia                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 联系人 | chooseContact                    | ✓       | ✓   | ✓       | ✗   |
|               | addPhoneContact                  | ✓       | ✓   | ✓       | ✗   |
| 设备 - 扫码   | scanCode                         | ✓       | □   | ✓       | ✗   |
| 设备 - 剪贴板 | setClipboardData                 | ✓       | ✓   | ✓       | ✓   |
|               | getClipboardData                 | ✓       | ✓   | ✓       | ✓   |
| 设备 - 震动   | vibrateShort                     | ✓       | ✓   | ✓       | ✗   |
|               | vibrateLong                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 键盘   | hideKeyboard                     | ✓       | ✓   | ✓       | ✗   |
| 设备 - 网络   | getNetworkType                   | ✓       | ✓   | ✓       | ✓   |
| 设备 - 电话   | makePhoneCall                    | ✓       | ✓   | ✓       | ✗   |
| 第三方扩展    | extBridge                        | ✓       | ✓   | ✓       | ✓   |
|               | extOnBridge                      | ✓       | ✓   | ✓       | ✓   |
|               | extOffBridge                     | ✓       | ✓   | ✓       | ✓   |

说明：

- "✓" 表示支持该平台。
- "□" 表示当前不支持。
- "✗" 表示明确不支持该平台。
- `getUpdateManager` 只负责更新状态通知和重启入口，包下载、校验和动态下发流程请参考[小程序包更新说明](./MiniProgram-Update.md)。

---

## wx.scanCode 参数说明

扫码 API，支持二维码和条码（1D/2D）识别。Android 端扫码引擎策略：**Android 9+ 使用 ML Kit**，**Android < 9 使用 ZXing**。

### 基本用法

```js
wx.scanCode({
  success(res) {
    console.log(res.result)    // 扫码内容
    console.log(res.scanType)  // 条码类型：QR_CODE / CODE_128 / EAN_13 ...
  },
  fail(err) {
    console.log(err.errMsg)
  }
})
```

### 参数列表

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `onlyFromCamera` | boolean | `false` | 是否仅从相机扫码（禁止相册选图） |
| `continuous` | boolean | `false` | 连续扫码模式，扫码后不关闭相机，结果在界面下方累加 |
| `title` | string | `"扫码"` | 顶部标题文字 |
| `titleColor` | string | `"#FFFFFF"` | 标题文字颜色，#RRGGBB 或 #AARRGGBB 格式 |
| `hint` | string | `"将条码/二维码放入框内自动扫描"` | 底部提示文字 |
| `hintColor` | string | `"#FFFFFF"` | 提示文字颜色 |
| `frameColor` | string | `"#FFFFFF"` | 扫描框边框颜色 |
| `cornerColor` | string | `"#00C853"` | 扫描框四角色彩 |
| `albumText` | string | `"从相册选择"` | 相册选图按钮文字（仅 `onlyFromCamera=false` 时显示） |
| `albumTextColor` | string | `"#00C853"` | 相册按钮文字颜色 |
| `backText` | string | `"← 返回"` | 返回按钮文字 |
| `backTextColor` | string | `"#FFFFFF"` | 返回按钮文字颜色 |
| `continuousHint` | string | `"已识别 %d 个，继续扫码中…"` | 连续模式下结果列表上方的状态提示，`%d` 会被替换为已扫数量 |
| `finishText` | string | `"完成 (%d)"` | 连续模式下底部完成按钮文字，`%d` 替换为已扫数量 |
| `frameWidthRatio` | number | `0.75` | 扫描框宽度占屏幕宽度的比例，范围 `0.2~0.95` |
| `frameAspectRatio` | number | `0.7` | 扫描框高宽比（高度 = 宽度 × 此值），范围 `0.3~1.5` |
| `frameVerticalOffset` | number | `0.8` | 扫描框垂直位置偏移系数，`1.0`=正中间，`<1.0`=偏上，`>1.0`=偏下，范围 `0.3~1.7` |

### 返回结果

| 字段 | 类型 | 说明 |
|------|------|------|
| `result` | string | 扫码内容（连续模式下为 JSON 数组字符串） |
| `scanType` | string | 条码/二维码类型，如 `QR_CODE`、`CODE_128`、`EAN_13` 等 |
| `charSet` | string | 字符集，固定 `"utf-8"` |
| `errMsg` | string | 调用结果信息，如 `"scanCode:ok"` |
| `batch` | boolean | 连续模式下为 `true`，此时 `result` 为批量结果数组 |

### 连续扫码

连续扫码模式下，`success` 回调的 `res` 包含 `batch: true`，`result` 为数组：

```js
wx.scanCode({
  continuous: true,
  success(res) {
    if (res.batch) {
      const list = res.result  // [{result, scanType, charSet}, ...]
      console.log('共扫描了', list.length, '个条码')
    }
  }
})
```

### 支持的条码格式

| 类别 | 格式 |
|------|------|
| **1D 条码** | CODE_128, CODE_39, CODE_93, EAN-13, EAN-8, UPC-A, UPC-E, Codabar, ITF |
| **2D 条码** | QR_CODE, DATA_MATRIX, PDF417, AZTEC |

### 平台支持

| 平台 | 状态 | 引擎 |
|------|------|------|
| Android | ✓ | Android 9+: ML Kit / Android <9: ZXing |
| iOS | □ | 待实现 |
| Harmony | ✓ | ScanKit（仅支持二维码） |
| Web | ✗ | 不支持 |

---

## 第三方扩展 Bridge

第三方扩展 Bridge 允许宿主 App 向小程序暴露自定义的 native 能力，小程序通过 `wx.extBridge`、`wx.extOnBridge`、`wx.extOffBridge` 三个 API 与之通信，无需修改框架核心代码。

### 通信模型

```
小程序 JS
  │  wx.extBridge / wx.extOnBridge / wx.extOffBridge
  ▼
Service 逻辑层（JS）
  │  invokeAPI → container
  ▼
Container（Android / iOS / Harmony / Web）
  │  路由到已注册的 ExtModuleHandler
  ▼
宿主 Native 模块
```

---

### wx.extBridge

**用途**：向指定 native 模块发起一次性调用，支持异步回调。

**参数**

| 参数       | 类型     | 必填 | 说明                         |
|------------|----------|------|------------------------------|
| `module`   | string   | 是   | 目标模块名，须与宿主注册时一致 |
| `event`    | string   | 是   | 事件名称                     |
| `data`     | object   | 否   | 传递给模块的参数，默认 `{}`   |
| `success`  | function | 否   | 调用成功的回调                |
| `fail`     | function | 否   | 调用失败的回调                |
| `complete` | function | 否   | 调用结束（无论成功/失败）的回调 |

**示例**

```js
wx.extBridge({
  module: 'UserModule',
  event: 'getUserInfo',
  data: { uid: '001' },
  success(res) {
    console.log('用户信息：', res)
  },
  fail(err) {
    console.error('获取失败：', err.errMsg)
  },
})
```

---

### wx.extOnBridge

**用途**：订阅 native 模块的持续事件推送（如传感器数据、登录状态变化等）。每次事件触发时 `callBack` 都会被调用，直到主动调用 `wx.extOffBridge` 或小程序销毁为止。

> **注意**：`module` 不能为空，也不能为保留名 `DMServiceBridgeModule`。

**参数**

| 参数        | 类型     | 必填 | 说明                             |
|-------------|----------|------|----------------------------------|
| `module`    | string   | 是   | 目标模块名                       |
| `event`     | string   | 是   | 事件名称                         |
| `callBack`  | function | 是   | 每次事件推送时触发的回调函数      |
| `isSustain` | boolean  | 否   | 是否持续订阅，默认 `true`         |

**示例**

```js
wx.extOnBridge({
  module: 'SensorModule',
  event: 'onAccelerometer',
  callBack(res) {
    console.log('加速度数据：', res)
  },
})
```

---

### wx.extOffBridge

**用途**：取消 `wx.extOnBridge` 建立的持续订阅。

> **注意**：`module` 不能为空，也不能为保留名 `DMServiceBridgeModule`。

**参数**

| 参数     | 类型   | 必填 | 说明       |
|----------|--------|------|------------|
| `module` | string | 是   | 目标模块名 |
| `event`  | string | 是   | 事件名称   |

**示例**

```js
wx.extOffBridge({
  module: 'SensorModule',
  event: 'onAccelerometer',
})
```

---

### 宿主接入：注册 Native 模块

宿主只需调用对应平台的注册 API，实现一个处理函数即可。同一个处理函数同时承载 `extBridge`（一次性）和 `extOnBridge`（持续订阅）两种场景：

- **一次性调用**：执行后调用 `success` / `fail`，函数返回 `void` / `null` / `nil`。
- **持续订阅**：启动事件监听，**返回取消函数**；框架在 `extOffBridge` 或小程序销毁时自动调用。

#### Web（JavaScript）

```js
import { AppManager } from '@dimina/container'

AppManager.registerExtModule('UserModule', ({ event, data, success, fail }) => {
  if (event === 'getUserInfo') {
    // 一次性调用
    fetchUser(data.uid).then(res => success(res)).catch(err => fail({ errMsg: err.message }))
    return  // 无需返回取消函数
  }

  if (event === 'onStatusChange') {
    // 持续订阅：返回取消函数
    const timer = setInterval(() => success({ status: getStatus() }), 1000)
    return () => clearInterval(timer)
  }

  fail({ errMsg: `UserModule: unknown event "${event}"` })
})
```

#### Android

```kotlin
Dimina.getInstance().registerExtModule("UserModule") { event, data, callback ->
    when (event) {
        "getUserInfo" -> {
            val uid = data.optString("uid")
            val info = fetchUserSync(uid)          // 同步或异步均可
            callback.onSuccess(JSONObject().apply {
                put("name", info.name)
                put("uid", info.uid)
            })
            null  // 一次性调用，无需取消函数
        }
        "onStatusChange" -> {
            // 持续订阅：返回取消订阅的 Runnable
            val job = statusObserver.observe { status ->
                callback.onSuccess(JSONObject().apply { put("status", status) })
            }
            Runnable { job.cancel() }
        }
        else -> {
            callback.onFail(JSONObject().apply {
                put("errMsg", "UserModule: unknown event \"$event\"")
            })
            null
        }
    }
}
```

#### Harmony

```ts
import { DMPMap } from '@dimina/dimina'

app.registerExtModule('UserModule', (event, data, callback) => {
  if (event === 'getUserInfo') {
    // 一次性调用
    const uid = data.get('uid') as string
    fetchUser(uid).then(info => {
      callback.onSuccess(new DMPMap({ name: info.name, uid: info.uid }))
    }).catch(err => {
      callback.onFail(new DMPMap({ errMsg: err.message }))
    })
    return null  // 一次性调用，无需取消函数
  }

  if (event === 'onStatusChange') {
    // 持续订阅：返回取消函数
    const timer = setInterval(() => {
      callback.onSuccess(new DMPMap({ status: getStatus() }))
    }, 1000)
    return () => clearInterval(timer)
  }

  callback.onFail(new DMPMap({ errMsg: `UserModule: unknown event "${event}"` }))
  return null
})
```

#### iOS

```swift
DMPAppManager.sharedInstance().registerExtModule("UserModule") { event, data, callback in
    switch event {
    case "getUserInfo":
        let uid = data["uid"] as? String ?? ""
        fetchUser(uid: uid) { info in
            callback.onSuccess(DMPMap(["name": info.name, "uid": info.uid]))
        }
        return nil  // 一次性调用

    case "onStatusChange":
        // 持续订阅：返回取消闭包
        let token = statusObserver.observe { status in
            callback.onSuccess(DMPMap(["status": status]))
        }
        return { statusObserver.remove(token) }

    default:
        callback.onFail(DMPMap(["errMsg": "UserModule: unknown event \"\(event)\""]))
        return nil
    }
}
```

---

### 生命周期说明

| 时机                   | 行为                                       |
|------------------------|--------------------------------------------|
| `wx.extOnBridge` 调用  | 框架调用宿主处理函数，保存返回的取消函数      |
| `wx.extOffBridge` 调用 | 框架执行取消函数，清除订阅记录               |
| 重复订阅同一事件        | 框架自动先取消旧订阅，再建立新订阅           |
| 小程序销毁             | 框架执行所有未取消的订阅的取消函数，防止泄漏  |
