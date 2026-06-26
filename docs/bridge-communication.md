# Dimina Bridge Communication Architecture

## Overview

Dimina uses a三层架构:

```
+-------------------+       +-------------------+       +-------------------+
|   Service Layer   | <---> |  Container Layer   | <---> |   Render Layer    |
|   (JS Engine)     |       |     (Native)       |       |    (WebView)      |
+-------------------+       +-------------------+       +-------------------+
```

- **Service**: 运行小程序业务逻辑的 JS 引擎（QuickJS / JavaScriptCore / Web Worker）
- **Container**: 原生容器层，提供系统能力与 API 调度
- **Render**: WebView 渲染层，负责 UI 展示

每层通过全局 Bridge 对象通信：
- Service 侧: `DiminaServiceBridge`
- Render 侧: `window.DiminaRenderBridge`

---

## Message Protocol

### 统一消息格式

```typescript
interface BridgeMessage {
  type: string        // 消息类型
  body: object        // 消息体
  target: string      // 目标层: 'container' | 'service' | 'render'
}
```

### 消息类型 (type)

| type | 方向 | 说明 |
|------|------|------|
| `invokeAPI` | Service/Render → Container | 调用原生 API |
| `triggerCallback` | Container → Service/Render | 触发 JS 回调 |
| `publish` | Service ↔ Render（经 Container 中转） | 层间消息转发 |
| `loadResource` | Container → Render | 加载页面资源 |
| `domReady` | Render → Container | 页面 DOM 就绪 |
| `pageShow` / `pageHide` / `pageUnload` | Container → Service | 页面生命周期 |

---

## 1. Service → Container (invokeAPI)

### 调用方式

```javascript
// fe/packages/service/src/core/message.js
DiminaServiceBridge.invoke(msg)   // 同步调用，阻塞等待结果
DiminaServiceBridge.publish(webViewId, msg)  // 异步发送，不等待
```

### invokeAPI 参数规范

```typescript
// Service 调用原生 API 的消息格式
{
  type: 'invokeAPI',
  target: 'container',
  body: {
    name: string,         // API 名称，如 'showToast', 'FileSystemManager.readFile'
    bridgeId: number,     // Bridge 实例 ID（用于多页面路由）
    params: {
      // API 具体参数（因 API 而异）
      [key: string]: any,
      // 回调函数会被替换为 UUID 字符串
      success?: string,   // success 回调 UUID
      fail?: string,      // fail 回调 UUID
      complete?: string,  // complete 回调 UUID
    }
  }
}
```

### 回调机制

```javascript
// fe/packages/common/src/core/callback.js
// 1. 调用前：将回调函数存入 registry，获得 UUID
const cbId = callback.store(opts.success)  // → 'cb_xxxx-xxxx'

// 2. 发送消息时，success/fail/complete 字段为 UUID 字符串
params.success = cbId

// 3. 容器处理完成后，发送 triggerCallback
// 4. Service 收到后，通过 UUID 查找并执行回调
callback.invoke(cbId, resultData)
```

### 各平台 Service Bridge 注入实现

| 平台 | 文件 | 机制 |
|------|------|------|
| **Harmony** | `harmony/.../js_thread.cpp` | QuickJS C++ 注入全局 `DiminaServiceBridge` 对象，`invoke` 通过 `napi_threadsafe_function` 同步调用主线程 |
| **iOS** | `iOS/.../DMPEngineInvoke.swift` | JavaScriptCore `setObject(_:forKeyedSubscript:)` 注入 block |
| **Android** | `android/.../qjs.cpp` | QuickJS C++ `JS_SetPropertyStr` 注入 `invoke`/`publish` 函数，通过 JNI 回调 Kotlin |
| **Browser** | `fe/packages/service/src/core/message.js` | Web Worker `postMessage` / `onmessage` |

### 平台实现细节

**Harmony** (`harmony/dimina/src/main/cpp/js_thread.cpp`):
```cpp
// invoke 是同步的：JS 线程阻塞，通过 napi_threadsafe_function 将调用切到主线程
static JSValue invoke(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    napi_call_threadsafe_function(tsfn, asyncContext, call_mode);
    JSValue result = asyncContext->promise.get_future().get(); // 阻塞等待
    return result;
}
```

