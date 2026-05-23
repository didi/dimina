package com.didi.dimina.api.base

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * System API implementation
 * Author: Doslin
 *
 * Handles system-related operations like getting device information
 */
class SystemApi : BaseApiHandler() {

    private companion object {
        const val OPEN_SYSTEM_BLUETOOTH_SETTING = "openSystemBluetoothSetting"
        const val GET_WINDOW_INFO = "getWindowInfo"
        const val GET_SYSTEM_SETTING = "getSystemSetting"
        const val GET_SYSTEM_INFO_SYNC = "getSystemInfoSync"
        const val GET_SYSTEM_INFO_ASYNC = "getSystemInfoAsync"
        const val GET_SYSTEM_INFO = "getSystemInfo"
    }

    override val apiNames = setOf(
        OPEN_SYSTEM_BLUETOOTH_SETTING, GET_WINDOW_INFO, GET_SYSTEM_SETTING,
        GET_SYSTEM_INFO_SYNC, GET_SYSTEM_INFO_ASYNC, GET_SYSTEM_INFO
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            OPEN_SYSTEM_BLUETOOTH_SETTING -> {
                activity.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$OPEN_SYSTEM_BLUETOOTH_SETTING:ok")
                })
            }

            GET_WINDOW_INFO -> {
                SyncResult(JSValue.createObject(Utils.getMiniProgramSystemInfo(activity).toString()))
            }

            GET_SYSTEM_SETTING -> {
                SyncResult(JSValue.createObject(JSONObject().apply {
                    // 蓝牙开关状态
                    put("bluetoothEnabled", getBluetoothStatus(activity))

                    // 地理位置开关状态
                    val locationManager =
                        activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                    val isLocationEnabled =
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) { // API 28+
                            locationManager.isLocationEnabled
                        } else { // API 26 和 27
                            locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                                    locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                        }
                    put("locationEnabled", isLocationEnabled)

                    // Wi-Fi 开关状态
                    val wifiManager =
                        activity.getSystemService(Context.WIFI_SERVICE) as WifiManager
                    put("wifiEnabled", wifiManager.isWifiEnabled)

                    // 设备方向
                    val orientation = activity.resources.configuration.orientation
                    put(
                        "deviceOrientation", when (orientation) {
                            Configuration.ORIENTATION_PORTRAIT -> "portrait"
                            Configuration.ORIENTATION_LANDSCAPE -> "landscape"
                            else -> "undefined" // 未知方向（很少见）
                        }
                    )
                    put("errMsg", "$GET_SYSTEM_SETTING:ok")
                }.toString()))
            }

            GET_SYSTEM_INFO_SYNC -> {
                SyncResult(JSValue.createObject(getSystemInfo(activity).toString()))
            }

            GET_SYSTEM_INFO_ASYNC -> {
                // Implementation of system info getter
                AsyncResult(getSystemInfo(activity).apply {
                    put("errMsg", "$GET_SYSTEM_INFO_ASYNC:ok")
                })
            }

            GET_SYSTEM_INFO -> {
                // 特殊情况：异步的调用格式，但是是同步返回
                val result = getSystemInfo(activity)
                ApiUtils.invokeSuccess(params, result, responseCallback)
                SyncResult(JSValue.createObject(result.toString()))
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    private fun getSystemInfo(currentActivity: Activity): JSONObject {
        return Utils.getMiniProgramSystemInfo(currentActivity)
    }

    private fun getBluetoothStatus(activity: Activity): Boolean {
        // 检查设备是否支持蓝牙
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)) {
            return false
        }

        // 检查权限
        val permission = if (Build.VERSION.SDK_INT >= 31) {
            Manifest.permission.BLUETOOTH_CONNECT
        } else {
            Manifest.permission.BLUETOOTH
        }
        if (ContextCompat.checkSelfPermission(
                activity,
                permission
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(activity, arrayOf(permission), 1)
            return false
        }

        // 获取蓝牙适配器并检查状态
        val bluetoothManager =
            activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val bluetoothAdapter = bluetoothManager.adapter
        return bluetoothAdapter?.isEnabled ?: false
    }
}
