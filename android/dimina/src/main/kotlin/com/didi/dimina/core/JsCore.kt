package com.didi.dimina.core

import android.os.Handler
import android.os.Looper
import com.didi.dimina.common.JavaScriptUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.engine.qjs.QuickJSEngine
import org.json.JSONObject

/**
 * JsCore class provides a centralized management of JavaScript engine functionality.
 * It encapsulates the QuickJS engine initialization, evaluation, and cleanup.
 *
 * Author: Doslin
 */
class JsCore {
    private val tag = "JsCore"
    private lateinit var jsEngine: QuickJSEngine
    private val mainHandler = Handler(Looper.getMainLooper())
    private val runtimeMessageQueue = RuntimeMessageQueue { action ->
        mainHandler.post(action)
    }
    private val appVisibilityLedger = AppVisibilityLedger()
    // 记录所有已加载的 JS 文件路径
    private val loadedJsPaths = mutableSetOf<String>()

    /**
     * Initialize the JavaScript engine
     * @param callback Optional callback to be notified when initialization is complete
     * @return true if initialization was successful, false otherwise
     */
    fun init(callback: ((Boolean) -> Unit)? = null): Boolean {
        // Create and initialize the QuickJS engine
        jsEngine = QuickJSEngine()
        val initialized = jsEngine.initialize()
        LogUtils.d(tag, "QuickJS engine initialized: $initialized")
        // Notify callback if provided
        callback?.invoke(initialized)

        return initialized
    }

    /**
     * Execute JavaScript code synchronously and return the result
     * This method blocks the calling thread until the result is available
     *
     * @param scriptPath The JavaScript code to evaluate
     * @return The result of the evaluation
     */
    fun evaluate(script: String): JSValue {
        if (!isInitialized()) {
            return JSValue.createError("Engine not initialized")
        }
        return jsEngine.evaluate(script)
    }

    fun evaluateFromFile(scriptPath: String): JSValue {
        if (!isInitialized()) {
            return JSValue.createError("Engine not initialized")
        }

        // 检查是否已经加载过该文件
        if (!loadedJsPaths.contains(scriptPath)) {
            val result = jsEngine.evaluateFromFile(scriptPath)
            loadedJsPaths.add(scriptPath)
            LogUtils.d(tag, "Loaded new JS file: $scriptPath")
            return result
        }

        LogUtils.d(tag, "Reusing already loaded JS file: $scriptPath")
        return JSValue.createUndefined()
    }

    /**
     * 在逻辑线程注册消息处理监听器 invoke
     * 注册后，JavaScript 可以通过 DiminaServiceBridge.invoke(message) 调用此方法
     * @param handler 处理从 JavaScript 接收到的消息的回调函数
     */
    fun invoke(id: String, handler: (JSONObject) -> JSValue?) {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot register invoke handler: Engine not initialized")
            return
        }