**iOS** (`iOS/dimina/DiminaKit/Service/DMPEngineInvoke.swift`):
```swift
let invoke: @convention(block) (JSValue) -> JSValue? = { d in
    let msg = d.toDictionary()
    let result = DMPChannelProxy.messageHandler(
        type: msg["type"], body: msg["body"], target: msg["target"], app: app
    )
    if let syncResult = result as? DMPSyncResult {
        return DMPBridgeParam.from(rawValue: syncResult.value).getJSValue(context: context)
    }
    return JSValue(nullIn: context)
}
bridge?.setObject(invoke, forKeyedSubscript: "invoke" as NSString)
```

**Android** (`android/engine_qjs/src/main/cpp/qjs.cpp`):
```cpp
// 注入全局对象
JS_SetPropertyStr(ctx, global, "DiminaServiceBridge", bridge);
JS_SetPropertyStr(ctx, bridge, "invoke",
    JS_NewCFunction(ctx, js_dimina_invoke, "invoke", 1));
JS_SetPropertyStr(ctx, bridge, "publish",
    JS_NewCFunction(ctx, js_dimina_publish, "publish", 2));
```

---

## 2. Container → Service (triggerCallback / events)

### 调用方式

容器通过执行 JS 脚本将消息传递给 Service 层：

```javascript
DiminaServiceBridge.onMessage(data)
```

### triggerCallback 参数规范

```typescript
{
  type: 'triggerCallback',
  body: {
    callbackId: string,   // 对应 invokeAPI 时传入的回调 UUID
    args: {
      errMsg: string,     // 'apiName:ok' 或 'apiName:fail reason'
      [key: string]: any  // API 返回数据
    }
  }
}
```

### 各平台实现

| 平台 | 文件 | 方法 |
|------|------|------|
| **Harmony** | `harmony/.../DMPService.ets` | `executeScript("DiminaServiceBridge.onMessage(${dataString})")` |
| **iOS** | `iOS/.../DMPService.swift` | `evaluateScript("DiminaServiceBridge.onMessage(\(dataString))")` |
| **Android** | `android/.../JsCore.kt` | `jsEngine.evaluate("DiminaServiceBridge.onMessage($msg)")` |

**Harmony** (`harmony/dimina/src/main/ets/Service/DMPService.ets`):
```typescript
public fromContainerNext(data: DMPMap) {
    const dataString = data.toStr()
    const script: string = `DiminaServiceBridge.onMessage(${dataString})`
    this.executeScript(script)
}
```

**iOS** (`iOS/dimina/DiminaKit/Service/DMPService.swift`):
```swift
public func postMessage(data: DMPMap) async {
    let dataString = data.toJsonString()
    let script = "DiminaServiceBridge.onMessage(\(dataString))"
    await self.evaluateScript(script)
}
```

**Android** (`android/dimina/src/main/kotlin/com/didi/dimina/core/JsCore.kt`):
```kotlin
fun postMessage(msg: String) {
    mainHandler.post {
        jsEngine.evaluate("DiminaServiceBridge.onMessage($msg)")
    }
}
```

---

## 3. Render → Container (invokeAPI / publish)

### 调用方式

```javascript
// fe/packages/render/src/core/message.js
window.DiminaRenderBridge.invoke(msg)    // 调用容器 API
window.DiminaRenderBridge.publish(msg)   // 发消息到 Service 层
```

### invokeAPI 参数规范（同 Service 侧）

```typescript
{
  type: 'invokeAPI',
  target: 'container',
  body: {
    name: string,
    bridgeId: number,
    params: { ... }
  }
}
```

### publish 参数规范

```typescript
// Render → Service 的消息（经 Container 中转）
{
  type: string,           // 自定义事件类型
  target: 'service',
  body: {
    bridgeId: number,
    [key: string]: any
  }
}
```

### 平台差异：invoke 传参序列化

```javascript
// fe/packages/render/src/core/message.js
if (isAndroid || isIOS) {
    // Android/iOS: WebView bridge 只接受字符串
    window.DiminaRenderBridge.invoke(JSON.stringify(msg))
} else {
    // Harmony: JavaScriptProxy 支持直接传对象
    window.DiminaRenderBridge.invoke(msg)
}
```

### 各平台 Render Bridge 注入实现

| 平台 | 文件 | 机制 |
|------|------|------|
| **Harmony** | `harmony/.../DMPWebViewProxy.ets` | `javaScriptProxy` 注册 `DiminaRenderBridge`，`invoke` 同步 / `publish` 异步 |
| **iOS** | `iOS/.../DMPWebViewInvoke.swift` | `WKScriptMessageHandler` + JS 注入 `window.DiminaRenderBridge` |
| **Android** | `android/.../DiminaWebView.kt` | `@JavascriptInterface` + `addJavascriptInterface` |

### 平台实现细节

