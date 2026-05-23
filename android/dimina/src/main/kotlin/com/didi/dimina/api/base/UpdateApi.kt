package com.didi.dimina.api.base

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * Update manager container-side APIs.
 */
class UpdateApi : BaseApiHandler() {
    companion object {
        private const val APPLY_UPDATE = "applyUpdate"
    }

    override val apiNames = setOf(APPLY_UPDATE)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            APPLY_UPDATE -> {
                activity.applyUpdate()
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$APPLY_UPDATE:ok")
                })
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }
}
