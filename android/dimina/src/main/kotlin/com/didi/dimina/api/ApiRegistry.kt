package com.didi.dimina.api

import com.didi.dimina.common.LogUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * API Registry to manage all API handlers API注册表，用于管理所有API处理程序
 * Author: Doslin
 */
class ApiRegistry {
    private val tag = "ApiRegistry"
    private val apiHandlers = mutableMapOf<String, ApiHandler>()

    /**
     * Registers an API handler 注册API处理程序
     */
    fun register(name: String, handler: ApiHandler) {
        apiHandlers[name] = handler
    }

    /**
     * Invokes an API 调用API
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
        val handler = apiHandlers[apiName]
        if (handler == null) {
            LogUtils.e(tag,  "API not found 找不到api函数: $apiName")
            return NoneResult()
        }
        return handler.handleAction(activity, appId, apiName, params, responseCallback)
    }

    /**
     * Clears all API handlers
     */
    fun clear() {
        apiHandlers.clear()
    }

    /**
     * Gets a set of all registered API names 获取所有注册的API名称的集合
     *
     * @return Set of all registered API names
     */
    fun getRegisteredApiNames(): Set<String> {
        return apiHandlers.keys
    }
}