**Harmony** (`harmony/dimina/src/main/ets/HybridContainer/DMPWebViewProxy.ets`):
```typescript
export class DMPWebViewProxy {
    // 同步方法：直接返回结果
    invoke(msg: Message): number | string | boolean | object {
        return DMPChannelProxyNext.messageHandlerNext(
            msg.type, DMPMap.createFromObject(msg.body), msg.target, app
        )
    }
    // 异步方法：转发到 Service
    async publish(msg: string) {
        DMPChannelProxyNext.RenderToService(msg, app)
    }
}

// 注册为 JavaScriptProxy
{
    object: this.webViewProxy,
    name: "DiminaRenderBridge",
    methodList: ["invoke"],          // 同步
    asyncMethodList: ["publish"]     // 异步
}
```

**iOS** (`iOS/dimina/DiminaKit/Render/DMPWebViewInvoke.swift`):
```swift
// 通过 WKScriptMessageHandler 接收消息
webview.registerJSHandler(handlerName: "invokeHandler") { data in
    let messageDict = parseJSON(data as! String)
    let result = self.processInvokeMessage(...)
    // 通过 evaluateJavaScript 回调结果
    let script = "window['\(callbackId)'](\(resultJson))"
    self.render?.executeJavaScript(webViewId: webViewId, script)
}

// JS 侧注入的 Bridge（invoke 返回 Promise）
window.DiminaRenderBridge.invoke = function(msg) {
    return new Promise(function(resolve) {
        var callbackId = 'cb_' + Date.now() + '_' + Math.random();
        window[callbackId] = function(result) {
            resolve(result);
            delete window[callbackId];
        };
        window.webkit.messageHandlers.invokeHandler.postMessage(msg);
    });
};
```

**Android** (`android/dimina/src/main/kotlin/com/didi/dimina/ui/view/DiminaWebView.kt`):
```kotlin
class DiminaRenderBridge(
    private val invokeHandler: (JSONObject) -> Unit,
    private val publishHandler: (JSONObject) -> Unit
) {
    @JavascriptInterface
    fun invoke(message: String) {
        this.invokeHandler(JSONObject(message))
    }
    @JavascriptInterface
    fun publish(message: String) {
        this.publishHandler(JSONObject(message))
    }
}

// 注入 WebView
webview.addJavascriptInterface(bridge, "DiminaRenderBridge")
```

---

## 4. Container → Render (triggerCallback / events)

### 调用方式

容器通过执行 JS 脚本将消息传递给 Render 层：

```javascript
DiminaRenderBridge.onMessage(data)
```

### 参数规范（同 Container → Service）

```typescript
{
  type: 'triggerCallback',
  body: {
    callbackId: string,
    args: { ... }
  }
}
```

### 各平台实现

| 平台 | 文件 | 方法 |
|------|------|------|
| **Harmony** | `harmony/.../DMPRender.ets` | `controller.runJavaScript("DiminaRenderBridge.onMessage(${dataString})")` |
| **iOS** | `iOS/.../DMPRender.swift` | `webView.evaluateJavaScript("DiminaRenderBridge.onMessage(\(dataString))")` |
| **Android** | `android/.../DiminaWebView.kt` | `webView.evaluateJavascript("DiminaRenderBridge.onMessage($msg)")` |

**Harmony** (`harmony/dimina/src/main/ets/Render/DMPRender.ets`):
```typescript
public fromContainerNext(data: DMPMap, webViewId: number) {
    const dataString = data.toStr()
    this.executeScript(`DiminaRenderBridge.onMessage(${dataString})`, webViewId)
}

executeScript(script: string, webViewId: number) {
    controller.runJavaScript(script, callback)
}
```

**iOS** (`iOS/dimina/DiminaKit/Render/DMPRender.swift`):
```swift
public func fromContainer(data: DMPMap, webViewId: Int) {
    let dataString = data.toJsonString()
    DispatchQueue.main.async {
        webview?.executeJavaScript("DiminaRenderBridge.onMessage(\(dataString))")
    }
}
```

**Android** (`android/dimina/src/main/kotlin/com/didi/dimina/ui/view/DiminaWebView.kt`):
```kotlin
fun WebView.postMessage(msg: String, callback: ((String?) -> Unit)? = null) {
    this.evaluateJavascript("DiminaRenderBridge.onMessage($msg)", callback)
}
```

---

## 5. 消息路由 (Channel Proxy)

Container 层统一路由所有消息，各平台实现类似的 ChannelProxy：

