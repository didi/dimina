package com.didi.dimina.api

import com.didi.dimina.api.ext.ExtBridgeApi
import com.didi.dimina.api.ext.ExtModuleHandler
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * API Registry to manage all API handlers
 * Author: Doslin
 */
class ApiRegistry {
    private val tag = "ApiRegistry"
    private val apiHandlers = mutableMapOf<String, ApiHandler>()

    // 宿主注册的第三方扩展模块，key=moduleName
    private val extModules = mutableMapOf<String, ExtModuleHandler>()

    // extBridge 一次性调用的处理器，共享 extModules 引用
    private val extBridgeApi by lazy { ExtBridgeApi(extModules) }

    // extOnBridge 持续订阅的取消函数，key="${module}_${event}"
    private val extSubscriptions = mutableMapOf<String, Runnable>()

    /**
     * Registers an API handler
     */
    fun register(name: String, handler: ApiHandler) {
        apiHandlers[name] = handler
    }

    /**
     * 注册第三方扩展 bridge 模块
     * @param moduleName 模块名，对应 extBridge/extOnBridge 的 module 参数
     * @param handler    模块处理器
     */
    fun registerExtModule(moduleName: String, handler: ExtModuleHandler) {
        extModules[moduleName] = handler
        LogUtils.d(tag, "Registered ext module: $moduleName")
    }

    /**
     * Invokes an API
     *
     * @param apiName The name of the API to invoke
     * @param params Parameters for the API call
     * @return True if API was successfully invoked, false otherwise
     */
    fun invoke(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        // 1. 优先命中已注册的标准 API
        apiHandlers[apiName]?.let { handler ->
            return handler.handleAction(activity, appId, apiName, params, responseCallback)
        }

        // 2. extBridge：未命中且 params 携带 "module" 字段
        if (params.has("module")) {
            return extBridgeApi.handleAction(activity, appId, apiName, params, responseCallback)
        }

        // 3. extOnBridge / extOffBridge：apiName 格式为 "${module}_${event}"
        val matchedModule = extModules.keys.firstOrNull { apiName.startsWith("${it}_") }
        if (matchedModule != null) {
            val event = apiName.removePrefix("${matchedModule}_")
            val successId = params.optString("success", "")
            return if (successId.isNotEmpty()) {
                handleExtOnBridge(matchedModule, event, apiName, params, successId, responseCallback)
            } else {
                handleExtOffBridge(apiName)
                NoneResult()
            }
        }

        LogUtils.e(tag, "API not found: $apiName")
        return NoneResult()
    }

    /**
     * 处理 extOnBridge：启动持续订阅，保存取消函数
     */
    private fun handleExtOnBridge(
        module: String,
        event: String,
        eventKey: String,
        params: JSONObject,
        successCallbackId: String,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val handler = extModules[module] ?: return NoneResult()

        // 若已有相同订阅，先取消旧的
        extSubscriptions.remove(eventKey)?.run()

        val callback = object : com.didi.dimina.api.ext.ExtCallback {
            override fun onSuccess(result: JSONObject) {
                responseCallback(ApiUtils.createCallbackResponse(successCallbackId, result))
            }

            override fun onFail(error: JSONObject) {
                LogUtils.e(tag, "extOnBridge error ($eventKey): $error")
            }
        }

        val unsubscribe = handler.handle(event, JSONObject(), callback)
        if (unsubscribe != null) {
            extSubscriptions[eventKey] = unsubscribe
        }
        return NoneResult()
    }

    /**
     * 处理 extOffBridge：取消持续订阅
     */
    private fun handleExtOffBridge(eventKey: String) {
        extSubscriptions.remove(eventKey)?.run()
        LogUtils.d(tag, "extOffBridge: cancelled subscription for $eventKey")
    }

    /**
     * 取消所有持续订阅（小程序销毁时调用）
     */
    fun clearExtSubscriptions() {
        extSubscriptions.values.forEach { it.run() }
        extSubscriptions.clear()
    }
    
    /**
     * Clears all API handlers
     */
    fun clear() {
        apiHandlers.clear()
    }
    
    /**
     * Gets a set of all registered API names
     * 
     * @return Set of all registered API names
     */
    fun getRegisteredApiNames(): Set<String> {
        return apiHandlers.keys
    }
}
