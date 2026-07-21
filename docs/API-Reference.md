# Dimina 能力与兼容性参考

[文档中心](./README.md) · [架构图](./Architecture-Diagram.md) · [生命周期](./Architecture-Lifecycle.md)

本文记录当前经过确认的模板标签、内置组件、`wx` API 和宿主扩展能力。它是兼容性基线，不等同于微信小程序完整能力集合，也不保证同名能力在四个平台上的细节完全一致。

使用本页时建议按以下顺序判断：

1. 确认语法、组件或 API 已列入支持范围。
2. 查看目标平台列；未支持的平台必须提供降级路径。
3. 在运行时使用 `wx.canIUse()`（目标平台支持时）保护可选能力。
4. 对相机、定位、文件、同层渲染等平台相关能力，在真机验证权限、失败回调和最终画面。

> 本文的组件表和 API 表还会生成编译器的兼容性提示清单。修改表中名称后，需要在 `fe/` 下运行 `pnpm --filter compiler sync:compat` 并提交对应生成文件。

## 语法兼容处理

Dimina 的 render runtime 使用 Vue，但模板编译器和组件 runtime 会把以下行为统一为小程序语义：

- **具名插槽的显示逻辑**

    同一组件下的多个同名具名插槽会按声明顺序合并渲染。例如 `<text slot="info">成功</text><text slot="info">失败</text>` 会同时显示两个节点；动态插槽也使用相同的合并规则。

- **组件属性的默认值**

    属性声明会独立于 Vue props 完成默认值、主类型转换和 `optionalTypes` 匹配。布尔属性使用小程序真值转换，未传入的字符串、数字、布尔、数组属性分别回退为 `''`、`0`、`false`、`[]`，初始化和后续更新采用同一规则。

- **循环内的访问限制**

    同一节点同时声明 `wx:for` 和 `wx:if` 时，编译器会先建立循环作用域，再在作用域内执行条件判断，因此 `wx:if` 可以直接访问当前项和索引。

- **组件样式隔离**

    自定义组件支持 `isolated`、`apply-shared` 和 `shared` 三种样式隔离模式。未声明时默认为 `isolated`；`apply-shared` 允许 `app.wxss`、页面 WXSS 和共享组件样式进入组件内部；`shared` 在此基础上也允许组件 WXSS 作用于页面及其他允许共享的组件，但不会穿透 `isolated` 组件的内部节点。

    `styleIsolation` 可以写在组件 JSON 或 `Component({ options })` 中；旧写法 `addGlobalClass: true` 等同于 `apply-shared`。运行时新增或移除节点时会继续沿用相同隔离边界，无需业务代码补样式类。

- **使用未预先声明的 data 字段**

    Page 和 Component 可以通过 `setData()` 新增未在初始 `data` 中声明的字段。service 会立即把字段写入逻辑数据；render 收到更新后会补充对应的 Vue 响应式根字段并刷新组件代理，因此模板可以直接使用新增字段。

    顶层字段和嵌套路径均受支持。路径中不存在的中间节点会根据下一段路径自动创建为对象或数组；方括号只接受数字下标，字段名中的点号或方括号需要使用反斜杠转义。

    ```js
    Page({
      data: {},
      onLoad() {
        this.setData({
          status: 'ready',
          'user.profile.name': 'Dimina',
          'items[0]': { id: 1 },
          'literal\\.key': 'value',
        })
      },
    })
    ```

    上例中的 `status`、`user`、`items` 和 `literal.key` 都不需要提前声明。直接执行 `this.data.status = 'ready'` 只会修改当前逻辑层对象，不会建立一次可靠的跨线程视图更新；需要让模板更新时仍应使用 `setData()`。

- **组件初始属性与生命周期**

    默认情况下，`created` 中可读取属性默认值；父组件传入的初始值会在 `created` 后写入，然后依次执行 data observer 和 property observer。如果组件开启 `options.propertyEarlyInit: true`，则初始属性和 observer 会在 `created` 前完成。`lifetimes` 中的同名回调优先于顶层生命周期字段，behavior 也遵循相同规则。

## 组件列表

该表是编译器兼容性清单的数据源，因此保持单列格式。

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

Android、iOS 与 Harmony SDK 支持宿主配置自定义的全局 API 命名空间，使小程序可以通过自定义前缀（如 `custom.xxx()`）访问与 `wx.xxx()` 相同的 API 集合。命名空间必须在逻辑引擎创建前配置。

