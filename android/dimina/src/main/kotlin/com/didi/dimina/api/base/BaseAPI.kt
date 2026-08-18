package com.didi.dimina.api.base

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.LogUtils
import com.didi.dimina.core.MiniApp
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 *
 * Author: Doslin
 */
class BaseAPI : BaseApiHandler() {
    companion object {
        private const val TAG = "BaseAPI"

        // 判断小程序的API，回调，参数，组件等是否在当前版本可用。
        const val CAN_I_USE = "canIUse"
    }

    override val apiNames = setOf(CAN_I_USE)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        when (apiName) {
            CAN_I_USE -> {
                val param = params.optString("args", "")
                if (param.isEmpty()) {
                    return SyncResult(JSValue.Companion.createBoolean(false))
                }

                val isAvailable = checkAvailability(param)
                LogUtils.d(TAG, "canIUse check for '$param': $isAvailable")
                return SyncResult(JSValue.Companion.createBoolean(isAvailable))
            }
        }
        return SyncResult(JSValue.Companion.createBoolean(false))
    }

    /**
     * Checks if the specified API, component, or parameter is available
     *
     * @param param The parameter to check
     * @return True if the specified item is available, false otherwise
     */
    private fun checkAvailability(param: String): Boolean {
        val parts = param.split(".")
        val availableApis = MiniApp.Companion.getInstance().getAvailableApis()
        return availableApis.contains(param) || availableApis.contains(parts[0])
    }
}
