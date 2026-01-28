package com.didi.dimina.api.bt

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

class BtApi : ApiHandler {

    companion object {
        private const val TAG = "BtApi"

        // 对齐微信 API 名称
        const val API_openBluetoothAdapter = "openBluetoothAdapter"

        // 微信蓝牙API标准错误码（参考微信官方文档）
        private const val ERR_CODE_SUCCESS = 0 // 成功
        private const val ERR_CODE_SYSTEM_ERROR = 10000 // 系统错误
        private const val ERR_CODE_BLUETOOTH_NOT_INIT = 10001 // 蓝牙未初始化
        private const val ERR_CODE_USER_REJECT = 10002 // 用户拒绝开启蓝牙
        private const val ERR_CODE_NO_PERMISSION = 10003 // 缺少蓝牙权限
        private const val ERR_CODE_BLUETOOTH_UNSUPPORT = 10004 // 设备不支持蓝牙
    }

    fun registerWith(registry: ApiRegistry) {
        registry.register(API_openBluetoothAdapter, this)
        Log.d(TAG, "API 注册完成")
    }

    /**
     * 处理UDP API调用（核心入口，完全对齐微信API规范）
     */
    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.d(TAG, "处理微信标准API: $apiName, 调用方appId: $appId, 参数: $params")
        return when (apiName) {
            API_openBluetoothAdapter -> openBluetoothAdapter(activity, params, responseCallback)
            else -> {
                val errorMsg = "未知的微信标准API: $apiName"
                Log.w(TAG, errorMsg)
                val errorResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SYSTEM_ERROR)
                    put("errMsg", "$apiName:fail $errorMsg")
                }
                ApiUtils.invokeFail(params, errorResult, responseCallback)
                NoneResult()
            }
        }
    }

    /**
     * 核心逻辑：对齐微信 openBluetoothAdapter 逻辑打开蓝牙
     */
    private fun openBluetoothAdapter(
        activity: DiminaActivity,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        return try {
            // 1. 检查设备是否支持蓝牙
            val bluetoothManager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val bluetoothAdapter = bluetoothManager.adapter
            if (bluetoothAdapter == null) {
                val unsupportedResult = JSONObject().apply {
                    put("errCode", ERR_CODE_BLUETOOTH_UNSUPPORT)
                    put("errMsg", "$API_openBluetoothAdapter:fail 设备不支持蓝牙")
                }
                ApiUtils.invokeFail(params, unsupportedResult, responseCallback)
                return NoneResult()
            }

            // 2. 检查蓝牙权限（适配Android不同版本）
            if (!checkBluetoothPermission(activity)) {
                // 请求蓝牙权限
                requestBluetoothPermission(activity, params, responseCallback)
                return NoneResult()
            }

            // 3. 检查蓝牙是否已开启
            if (bluetoothAdapter.isEnabled) {
                // 蓝牙已开启，直接返回成功
                val successResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SUCCESS)
                    put("errMsg", "$API_openBluetoothAdapter:ok")
                }
                ApiUtils.invokeSuccess(params, successResult, responseCallback)
            } else {
                // 4. 蓝牙未开启，调用Activity中已注册的launcher请求开启
                if (ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.BLUETOOTH_ADMIN
                    ) != PackageManager.PERMISSION_GRANTED
                ) {
                    val permResult = JSONObject().apply {
                        put("errCode", ERR_CODE_NO_PERMISSION)
                        put("errMsg", "$API_openBluetoothAdapter:fail 缺少蓝牙管理权限")
                    }
                    ApiUtils.invokeFail(params, permResult, responseCallback)
                    return NoneResult()
                }
                // 调用Activity的方法，传入结果回调
                activity.requestEnableBluetooth { isSuccess ->
                    if (isSuccess) {
                        val successResult = JSONObject().apply {
                            put("errCode", ERR_CODE_SUCCESS)
                            put("errMsg", "$API_openBluetoothAdapter:ok")
                        }
                        ApiUtils.invokeSuccess(params, successResult, responseCallback)
                    } else {
                        val rejectResult = JSONObject().apply {
                            put("errCode", ERR_CODE_USER_REJECT)
                            put("errMsg", "$API_openBluetoothAdapter:fail 用户拒绝开启蓝牙")
                        }
                        ApiUtils.invokeFail(params, rejectResult, responseCallback)
                    }
                }
            }

            NoneResult()
        } catch (e: Exception) {
            // 异常处理：触发微信标准的fail回调
            val errorMsg = "微信API：打开蓝牙失败 - ${e.message}"
            Log.e(TAG, errorMsg, e)
            val errorResult = JSONObject().apply {
                put("errCode", ERR_CODE_SYSTEM_ERROR)
                put("errMsg", "$API_openBluetoothAdapter:fail $errorMsg")
            }
            ApiUtils.invokeFail(params, errorResult, responseCallback)
            NoneResult()
        }
    }

    /**
     * 检查蓝牙相关权限（适配Android 12+的权限变更）
     */
    private fun checkBluetoothPermission(activity: Activity): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ 需要 BLUETOOTH_CONNECT 权限
            ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            // 低版本需要 BLUETOOTH 和 BLUETOOTH_ADMIN 权限
            ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
                    && ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_ADMIN) == PackageManager.PERMISSION_GRANTED
        }
    }

    /**
     * 请求蓝牙相关权限
     */
    private fun requestBluetoothPermission(
        activity: Activity,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            arrayOf(Manifest.permission.BLUETOOTH, Manifest.permission.BLUETOOTH_ADMIN)
        }

        ActivityCompat.requestPermissions(
            activity,
            permissions,
            1001 // 权限请求码
        )

        // 返回权限缺失错误
        val permResult = JSONObject().apply {
            put("errCode", ERR_CODE_NO_PERMISSION)
            put("errMsg", "$API_openBluetoothAdapter:fail 缺少蓝牙权限，请授权")
        }
        ApiUtils.invokeFail(params, permResult, responseCallback)
    }
}