### 使用场景

适用于以下情况：

- 希望小程序使用品牌专属的 API 命名空间（如 `myapp.xxx`）
- 需要与现有小程序代码保持兼容性的同时，提供自有品牌标识
- 多租户场景下，不同宿主应用可配置不同的命名空间

### 宿主接入方式

#### Web 命名空间

仓库内默认 Web 容器会在创建 Worker 时读取宿主提供的 `getApiNamespaces()`，但当前没有对外暴露与原生 SDK 等价的 `AppManager.setup()` 公共接口。直接使用默认 Web 示例时请继续使用 `wx`；自定义宿主需要在创建逻辑 Worker 前把命名空间注入容器配置。

#### Android 命名空间

```kotlin
val config = Dimina.DiminaConfig.Builder()
    .addApiNamespace("myapp")
    .build()

Dimina.init(context, config)
```

#### iOS 命名空间

```swift
DMPAppManager.sharedInstance().setup(apiNamespaces: ["myapp"])
```

#### HarmonyOS 命名空间

```ts
DMPApp.init(context, { apiNamespaces: ["myapp"] })
```

## API 列表

状态说明：`✓` 表示该平台已有对应实现；`✗` 表示当前未提供。能力入口存在但目标平台未实现时，仍按不支持处理。

蓝牙能力还要求宿主声明系统权限。仓库示例已经补齐 Android 蓝牙/定位权限、iOS 蓝牙用途说明和 HarmonyOS `ohos.permission.ACCESS_BLUETOOTH`；集成 SDK 的宿主应用需要提供等价配置。

