package com.didi.dimina.api

import com.didi.dimina.common.ApiUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject


sealed class APIResult
data class SyncResult(val value: JSValue) : APIResult()
data class AsyncResult @JvmOverloads constructor(
    val value: JSONObject,
    /**
     * App/container lifecycle work that must run only after success/fail and complete have been
     * queued back to the service runtime. This keeps exit/restart from destroying the caller's
     * JsCore before those callbacks are delivered.
     */
    val afterComplete: (() -> Unit)? = null,
    /**
     * Whether `complete` must receive the same result object as success/fail. Keep the default
     * false for existing APIs whose callback shape has not opted into this contract.
     */
    val completeCarriesResult: Boolean = false,
) : APIResult()
data class NoneResult(val value: Any? = null) : APIResult()

/**
 * Base interface for all API handlers
 * Author: Doslin
 */
interface ApiHandler {
    /**
     * Handles an API call
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
 * Abstract base class for API handlers
 */
abstract class BaseApiHandler : ApiHandler {

    /**
     * Set of API names that this handler can process
     */
    protected open val apiNames: Set<String> = emptySet()
    
    override fun handleAction(activity: DiminaActivity, appId: String, apiName: String, params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return ApiUtils.createUnsupportedErrorResponse(apiName)
    }

    /**
     * Registers all API names with the registry
     */
    fun registerWith(registry: ApiRegistry) {
        // Register each API name
        apiNames.forEach { apiName ->
            registry.register(apiName, this)
        }
    }
}
