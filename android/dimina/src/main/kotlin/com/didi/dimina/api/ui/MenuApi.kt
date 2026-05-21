package com.didi.dimina.api.ui

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.Utils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * Author: Doslin
 */
class MenuApi : BaseApiHandler() {
    private companion object {
        const val GET_MENU_BUTTON_BOUNDING_CLIENT_RECT = "getMenuButtonBoundingClientRect"
    }

    override val apiNames = setOf(GET_MENU_BUTTON_BOUNDING_CLIENT_RECT)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            GET_MENU_BUTTON_BOUNDING_CLIENT_RECT -> {
                SyncResult(JSValue.createObject(Utils.getMenuButtonBoundingClientRect(activity).toString()))
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }
}