局域网能力要求宿主允许网络和局域网访问。Android 宿主需要声明 `INTERNET`，使用多播发现时还需要 `CHANGE_WIFI_MULTICAST_STATE`；调用 `TCPSocket.bindWifi` 还需要申请 `ACCESS_FINE_LOCATION`，Android 13 及以上同时需要 `NEARBY_WIFI_DEVICES`。iOS 宿主需要提供 `NSLocalNetworkUsageDescription`，使用 mDNS 时还必须在 `NSBonjourServices` 中列出业务实际使用的服务类型；HarmonyOS 宿主需要声明 `ohos.permission.INTERNET`。`TCPSocket.bindWifi` 是微信仅在 Android 提供的能力。

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
|               | getAppBaseInfo                   | ✓       | ✓   | ✓       | ✓   |
|               | getDeviceInfo                    | ✓       | ✓   | ✓       | ✓   |
|               | onThemeChange                    | ✓       | ✓   | ✓       | ✓   |
|               | offThemeChange                   | ✓       | ✓   | ✓       | ✓   |
| 设备 - 蓝牙   | openBluetoothAdapter             | ✓       | ✓   | ✓       | ✗   |
|               | closeBluetoothAdapter            | ✓       | ✓   | ✓       | ✗   |
|               | getBluetoothAdapterState         | ✓       | ✓   | ✓       | ✗   |
|               | startBluetoothDevicesDiscovery   | ✓       | ✓   | ✓       | ✗   |
|               | stopBluetoothDevicesDiscovery    | ✓       | ✓   | ✓       | ✗   |
|               | getBluetoothDevices              | ✓       | ✓   | ✓       | ✗   |
|               | getConnectedBluetoothDevices     | ✓       | ✓   | ✓       | ✗   |
|               | onBluetoothAdapterStateChange    | ✓       | ✓   | ✓       | ✗   |
|               | offBluetoothAdapterStateChange   | ✓       | ✓   | ✓       | ✗   |
|               | onBluetoothDeviceFound           | ✓       | ✓   | ✓       | ✗   |
|               | offBluetoothDeviceFound          | ✓       | ✓   | ✓       | ✗   |
| 设备 - 低功耗蓝牙 | createBLEConnection             | ✓       | ✓   | ✓       | ✗   |
|               | closeBLEConnection              | ✓       | ✓   | ✓       | ✗   |
|               | getBLEDeviceServices            | ✓       | ✓   | ✓       | ✗   |
|               | getBLEDeviceCharacteristics     | ✓       | ✓   | ✓       | ✗   |
|               | readBLECharacteristicValue      | ✓       | ✓   | ✓       | ✗   |
|               | writeBLECharacteristicValue     | ✓       | ✓   | ✓       | ✗   |
|               | notifyBLECharacteristicValueChange | ✓    | ✓   | ✓       | ✗   |
|               | getBLEDeviceRSSI                | ✓       | ✓   | ✓       | ✗   |
|               | setBLEMTU                       | ✓       | ✗   | ✓       | ✗   |
|               | getBLEMTU                       | ✓       | ✓   | ✓       | ✗   |
|               | onBLEConnectionStateChange      | ✓       | ✓   | ✓       | ✗   |
|               | offBLEConnectionStateChange     | ✓       | ✓   | ✓       | ✗   |
|               | onBLECharacteristicValueChange | ✓       | ✓   | ✓       | ✗   |
|               | offBLECharacteristicValueChange | ✓      | ✓   | ✓       | ✗   |
|               | onBLEMTUChange                  | ✓       | ✓   | ✓       | ✗   |
|               | offBLEMTUChange                 | ✓       | ✓   | ✓       | ✗   |
|               | isBluetoothDevicePaired         | ✓       | ✗   | ✗       | ✗   |
|               | makeBluetoothPair               | ✓       | ✗   | ✗       | ✗   |
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
|               | onMenuButtonBoundingClientRectWeightChange | ✓ | ✓ | ✓ | ✓ |
|               | offMenuButtonBoundingClientRectWeightChange | ✓ | ✓ | ✓ | ✓ |
| 界面 - 自定义组件 | nextTick                       | ✓       | ✓   | ✓       | ✓   |
| 界面 - 动画   | createAnimation                  | ✓       | ✓   | ✓       | ✓   |
| 界面 - Canvas | createCanvasContext              | ✓       | ✓   | ✓       | ✓   |
|               | createOffscreenCanvas            | ✓       | ✓   | ✓       | ✓   |
|               | canvasToTempFilePath             | ✓       | ✓   | ✓       | ✓   |
| WXML          | createSelectorQuery              | ✓       | ✓   | ✓       | ✓   |
|               | createIntersectionObserver       | ✓       | ✓   | ✓       | ✓   |
| 网络          | request                          | ✓       | ✓   | ✓       | ✓   |
|               | downloadFile                     | ✓       | ✓   | ✓       | ✗   |
|               | uploadFile                       | ✓       | ✓   | ✓       | ✗   |
| 网络 - mDNS 局域网发现 | startLocalServiceDiscovery      | ✓       | ✓   | ✓       | ✗   |
|               | stopLocalServiceDiscovery         | ✓       | ✓   | ✓       | ✗   |
|               | onLocalServiceDiscoveryStop       | ✓       | ✓   | ✓       | ✗   |
|               | offLocalServiceDiscoveryStop      | ✓       | ✓   | ✓       | ✗   |
|               | onLocalServiceFound               | ✓       | ✓   | ✓       | ✗   |
|               | offLocalServiceFound              | ✓       | ✓   | ✓       | ✗   |
|               | onLocalServiceLost                | ✓       | ✓   | ✓       | ✗   |
|               | offLocalServiceLost               | ✓       | ✓   | ✓       | ✗   |
|               | onLocalServiceResolveFail         | ✓       | ✓   | ✓       | ✗   |
|               | offLocalServiceResolveFail        | ✓       | ✓   | ✓       | ✗   |
| 网络 - UDP    | createUDPSocket                   | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.bind                    | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.close                   | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.connect                 | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.send                    | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.write                   | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.setTTL                  | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.onClose                 | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.offClose                | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.onError                 | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.offError                | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.onListening             | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.offListening            | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.onMessage               | ✓       | ✓   | ✓       | ✗   |
|               | UDPSocket.offMessage              | ✓       | ✓   | ✓       | ✗   |
| 网络 - TCP 客户端 | createTCPSocket                | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.bindWifi                | ✓       | ✗   | ✗       | ✗   |
|               | TCPSocket.close                   | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.connect                 | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.write                   | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.onBindWifi              | ✓       | ✗   | ✗       | ✗   |
|               | TCPSocket.offBindWifi             | ✓       | ✗   | ✗       | ✗   |
|               | TCPSocket.onClose                 | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.offClose                | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.onConnect               | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.offConnect              | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.onError                 | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.offError                | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.onMessage               | ✓       | ✓   | ✓       | ✗   |
|               | TCPSocket.offMessage              | ✓       | ✓   | ✓       | ✗   |
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
|               | previewImage                     | ✓       | ✓   | ✓       | ✗   |
|               | compressImage                    | ✓       | ✓   | ✓       | ✗   |
|               | chooseImage                      | ✓       | ✓   | ✓       | ✗   |
| 媒体 - 视频   | chooseMedia                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 联系人 | chooseContact                    | ✓       | ✓   | ✓       | ✗   |
|               | addPhoneContact                  | ✓       | ✓   | ✓       | ✗   |
| 设备 - 剪贴板 | setClipboardData                 | ✓       | ✓   | ✓       | ✓   |
|               | getClipboardData                 | ✓       | ✓   | ✓       | ✓   |
| 设备 - 震动   | vibrateShort                     | ✓       | ✓   | ✓       | ✗   |
|               | vibrateLong                      | ✓       | ✓   | ✓       | ✗   |
| 设备 - 键盘   | hideKeyboard                     | ✓       | ✓   | ✓       | ✗   |
| 设备 - 网络   | getNetworkType                   | ✓       | ✓   | ✓       | ✓   |
| 设备 - 电话   | makePhoneCall                    | ✓       | ✓   | ✓       | ✗   |
| 设备 - 屏幕   | onUserCaptureScreen              | ✗       | ✗   | ✓       | ✗   |
|               | offUserCaptureScreen             | ✗       | ✗   | ✓       | ✗   |
| 第三方扩展    | extBridge                        | ✓       | ✓   | ✓       | ✓   |
|               | extOnBridge                      | ✓       | ✓   | ✓       | ✓   |
|               | extOffBridge                     | ✓       | ✓   | ✓       | ✓   |