| 平台 | 路由文件 |
|------|---------|
| **Harmony** | `harmony/.../DMPChannelProxyNext.ets` |
| **iOS** | `iOS/.../DMPChannelProxy.swift` |
| **Android** | `android/.../Bridge.kt` |

### 路由逻辑

```
收到消息 → 解析 type & target
  ├─ target == 'container' → 查找并调用对应 Module 的方法
  ├─ target == 'service'   → 转发到 Service 层
  └─ target == 'render'    → 转发到 Render 层（指定 webViewId）
```

### Harmony 路由实现 (`DMPChannelProxyNext.ets`):
```typescript
static messageHandlerNext(type: string, body: DMPMap, target: string, app: DMPApp) {
    if (target === 'container') {
        const methodName = body.get('name')
        const module = app._appModuleManager.getModuleObjectByMethodName(methodName)
        return module[methodName](body.get('params'), callback)
    }
}

static RenderToService(msg: string, app: DMPApp) {
    app._service.fromContainerNext(DMPMap.createFromJsonString(msg))
}
```

---

## 6. Callback 生命周期

```
┌──────────────┐     invokeAPI        ┌──────────────┐
│  Service/    │  {success: 'cb_123'} │  Container   │
│  Render      │ ──────────────────>  │  (Native)    │
│              │                      │              │
│ callbacks:   │                      │  处理 API     │
│  'cb_123' → fn                     │  调用         │
│              │  triggerCallback     │              │
│              │  {callbackId:'cb_123'│              │
│              │   args: {data:...}} │              │
│  执行 fn(args)│ <────────────────── │              │
│  删除 cb_123  │                      │              │
└──────────────┘                      └──────────────┘
```

### Callback 存储 (`fe/packages/common/src/core/callback.js`)

```javascript
class Callback {
    // 存储回调，返回 UUID
    store(callback, keep = false, evtId = uuid()) {
        this.callbacks[evtId] = { callback, keep }
        return evtId   // 如 'cb_xxxx-xxxx-xxxx'
    }

    // 执行回调
    invoke(evtId, args) {
        const obj = this.callbacks[evtId]
        if (obj && isFunction(obj.callback)) {
            obj.callback(args)
            if (!obj.keep) {
                delete this.callbacks[evtId]  // 一次性回调用完即删
            }
        }
    }
}
```

- `keep = false`：一次性回调（success/fail/complete），触发后删除
- `keep = true`：持久监听（如 `onSocketMessage`），不自动删除

---

## 7. 线程模型

| 平台 | Service 线程 | Render 线程 | 通信方式 |
|------|-------------|-------------|---------|
| **Harmony** | Worker 线程 (QuickJS) | 主线程 (WebView) | `napi_threadsafe_function` 跨线程 |
| **iOS** | 独立 Thread + RunLoop (JSC) | 主线程 (WKWebView) | GCD dispatch |
| **Android** | QuickJS 引擎线程 | 主线程 (WebView) | JNI + Handler |
| **Browser** | Web Worker | 主线程 | `postMessage` / `onmessage` |

---

## 8. 完整调用流程示例

### 示例: `wx.readFile()` 完整链路

```
1. [Service JS] wx.getFileSystemManager().readFile({
       filePath: 'xxx',
       encoding: 'utf-8',
       success(res) { console.log(res.data) },
       fail(err) { console.error(err) }
   })

2. [FE invokeAPI] 将 success/fail 存入 callback registry
   → success UUID: 'cb_a1b2c3'
   → fail UUID: 'cb_d4e5f6'

3. [FE message.invoke] DiminaServiceBridge.invoke({
       type: 'invokeAPI',
       target: 'container',
       body: {
           name: 'FileSystemManager.readFile',
           bridgeId: 1,
           params: {
               filePath: 'xxx',
               encoding: 'utf-8',
               success: 'cb_a1b2c3',
               fail: 'cb_d4e5f6'
           }
       }
   })

4. [Native ChannelProxy] 解析 name → 找到 DMPContainerBridgesModuleFileSystem
   → 调用 FileSystemManager.readFile(params, callback)

5. [Native Module] 执行文件读取 → fs.readTextSync(path)
   → 成功: invokeSuccessCallback(callback, result)

6. [Native → Service] executeScript:
   DiminaServiceBridge.onMessage({
       type: 'triggerCallback',
       body: {
           callbackId: 'cb_a1b2c3',
           args: {
               errMsg: 'readFile:ok',
               data: '文件内容...'
           }
       }
   })

7. [FE callback.invoke] 通过 'cb_a1b2c3' 找到 success 函数 → 执行
   → console.log(res.data) // '文件内容...'
   → 删除 callback entry
```
