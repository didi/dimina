package com.didi.dimina.api.bt

import android.util.Log
import com.didi.dimina.Dimina
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.NoneResult
import com.didi.dimina.api.openMiNiapp.OpenMiniApi
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

class BtApi : ApiHandler {

    companion object {
        private const val TAG = "BtApi"

        // 对齐微信 API 名称
        const val API_openBluetoothAdapter = "openBluetoothAdapter"


    }

    fun registerWith(registry: ApiRegistry) {
        registry.register(API_openBluetoothAdapter, this)
        Log.d(TAG, "API 注册完成")
    }

    /**
     * 处理UDP API调用（核心入口，完全对齐微信API规范）
     */
    override fun handleAction(
        activity: DiminaActivity,       // 本身就是Activity类型，无需转换
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.d(TAG, "处理微信标准API: $apiName, 调用方appId: $appId, 参数: $params")
        return when (apiName) {
            API_openBluetoothAdapter -> openBluetoothAdapter(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )

            else -> {
                val errorMsg = "未知的微信标准API: $apiName"
                Log.w(TAG, errorMsg)
                NoneResult()
            }
        }
    }

    /**
     * 核心逻辑：对齐微信 openBluetoothAdapter 逻辑打开蓝牙
     */
    private fun openBluetoothAdapter(
        activity: DiminaActivity,       // 本身就是Activity类型，无需转换
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {

        return try {


            NoneResult()
        } catch (e: Exception) {
            // 6. 异常处理：触发微信标准的fail + complete回调
            val errorMsg = "微信API：打开小程序失败 - ${e.message}"
            Log.e(BtApi.Companion.TAG, errorMsg, e)

            NoneResult()
        }
    }

}