package com.didi.dimina.core

import com.didi.dimina.bean.BridgeOptions
import com.didi.dimina.bean.MergedPageConfig
import com.didi.dimina.bean.PathInfo
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.engine.qjs.JSValue
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
    private var serviceResource: Boolean = false
    private var renderResource: Boolean = false

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
        }
        // 加载模版页面
        options.webview.loadUrl("${PathUtils.FILE_PROTOCOL}/pageFrame.html")
    }

    /**
     * Start the bridge by loading resources in both render thread and logic thread.
     */
    fun start() {
        // 通知渲染线程加载资源
        options.webview.postMessage(
            "loadResource",
            mapOf(
                "bridgeId" to id,
                "appId" to options.appId,
                "pagePath" to options.pathInfo.pagePath,
                "root" to options.root
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
                    mapOf(
                        "bridgeId" to id,
                        "appId" to options.appId,
                        "pagePath" to options.pathInfo.pagePath,
                        "root" to options.root
                    )
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

        val body = msg.getJSONObject("body")
        val bridgeId = body.optString("bridgeId")

        if (bridgeId.isNotEmpty() && bridgeId != id) {
            return JSValue.createUndefined()
        }

        val type = msg.getString("type")
        val target = msg.getString("target")
        LogUtils.d(tag, "[容器]接收到的消息 $source: $msg")

        // Create transMsg object
        val transMsg = JSONObject().apply {
            put("type", type)
            put("body", JSONObject().apply {
                put("bridgeId", id)
                put("pagePath", options.pathInfo.pagePath)
                put("scene", options.scene)
                put("query", options.pathInfo.query)
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
                        this.serviceResource = true
                        if (isResourceLoaded()) {
                            transMsg.put("type", "resourceLoaded")
                        } else {
                            return null
                        }
                    }

                    "renderResourceLoaded" -> {
                        this.renderResource = true
                        if (isResourceLoaded()) {
                            transMsg.put("type", "resourceLoaded")
                        } else {
                            return null
                        }
                    }
                }
                options.jscore.postMessage(transMsg.toString())
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
        }
        return null
    }

    /**
     * 消息中转
     */
    private fun messagePublish(msg: JSONObject) {
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

    fun appShow() {
        if (!isResourceLoaded()) {
            return
        }
        options.jscore.postMessage(type="appShow")
    }

    fun appHide() {
        if (!isResourceLoaded()) {
            return
        }
        options.jscore.postMessage(type="appHide")
    }

    fun pageShow() {
        if (!isResourceLoaded()) {
            return
        }
        options.jscore.postMessage("pageShow", mapOf("bridgeId" to id))
    }

    fun pageHide() {
        if (!isResourceLoaded()) {
            return
        }
        options.jscore.postMessage("pageHide", mapOf("bridgeId" to id))
    }

    fun destroy(keepHandler: Boolean = false) {
        if (!isResourceLoaded()) {
            return
        }
        // 重置资源加载状态
        serviceResource = false
        renderResource = false

        // 发送页面卸载消息
        options.jscore.postMessage("pageUnload", mapOf("bridgeId" to id))

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
            return MiniApp.getInstance().invokeAPI(
                appId = options.appId,
                context = parent,
                apiName = apiName,
                params = params
            ) { response ->
                // Send response back to JavaScript
                options.jscore.postMessage(response)
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