        // 添加 QuickJSEngine 的 invoke 回调，而不是覆盖
        jsEngine.setInvokeCallback(id, handler)
        LogUtils.d(tag, "Added invoke handler")
    }

    /**
     * 移除消息处理监听器 invoke
     * @param handler 要移除的回调函数
     * @return 如果成功移除返回 true，否则返回 false
     */
    fun removeInvoke(id: String, handler: (JSONObject) -> JSValue?): Boolean {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot remove invoke handler: Engine not initialized")
            return false
        }

        val result = jsEngine.removeInvokeCallback(id, handler)
        if (result) {
            LogUtils.d(tag, "Removed invoke handler")
        }
        return result
    }

    /**
     * 移除所有消息处理监听器 invoke
     */
    fun clearInvoke() {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot clear invoke handlers: Engine not initialized")
            return
        }

        jsEngine.clearInvokeCallbacks()
        LogUtils.d(tag, "Cleared all invoke handlers")
    }

    /**
     * 在逻辑线程注册消息中转监听器 publish
     * 注册后，JavaScript 可以通过 DiminaServiceBridge.publish(message) 调用此方法
     * @param handler 处理从 JavaScript 接收到的消息的回调函数
     */
    fun publish(id: String, handler: (JSONObject) -> Unit) {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot register publish handler: Engine not initialized")
            return
        }

        // 添加 QuickJSEngine 的 publish 回调，而不是覆盖
        jsEngine.setPublishCallback(id, handler)
        LogUtils.d(tag, "Added publish handler")
    }

    /**
     * 移除消息中转监听器 publish
     * @param handler 要移除的回调函数
     * @return 如果成功移除返回 true，否则返回 false
     */
    fun removePublish(id: String, handler: (JSONObject) -> Unit): Boolean {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot remove publish handler: Engine not initialized")
            return false
        }

        val result = jsEngine.removePublishCallback(id, handler)
        if (result) {
            LogUtils.d(tag, "Removed publish handler")
        }
        return result
    }

    /**
     * 移除所有消息中转监听器 publish
     */
    fun clearPublish() {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot clear publish handlers: Engine not initialized")
            return
        }

        jsEngine.clearPublishCallbacks()
        LogUtils.d(tag, "Cleared all publish handlers")
    }


    /**
     * 向逻辑线程发送消息
     * 这个方法可以用来从 Kotlin 向 JavaScript 发送消息
     * @param type 消息类型
     * @param body 消息内容
     */
    fun postMessage(type: String, body: Map<String, String> = emptyMap()) {
        postMessage(JavaScriptUtils.message(type, body))
    }

    fun postMessage(type: String, body: JSONObject) {
        postMessage(
            JSONObject().apply {
                put("type", type)
                put("body", body)
            }.toString()
        )
    }

    fun postMessage(msg: String) {
        if (!isInitialized()) {
            LogUtils.e(tag, "Cannot post message: Engine not initialized")
            return
        }
        val accepted = runtimeMessageQueue.post {
            // Immediate teardown may close the engine independently of this queued action.
            if (isInitialized()) {
                jsEngine.evaluate(JavaScriptUtils.invokeWithJson("DiminaServiceBridge.onMessage", msg))
            }
        }
        if (!accepted) {
            LogUtils.d(tag, "Dropping message after runtime teardown was scheduled")
        }
    }

    @Synchronized
    fun appShow(options: JSONObject? = null) {
        dispatchAppVisibility(appVisibilityLedger.onShow(options))
    }

    @Synchronized
    fun appHide() {
        dispatchAppVisibility(appVisibilityLedger.onHide())
    }

    @Synchronized
    fun notifyServiceReady() {
        dispatchAppVisibility(appVisibilityLedger.onServiceReady())
    }

    private fun dispatchAppVisibility(delivery: AppVisibilityDelivery?) {
        delivery ?: return
        if (delivery.visible) {
            val options = delivery.options
            if (options == null) {
                postMessage(type = "appShow")
            } else {
                postMessage(type = "appShow", body = options)
            }
        } else {
            postMessage(type = "appHide")
        }
    }

    /**
     * Enqueues lifecycle work behind every service message already posted to this runtime.
     * Destructive API actions use this instead of a delay so callback ordering is deterministic.
     */
    fun postAfterMessages(action: () -> Unit) {
        if (!runtimeMessageQueue.post(action)) {
            action()
        }
    }

    /**
     * Stops accepting new service messages and destroys QuickJS behind every message already
     * queued for this runtime, so App.onHide and every terminal API callback still reach the page
     * before the engine goes away.
     */
    fun destroyAfterMessages() {
        runtimeMessageQueue.closeAfterPending {
            destroyEngine()
        }
    }

    /**
     * Check if the engine is initialized
     * @return true if the engine is initialized, false otherwise
     */
    private fun isInitialized(): Boolean {
        return ::jsEngine.isInitialized && jsEngine.isInitialized()
    }

    /**
     * Release the QuickJS engine resources
     * This method should be called when the engine is no longer needed
     */
    fun destroy() {
        if (runtimeMessageQueue.closeNow()) {
            destroyEngine()
        }
    }

    private fun destroyEngine() {
        appVisibilityLedger.reset()
        if (!::jsEngine.isInitialized) return
        loadedJsPaths.clear()
        jsEngine.destroy()
    }
}
