package com.didi.dimina.common

import com.didi.dimina.api.AsyncResult
import org.json.JSONObject

/**
 * Utility functions for API operations
 */
object ApiUtils {
    /**
     * Creates a standardized error response with multiple error messages
     * @param errorMessage Primary error message
     * @param additionalErrors Optional additional error messages
     * @return JSONObject containing error information
     */
    fun createErrorResponse(
        apiName: String,
        errorMessage: String,
        vararg additionalErrors: String,
    ): AsyncResult {
        val allErrors = mutableListOf(errorMessage)
        allErrors.addAll(additionalErrors)
        return AsyncResult(JSONObject().apply {
            put("errMsg", "$apiName:fail $errorMessage ${allErrors.joinToString(";;")}")
        })
    }

    fun createUnsupportedErrorResponse(apiName: String): AsyncResult {
        return createErrorResponse(apiName, apiName,"api is not supported")
    }

    /**
     * Creates a callback response for JavaScript
     * @param callbackId The ID of the callback function
     * @param result The result to pass to the callback
     * @return The formatted response string
     */
    fun createCallbackResponse(callbackId: String, result: JSONObject? = null): String {
        val response = JSONObject().apply {
            put("type", "triggerCallback")
            put("body", JSONObject().apply {
                put("id", callbackId)
                if (result != null) {
                    put("args", result)
                }
            })
        }
        return response.toString()
    }

    fun invokeSuccess(params: JSONObject, resultData: JSONObject, responseCallback: (String) -> Unit) {
        val successCallback = params.optString("success", "")
        if (successCallback.isNotEmpty()) {
            responseCallback(
                createCallbackResponse(
                    successCallback,
                    resultData
                )
            )
        }
    }

    fun invokeFail(params: JSONObject, resultData: JSONObject, responseCallback: (String) -> Unit) {
        val failCallBack = params.optString("fail", "")
        if (failCallBack.isNotEmpty()) {
            responseCallback(
                createCallbackResponse(
                    failCallBack,
                    resultData
                )
            )
        }
    }

    /**
     * Triggers the caller's `complete` callback.
     *
     * [resultData] is the result object `complete` receives, and must be the same one that was
     * handed to whichever of [invokeSuccess]/[invokeFail] ran: mini programs read `res.errMsg`
     * inside `complete`, so invoking it with no result hands them `undefined` and
     * `complete: res => res.errMsg` throws instead of running.
     *
     * It stays optional so that APIs which have not yet been given a result to mirror keep their
     * existing no-argument behavior rather than silently changing shape.
     */
    @JvmOverloads
    fun invokeComplete(
        params: JSONObject,
        responseCallback: (String) -> Unit,
        resultData: JSONObject? = null,
    ) {
        val completeCallBack = params.optString("complete", "")
        if (completeCallBack.isNotEmpty()) {
            responseCallback(
                createCallbackResponse(
                    completeCallBack,
                    resultData
                )
            )
        }
    }
}
