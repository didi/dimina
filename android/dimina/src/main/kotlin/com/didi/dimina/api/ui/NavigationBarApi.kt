package com.didi.dimina.api.ui

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * Author: Doslin
 */
class NavigationBarApi : BaseApiHandler() {
    private companion object {
        const val SET_NAVIGATION_BAR_TITLE = "setNavigationBarTitle"
        const val SET_NAVIGATION_BAR_COLOR = "setNavigationBarColor"
        const val HIDE_HOME_BUTTON = "hideHomeButton"
    }

    override val apiNames = setOf(
        SET_NAVIGATION_BAR_TITLE,
        SET_NAVIGATION_BAR_COLOR,
        HIDE_HOME_BUTTON,
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SET_NAVIGATION_BAR_TITLE -> {
                val title = params.optString("title")
                if (title.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$SET_NAVIGATION_BAR_TITLE:fail title is required")
                    })
                }
                activity.setNavigationBarTitle(title)
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SET_NAVIGATION_BAR_TITLE:ok")
                })
            }

            SET_NAVIGATION_BAR_COLOR -> {
                val frontColor = params.optString("frontColor")
                if (frontColor.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$SET_NAVIGATION_BAR_COLOR:fail frontColor is required")
                    })
                }
                val backgroundColor = params.optString("backgroundColor")
                if (backgroundColor.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$SET_NAVIGATION_BAR_COLOR:fail backgroundColor is required")
                    })
                }
                activity.setNavigationBarColor(frontColor, backgroundColor)
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SET_NAVIGATION_BAR_COLOR:ok")
                })
            }

            HIDE_HOME_BUTTON -> {
                activity.hideHomeButton()
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$HIDE_HOME_BUTTON:ok")
                })
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }
}