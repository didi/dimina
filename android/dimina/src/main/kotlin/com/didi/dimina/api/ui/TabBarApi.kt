package com.didi.dimina.api.ui

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * TabBar dynamic APIs.
 */
class TabBarApi : BaseApiHandler() {
    private companion object {
        const val SET_TAB_BAR_STYLE = "setTabBarStyle"
        const val SET_TAB_BAR_ITEM = "setTabBarItem"
        const val SHOW_TAB_BAR = "showTabBar"
        const val HIDE_TAB_BAR = "hideTabBar"
        const val SET_TAB_BAR_BADGE = "setTabBarBadge"
        const val REMOVE_TAB_BAR_BADGE = "removeTabBarBadge"
        const val SHOW_TAB_BAR_RED_DOT = "showTabBarRedDot"
        const val HIDE_TAB_BAR_RED_DOT = "hideTabBarRedDot"
    }

    override val apiNames = setOf(
        SET_TAB_BAR_STYLE,
        SET_TAB_BAR_ITEM,
        SHOW_TAB_BAR,
        HIDE_TAB_BAR,
        SET_TAB_BAR_BADGE,
        REMOVE_TAB_BAR_BADGE,
        SHOW_TAB_BAR_RED_DOT,
        HIDE_TAB_BAR_RED_DOT,
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SET_TAB_BAR_STYLE -> {
                if (activity.getTabBarItemCount() == 0) {
                    return fail(SET_TAB_BAR_STYLE, "tabBar not configured")
                }

                activity.setTabBarStyle(
                    color = params.optNullableString("color"),
                    selectedColor = params.optNullableString("selectedColor"),
                    backgroundColor = params.optNullableString("backgroundColor"),
                    borderStyle = params.optNullableString("borderStyle"),
                )
                ok(SET_TAB_BAR_STYLE)
            }

            SET_TAB_BAR_ITEM -> {
                val index = params.optInt("index", -1)
                validateIndex(activity, SET_TAB_BAR_ITEM, index)?.let { return it }

                activity.setTabBarItem(
                    index = index,
                    text = params.optNullableString("text"),
                    iconPath = params.optNullableString("iconPath"),
                    selectedIconPath = params.optNullableString("selectedIconPath"),
                )
                ok(SET_TAB_BAR_ITEM)
            }

            SHOW_TAB_BAR -> {
                activity.showTabBar()
                ok(SHOW_TAB_BAR)
            }

            HIDE_TAB_BAR -> {
                activity.hideTabBar()
                ok(HIDE_TAB_BAR)
            }

            SET_TAB_BAR_BADGE -> {
                val index = params.optInt("index", -1)
                validateIndex(activity, SET_TAB_BAR_BADGE, index)?.let { return it }

                activity.setTabBarBadge(index, params.optString("text", ""))
                ok(SET_TAB_BAR_BADGE)
            }

            REMOVE_TAB_BAR_BADGE -> {
                val index = params.optInt("index", -1)
                validateIndex(activity, REMOVE_TAB_BAR_BADGE, index)?.let { return it }

                activity.removeTabBarBadge(index)
                ok(REMOVE_TAB_BAR_BADGE)
            }

            SHOW_TAB_BAR_RED_DOT -> {
                val index = params.optInt("index", -1)
                validateIndex(activity, SHOW_TAB_BAR_RED_DOT, index)?.let { return it }

                activity.showTabBarRedDot(index)
                ok(SHOW_TAB_BAR_RED_DOT)
            }

            HIDE_TAB_BAR_RED_DOT -> {
                val index = params.optInt("index", -1)
                validateIndex(activity, HIDE_TAB_BAR_RED_DOT, index)?.let { return it }

                activity.hideTabBarRedDot(index)
                ok(HIDE_TAB_BAR_RED_DOT)
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    private fun validateIndex(
        activity: DiminaActivity,
        apiName: String,
        index: Int,
    ): AsyncResult? {
        val listLength = activity.getTabBarItemCount()
        if (listLength == 0) {
            return fail(apiName, "tabBar not configured")
        }
        if (index < 0 || index >= listLength) {
            return fail(apiName, "invalid index $index")
        }
        return null
    }

    private fun ok(apiName: String): AsyncResult {
        return AsyncResult(JSONObject().apply {
            put("errMsg", "$apiName:ok")
        })
    }

    private fun fail(apiName: String, message: String): AsyncResult {
        return AsyncResult(JSONObject().apply {
            put("errMsg", "$apiName:fail $message")
        })
    }

    private fun JSONObject.optNullableString(name: String): String? {
        return if (has(name) && !isNull(name)) {
            optString(name)
        } else {
            null
        }
    }
}