补充说明：

- 该表是当前确认的兼容性基线。service 中存在某个 API 入口，不代表四个平台都已完成容器实现。
- `getUpdateManager` 只负责更新状态通知和重启入口，包下载、校验和动态下发流程请参考[小程序包更新说明](./MiniProgram-Update.md)。
- HarmonyOS 系统 socket 的绑定接口本身是异步的；`UDPSocket.bind()` 未指定端口时会先选定并同步返回一个临时端口，最终绑定成功以 `onListening` 为准，端口冲突等失败通过 `onError` 返回。Android 与 iOS 会直接返回内核实际绑定的端口。

## 第三方扩展 Bridge

第三方扩展 Bridge 允许宿主向小程序暴露自定义能力，小程序通过 `wx.extBridge`、`wx.extOnBridge`、`wx.extOffBridge` 三个 API 与之通信，无需修改框架核心代码。

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
宿主扩展模块
```

### wx.extBridge

**用途**：向指定宿主扩展模块发起一次性调用，支持异步回调。

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

### wx.extOnBridge

**用途**：订阅宿主扩展模块的持续事件推送（如传感器数据、登录状态变化等）。每次事件触发时 `callBack` 都会被调用，直到主动调用 `wx.extOffBridge` 或小程序销毁为止。

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

### 宿主接入：注册扩展模块

宿主只需调用对应平台的注册 API，实现一个处理函数即可。同一个处理函数同时承载 `extBridge`（一次性）和 `extOnBridge`（持续订阅）两种场景：

- **一次性调用**：执行后调用 `success` / `fail`，函数返回 `void` / `null` / `nil`。
- **持续订阅**：启动事件监听，**返回取消函数**；框架在 `extOffBridge` 或小程序销毁时自动调用。

宿主处理器需要自行校验 `module`、`event` 和 `data`，并在调用敏感能力前完成权限与业务身份检查。不要把任意方法反射或文件路径直接暴露给小程序。

#### Web 扩展模块

以下示例针对仓库内 Web 容器；`@dimina/container` 当前是私有 workspace 包，外部宿主需要提供等价的注册入口。

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

#### Android 扩展模块

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

#### Harmony 扩展模块

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

#### iOS 扩展模块

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

### 生命周期说明

| 时机                   | 行为                                       |
|------------------------|--------------------------------------------|
| `wx.extOnBridge` 调用  | 框架调用宿主处理函数，保存返回的取消函数      |
| `wx.extOffBridge` 调用 | 框架执行取消函数，清除订阅记录               |
| 重复订阅同一事件        | 框架自动先取消旧订阅，再建立新订阅           |
| 小程序销毁             | 框架执行所有未取消的订阅的取消函数，防止泄漏  |
