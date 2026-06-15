package com.didi.dimina.api.device

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * Device - Scan API
 * Author: Doslin
 */
class ScanApi : BaseApiHandler() {
    private companion object {
        const val SCAN_CODE = "scanCode"
    }

    override val apiNames = setOf(SCAN_CODE)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when(apiName) {
            SCAN_CODE -> {
                val options = ScanCodeOptions.from(params)
                if (options.scanTypes.isEmpty()) {
                    ApiUtils.invokeFail(params, JSONObject().apply {
                        put("errMsg", "$SCAN_CODE:fail invalid scanType")
                    }, responseCallback)
                    ApiUtils.invokeComplete(params, responseCallback)
                    return NoneResult()
                }
                activity.handleScanCode(options) { success, result ->
                    if (success) {
                        ApiUtils.invokeSuccess(params, result, responseCallback)
                    } else {
                        ApiUtils.invokeFail(params, normalizeFailure(result), responseCallback)
                    }
                    ApiUtils.invokeComplete(params, responseCallback)
                }
                NoneResult()
            }
            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }

    }

    private fun normalizeFailure(result: JSONObject): JSONObject {
        val errMsg = result.optString("errMsg")
        if (errMsg.startsWith("$SCAN_CODE:fail")) {
            return result
        }
        return result.put("errMsg", "$SCAN_CODE:fail ${errMsg.ifEmpty { "cancel" }}")
    }
}
