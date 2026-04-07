# Dimina 能力参考指南

## 语法差异

Vue 作为底层的渲染框架，自然会与小程序的语法存在一定的差异。这些差异点需要我们在框架中进行适配，或者要求业务代码做些许的改造，以实现无缝迁移。例如：

相比微信小程序，具有以下语法和实现差异：

- **Data 字段的声明**

    小程序的 `data` 字段可以不提前声明直接使用，而 Vue 则需要显式声明。这种差异导致业务代码需要额外的字段初始化。比如视图中使用了 `{{text}}`，但对应 js 的 `data: {}` 未声明就进行调用 `this.setData({text: 'hello'})`

- **具名插槽的显示逻辑**

    在小程序中，具名插槽可以同名且能同时渲染显示，而 Vue 的插槽机制会默认覆盖同名插槽。对此，需要为小程序的插槽机制设计一套适配逻辑。比如 `<text slot="info">成功</text><text slot="info">失败</text>`，后面的文案不会显示。

- **组件属性的默认值**

    小程序中，组件属性如果为空字符串，会默认解析为 `false`；而在 Vue 中，空字符串会被解析为 [`true`](https://github.com/vuejs/vue/issues/4710)。这种行为差异需要在属性处理逻辑中进行适配。
    另外针对字符串类型的组件属性，如果未赋值，微信小程序会处理成空字符串（伴有提示：`received type-uncompatible value: expected <String> but get null value. Use empty string instead.`），但是星河不会处理而是直接透传，这一点请注意。

- **循环内的访问限制**

    在小程序中，`wx:for` 标签用于在元素上直接进行循环操作，并允许直接在该元素上使用 `wx:if` 直接访问循环实例的属性。Vue 的 `v-for` 不支持这个特性，需要修改访问属性的方法移动到下一级节点。

## 组件列表

| 组件              |
|-------------------|
| block             |
| button            |
| checkbox          |
| checkbox-group    |
| cover-image       |
| cover-view        |
| form              |
| icon              |
| image             |
| input             |
| label             |
| moveable-area     |
| moveable-view     |
| navigation-bar    |
| navigator         |
| picker-view       |
| picker-view-column|
| progress          |
| radio             |
| radio-group       |
| rich-text         |
| scroll-view       |
| slider            |
| swiper            |
| swiper-item       |
| switch            |
| text              |
| textarea          |
| view              |

说明：

- 同层渲染组件暂未支持(Android/iOS)。
- tabBar 暂未支持(Android/iOS/Harmony)。

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

| 分类              | API 名称                          | Android | iOS | Harmony | Web |
|-------------------|----------------------------------|---------|-----|---------|-----|
| 基础              | env                              | ✓       | ✓   | ✓       | ✓   |
|                   | canIUse                          | ✓       | ✓   | ✓       | ✗  |
| 基础 - 系统        | openSystemBluetoothSetting       | ✓       | ✗   | ✗       | ✗   |
|                   | getWindowInfo                    | ✓       | ✓   | ✓       | ✗  |
|                   | getSystemSetting                 | ✓       | ✓   | ✓       | ✗   |
|                   | getSystemInfoSync                | ✓       | ✓   | ✓       | ✗   |
|                   | getSystemInfoAsync               | ✓       | ✓   | ✓       | ✓   |
|                   | getSystemInfo                    | ✓       | ✓   | ✓       | ✗  |
| 路由               | reLaunch                         | ✓       | ✓   | ✓       | ✓   |
|                   | redirectTo                       | ✓       | ✓   | ✓       | ✓   |
|                   | navigateTo                       | ✓       | ✓   | ✓       | ✓   |
|                   | navigateBack                     | ✓       | ✓   | ✓       | ✓   |
| 界面 - 交互        | showToast                        | ✓       | ✓   | ✓       | ✓   |
|                   | showModal                        | ✓       | ✓   | ✓       | ✓   |
|                   | showLoading                      | ✓       | ✓   | ✓       | ✓   |
|                   | showActionSheet                  | ✓       | ✓   | ✓       | ✓   |
|                   | hideToast                        | ✓       | ✓   | ✓       | ✓   |
|                   | hideLoading                      | ✓       | ✓   | ✓       | ✓   |
| 界面 - 导航栏       | setNavigationBarTitle            | ✓       | ✓   | ✓       | ✓   |
|                   | setNavigationBarColor            | ✓       | ✓   | ✓       | ✓   |
| 界面 - 滚动        | pageScrollTo                     | ✓       | ✓   | ✓       | ✓   |
| 界面 - 菜单        | getMenuButtonBoundingClientRect  | ✓       | ✓   | ✓       | ✓  |
| 网络               | request                          | ✓       | ✓   | ✓       | ✓   |
|                   | downloadFile                     | ✓       | ✓   | ✓       | ✗   |
|                   | uploadFile                       | ✓       | ✓   | ✓       | ✗   |
| 数据缓存           | setStorageSync                   | ✓       | ✓   | ✓       | ✗  |
|                   | getStorageSync                   | ✓       | ✓   | ✓       | ✗   |
|                   | removeStorageSync                | ✓       | ✓   | ✓       | ✗   |
|                   | clearStorageSync                 | ✓       | ✓   | ✓       | ✗   |
|                   | setStorage                       | ✓       | ✓   | ✓       | ✓   |
|                   | getStorage                       | ✓       | ✓   | ✓       | ✓   |
|                   | removeStorage                    | ✓       | ✓   | ✓       | ✓   |
|                   | clearStorage                     | ✓       | ✓   | ✓       | ✓   |
|                   | getStorageInfoSync               | ✓       | ✓   | ✓       | ✗   |
|                   | getStorageInfo                   | ✓       | ✓   | ✓       | ✓   |
| 媒体 - 图片        | saveImageToPhotosAlbum           | ✓       | ✓   | ✓       | ✗   |
|                   | previewImage                     | ✓       | ✓   | ✓       | □   |
|                   | compressImage                    | ✓       | ✓   | ✓       | ✗   |
|                   | chooseImage                      | ✓       | ✓   | ✓       | ✗   |
| 媒体 - 视频        | chooseMedia                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 联系人       | chooseContact                    | ✓       | ✓   | ✓       | ✗   |
|                   | addPhoneContact                  | ✓       | ✓   | ✓       | ✗   |
| 设备 - 剪贴板       | setClipboardData                 | ✓       | ✓   | ✓       | ✓   |
|                   | getClipboardData                 | ✓       | ✓   | ✓       | ✓   |
| 设备 - 震动        | vibrateShort                     | ✓       | ✓   | ✓       | ✗   |
|                   | vibrateLong                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 键盘        | hideKeyboard                     | ✓       | ✓   | ✓       | ✗   |
| 设备 - 网络        | getNetworkType                   | ✓       | ✓   | ✓       | ✓   |
| 设备 - 电话        | makePhoneCall                    | ✓       | ✓   | ✓       | ✗   |
| 第三方扩展          | extBridge                        | ✓       | ✓   | ✓       | ✓   |
|                   | extOnBridge                      | ✓       | ✓   | ✓       | ✓   |
|                   | extOffBridge                     | ✓       | ✓   | ✓       | ✓   |

说明：

- "✓" 表示支持该平台。
- "□" 表示当前不支持。
- "✗" 表示明确不支持该平台。

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
