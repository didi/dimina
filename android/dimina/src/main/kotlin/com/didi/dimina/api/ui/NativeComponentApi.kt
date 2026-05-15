package com.didi.dimina.api.ui

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

class NativeComponentApi : BaseApiHandler() {
    override val apiNames: Set<String> = setOf(
        "componentMount",
        "propsUpdate",
        "componentUnmount",
        "videoContext",
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        activity.handleNativeComponentAction(apiName, params)
        return NoneResult()
    }
}
