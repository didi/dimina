package com.didi.dimina.core

import com.didi.dimina.Dimina
import com.didi.dimina.bean.BridgeOptions
import com.didi.dimina.bean.MergedPageConfig
import com.didi.dimina.bean.PathInfo
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.common.VersionUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.view.DiminaNativeComponentBridge
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.view.DiminaRenderBridge
import com.didi.dimina.ui.view.postMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Author: Doslin
 */
class Bridge(
    val options: BridgeOptions,
    var parent: DiminaActivity,
) {
    private val tag = "Bridge"
    private val id: String = "bridge_${Utils.uuid()}"
    @Volatile
    private var serviceResource: Boolean = false
    @Volatile
    private var renderResource: Boolean = false
    @Volatile
    private var resourceLoadedForwarded: Boolean = false
    @Volatile
    private var destroyed: Boolean = false
    @Volatile
    private var resourceLoadId: String? = null
    @Volatile
    private var desiredPageVisible: Boolean? = null
    @Volatile
    private var sentPageVisible: Boolean? = null
    @Volatile
    private var pendingAppShowOptions: JSONObject? = null

    /**
     * Bridge 初始化逻辑
     */
    // 保存回调引用以便在销毁时移除
    private val serviceInvokeHandler: (JSONObject) -> JSValue? = { msg -> messageInvoke("service", msg) }
    private val servicePublishHandler: (JSONObject) -> Unit = { msg -> messagePublish(msg) }

    fun init(addHandler: Boolean = true) {
        if (addHandler) {
            options.jscore.invoke(id, serviceInvokeHandler)
            options.jscore.publish(id, servicePublishHandler)

            // Add JavaScript interface for DiminaRenderBridge
            options.webview.addJavascriptInterface(
                DiminaRenderBridge(
                    invokeHandler = { msg -> messageInvoke("render", msg) },
                    publishHandler = { msg -> messagePublish(msg) }
                ), DiminaRenderBridge.TAG)
            options.webview.addJavascriptInterface(
                DiminaNativeComponentBridge(
                    touchHandler = { msg -> parent.dispatchNativeComponentTouch(msg, this@Bridge) }
                ), DiminaNativeComponentBridge.TAG)
        }
        // 加载模版页面。调试模式通过 URL 参数让 pageFrame 在 render 初始化前启用 vConsole。
        val vConsoleQuery = if (Dimina.getInstance().isDebugMode()) "?vconsole=1" else ""
        options.webview.loadUrl(
            "${PathUtils.WEBVIEW_JSSDK_BASE_URL}${VersionUtils.getJSVersion()}/main/pageFrame.html$vConsoleQuery"
        )
    }

    /**
     * Start the bridge by loading resources in both render thread and logic thread.
     */
    fun start(visible: Boolean? = null) {
        val currentResourceLoadId = synchronized(this) {
            destroyed = false
            resourceLoadId = Utils.uuid()
            if (visible != null) {
                desiredPageVisible = visible
            } else if (desiredPageVisible == null) {
                desiredPageVisible = true
            }
            resourceLoadId!!
        }

        // 通知渲染线程加载资源
        options.webview.postMessage(
            "loadResource",
            mapOf(
                "bridgeId" to id,
                "resourceLoadId" to currentResourceLoadId,
                "appId" to options.appId,
                "runtimeType" to options.runtimeType,
                "pagePath" to options.pathInfo.pagePath,
                "root" to options.root,
                "baseUrl" to PathUtils.WEBVIEW_JSAPP_BASE_URL
            )
        )

        // 使用协程在后台线程执行耗时的JS操作
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val jsFilePath = File(
                    parent.filesDir,
                    "jsapp/${options.appId}/${options.root}/logic.js"
                ).absolutePath

                // evaluateFromFile 会自动处理重复加载的问题
                options.jscore.evaluateFromFile(jsFilePath)

                // 发送 loadResource 消息
                options.jscore.postMessage(
                    "loadResource",
                    JSONObject().apply {
                        put("bridgeId", id)
                        put("resourceLoadId", currentResourceLoadId)
                        put("appId", options.appId)
                        put("runtimeType", options.runtimeType)
                        put("pagePath", options.pathInfo.pagePath)
                        put("query", options.pathInfo.query ?: JSONObject())
                        put("scene", options.scene)
                        put("root", options.root)
                        put("baseUrl", PathUtils.WEBVIEW_JSAPP_BASE_URL)
                        options.referrerInfo?.let {
                            put("referrerInfo", JSONObject(it.toString()))
                        }
                    }
                )

                LogUtils.d(tag, "Bridge started and resources loaded in background thread")
            } catch (e: Exception) {
                LogUtils.e(tag, "Error starting bridge: ${e.message}")
            }
        }
    }

    /**
     * 消息处理
     */
    private fun messageInvoke(source: String, msg: JSONObject): JSValue? {
        if (destroyed) {
            return null
        }

        val body = msg.getJSONObject("body")
        val bridgeId = body.optString("bridgeId")

        if (bridgeId.isNotEmpty() && bridgeId != id) {
            return JSValue.createUndefined()
        }
        val incomingResourceLoadId = body.optString("resourceLoadId")
        if (incomingResourceLoadId.isNotEmpty() && incomingResourceLoadId != resourceLoadId) {
            return JSValue.createUndefined()
        }

        val type = msg.getString("type")
        val target = msg.getString("target")
        LogUtils.d(tag, "[Container] receive msg from $source: $msg")

        // Create transMsg object
        val transMsg = JSONObject().apply {
            put("type", type)
            put("body", JSONObject().apply {
                put("bridgeId", id)
                put("pagePath", options.pathInfo.pagePath)
                put("scene", options.scene)
                put("query", options.pathInfo.query)
                options.referrerInfo?.let {
                    put("referrerInfo", JSONObject(it.toString()))
                }
                // Copy all properties from original body
                for (key in body.keys()) {
                    put(key, body.get(key))
                }
            })
        }

        when (target) {
            "service" -> {
                when (type) {
                    "serviceResourceLoaded" -> {
                        if (markResourceLoaded(service = true)) {
                            transMsg.put("type", "resourceLoaded")
                        } else {
                            return null
                        }
                    }

                    "renderResourceLoaded" -> {
                        if (markResourceLoaded(service = false)) {
                            transMsg.put("type", "resourceLoaded")
                        } else {
                            return null
                        }
                    }

                    "renderResourceLoadFailed" -> {
                        synchronized(this) {
                            renderResource = false
                            resourceLoadedForwarded = false
                        }
                    }
                }
                forwardToService(transMsg)
            }

            "container" -> {
                if (type == "invokeAPI") {
                    // 调用容器侧 API
                    return handleApiInvocation(body)
                } else if (type == "domReady") {
                    // 隐藏 Loading
                    parent.onDomReady()
                }
            }

            "webview" -> {
                if (type == "invokeAPI") {
                    return handleApiInvocation(body)
                }
            }
        }
        return null
    }

    fun handleEmbeddedWebViewMessage(message: JSONObject) {
        val normalizedMessage = JSONObject(message.toString())
        val body = normalizedMessage.optJSONObject("body") ?: return
        body.put("bridgeId", id)
        if (body.has("parentWebViewId")) {
            body.put("parentWebViewId", id)
        }
        messageInvoke("webview", normalizedMessage)
    }

    /**
     * 消息中转
     */
    private fun messagePublish(msg: JSONObject) {
        if (destroyed) {
            return
        }
        val body = msg.getJSONObject("body")
        val bridgeId = body.optString("bridgeId")
        if (bridgeId.isNotEmpty() && bridgeId != id) {
            return
        }

        val target = msg.getString("target")
        if (target == "service") {
            //  转发到逻辑线程
            options.jscore.postMessage(msg.toString())
        } else if (target == "render") {
            // 转发到渲染线程
            options.webview.postMessage(msg.toString())
        }


    }

    private fun isResourceLoaded(): Boolean {
        return serviceResource && renderResource
    }

    @Synchronized
    private fun markResourceLoaded(service: Boolean): Boolean {
        if (destroyed) {
            return false
        }
        if (service) {
            serviceResource = true
        } else {
            renderResource = true
        }
        if (!isResourceLoaded() || resourceLoadedForwarded) {
            return false
        }
        resourceLoadedForwarded = true
        return true
    }

    @Synchronized
    private fun forwardToService(msg: JSONObject) {
        if (destroyed) {
            return
        }
        options.jscore.postMessage(msg.toString())
        if (msg.optString("type") == "resourceLoaded") {
            flushPendingAppShow()
            flushPageVisibility()
        }
    }

    fun appShow(enterOptions: JSONObject? = null) {
        val pending = synchronized(this) {
            if (enterOptions != null) {
                pendingAppShowOptions = JSONObject(enterOptions.toString())
            }
            if (!isResourceLoaded()) {
                return
            }
            pendingAppShowOptions.also { pendingAppShowOptions = null }
        }
        if (pending == null) {
            options.jscore.postMessage(type = "appShow")
        } else {
            postAppShow(pending)
        }
    }

    fun appHide() {
        if (!isResourceLoaded()) {
            return
        }
        options.jscore.postMessage(type="appHide")
    }

    fun pageShow() {
        desiredPageVisible = true
        flushPageVisibility()
    }

    fun pageHide() {
        desiredPageVisible = false
        flushPageVisibility()
    }

    @Synchronized
    private fun flushPageVisibility() {
        val visible = desiredPageVisible
        if (!isResourceLoaded() || visible == null || sentPageVisible == visible) {
            return
        }

        options.jscore.postMessage(
            if (visible) "pageShow" else "pageHide",
            mapOf("bridgeId" to id)
        )
        sentPageVisible = visible
    }

    private fun flushPendingAppShow() {
        val pending = synchronized(this) {
            if (!isResourceLoaded()) return
            pendingAppShowOptions.also { pendingAppShowOptions = null }
        } ?: return
        postAppShow(pending)
    }

    private fun postAppShow(enterOptions: JSONObject) {
        val body = JSONObject(enterOptions.toString()).apply {
            if (!has("pagePath")) {
                put("pagePath", options.pathInfo.pagePath)
            }
            if (!has("query")) {
                put("query", options.pathInfo.query ?: JSONObject())
            }
        }
        options.jscore.postMessage("appShow", body)
    }

    fun destroy(keepHandler: Boolean = false) {
        parent.clearNativeComponents(this)
        val wasResourceLoaded = isResourceLoaded()
        synchronized(this) {
            destroyed = true
            serviceResource = false
            renderResource = false
            resourceLoadedForwarded = false
            resourceLoadId = null
            desiredPageVisible = null
            sentPageVisible = null
            pendingAppShowOptions = null
        }

        // 发送页面卸载消息
        if (wasResourceLoaded) {
            options.jscore.postMessage("pageUnload", mapOf("bridgeId" to id))
        }

        if (!keepHandler) {
            // 移除在 init() 中添加的回调
            options.jscore.removeInvoke(id, serviceInvokeHandler)
            options.jscore.removePublish(id, servicePublishHandler)
        }

        LogUtils.d(tag, "Bridge destroyed and callbacks removed")
    }

    /**
     * Handles API invocation from JavaScript
     */
    private fun handleApiInvocation(body: JSONObject): JSValue? {
        try {
            val apiName = body.getString("name")

            // Handle params that could be either a JSONObject or a string
            val params = when {
                // Case 1: params is already a JSONObject
                body.optJSONObject("params") != null -> body.getJSONObject("params")

                // Case 2: params is a string, try to parse it as JSON
                body.has("params") -> {
                    val paramsValue = body.opt("params")
                    if (paramsValue is JSONArray) {
                        JSONObject().apply { put("args", body.optJSONArray("params"))}
                    } else {
                        JSONObject().apply { put("args", body.optString("params"))}
                    }
                }

                // Case 3: params is missing or null
                else -> JSONObject()
            }

            LogUtils.d(tag, "API invocation: $apiName with params: $params")

            // Use MiniApp to handle API invocation
            return parent.runWithBridgeContext(this) {
                MiniApp.getInstance().invokeAPI(
                    appId = options.appId,
                    context = parent,
                    apiName = apiName,
                    params = params
                ) { response ->
                    // Send response back to JavaScript
                    options.jscore.postMessage(response)
                }
            }
        } catch (e: Exception) {
            e.printStackTrace()
            LogUtils.e(tag, "Error invoking API: ${e.message}")
            return null
        }
    }

    /**
     * 更新 Bridge 的配置信息
     * @param pathInfo 新的路径信息
     * @param root 新的根路径
     * @param configInfo 新的页面配置
     */
    fun updateOptions(
        pathInfo: PathInfo,
        root: String,
        configInfo: MergedPageConfig
    ) {


        // 更新 options 中的相关配置
        options.pathInfo = pathInfo
        options.root = root
        options.configInfo = configInfo

        LogUtils.d(tag, "Bridge options updated: pathInfo=$pathInfo, root=$root")
    }
}
