package com.didi.dimina.api

import com.didi.dimina.common.ApiUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject


sealed class APIResult
data class SyncResult(val value: JSValue) : APIResult() // 同步结果
data class AsyncResult(val value: JSONObject) : APIResult() // 异步结果
data class NoneResult(val value: Any? = null) : APIResult() // 无结果

/**
 * Base interface for all API handlers 所有API处理程序的基本接口
 * Author: Doslin
 */
interface ApiHandler {
    /**
     * Handles an API call 处理API调用
     *
     * @param params Parameters for the API call
     * @return True if API was successfully handled, false otherwise
     */
    fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult

}

/**
 * Abstract base class for API handlers API处理程序的抽象基类
 */
abstract class BaseApiHandler : ApiHandler {

    /**
     * Set of API names that this handler can process 此处理程序可以处理的API名称集
     */
    protected open val apiNames: Set<String> = emptySet()

    override fun handleAction(activity: DiminaActivity, appId: String, apiName: String, params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return ApiUtils.createUnsupportedErrorResponse(apiName)
    }

    /**
     * Registers all API names with the registry 在注册表中注册所有API名称
     */
    fun registerWith(registry: ApiRegistry) {
        // Register each API name
        apiNames.forEach { apiName ->
            registry.register(apiName, this)
        }
    }
}
