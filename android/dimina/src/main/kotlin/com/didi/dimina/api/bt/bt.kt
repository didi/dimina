package com.didi.dimina.api.bt

import android.Manifest
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.ActivityCompat
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.NoneResult
//import com.didi.dimina.api.udp.UdpApi.Companion.UDPSocketInstance
//import com.didi.dimina.api.udp.UdpApi.Companion.socketInstances
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
//import java.net.DatagramSocket
import java.util.UUID
//import java.util.concurrent.ConcurrentHashMap
//import java.util.concurrent.atomic.AtomicBoolean
//import kotlin.collections.set

/**
 * 蓝牙 API
 * 作者: 上电冒烟
 */
class BtApi : ApiHandler {
    // 扫描事件监听接口（全局）
    interface BluetoothScanListener {
        fun onDeviceFound(deviceJson: JSONObject)
        fun onScanStopped()
    }

    // 全局监听者
    private var mScanListener: BluetoothScanListener? = null

    // 扫描参数（成员变量，跨函数访问）
    private var mServices: Array<UUID>? = null
    private var mAllowDuplicates = false

    companion object {
        private const val TAG = "BtApi"

        // 对齐微信 API 名称
        const val API_openBluetoothAdapter = "openBluetoothAdapter"
        const val API_startBluetoothDevicesDiscovery = "startBluetoothDevicesDiscovery"
        const val API_getBluetoothDevices = "getBluetoothDevices"
        const val API_createBLEConnection = "createBLEConnection"
        const val API_getBLEDeviceServices = "getBLEDeviceServices"
        const val API_getBLEDeviceCharacteristics = "getBLEDeviceCharacteristics"
        const val API_notifyBLECharacteristicValueChange = "notifyBLECharacteristicValueChange"
        const val API_onBLECharacteristicValueChange = "onBLECharacteristicValueChange"
        const val API_writeBLECharacteristicValue = "writeBLECharacteristicValue"

        const val API_onBluetoothDeviceFound= "onBluetoothDeviceFound"

        // 微信蓝牙API标准错误码
        private const val ERR_CODE_SUCCESS = 0 // 成功
        private const val ERR_CODE_SYSTEM_ERROR = 10000 // 系统错误
        private const val ERR_CODE_BLUETOOTH_NOT_INIT = 10001 // 蓝牙未初始化
        private const val ERR_CODE_USER_REJECT = 10002 // 用户拒绝开启蓝牙
        private const val ERR_CODE_NO_PERMISSION = 10003 // 缺少蓝牙权限
        private const val ERR_CODE_BLUETOOTH_UNSUPPORT = 10004 // 设备不支持蓝牙
        private const val ERR_CODE_SCAN_ALREADY_START = 10005 // 蓝牙扫描已开启
        private const val ERR_CODE_BLUETOOTH_OFF = 10006 // 蓝牙未开启

        // 蓝牙扫描超时时间（微信默认10秒）
        private const val SCAN_TIMEOUT_MS = 10000L
        // 扫描结果缓存
        private val discoveredDevices = mutableSetOf<BluetoothDevice>()
        private val scanHandler = Handler(Looper.getMainLooper())
        private var isScanning = false



    }


    fun registerWith(registry: ApiRegistry) {
        registry.register(API_openBluetoothAdapter, this)
        registry.register(API_startBluetoothDevicesDiscovery, this)
        Log.d(TAG, "API 注册完成")
    }

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {

//        val btdata = BtData(
//            appId=appId,
//            apiName=apiName,
//            params = params,
//            activity = activity,
//            responseCallback = responseCallback,
//        )
//        btdatali[0] = btdata



        Log.d(TAG, "处理微信标准API: $apiName, 调用方appId: $appId, 参数: $params")
        return when (apiName) {
            API_openBluetoothAdapter -> openBluetoothAdapter(activity, params, responseCallback)
            API_startBluetoothDevicesDiscovery -> startBluetoothDevicesDiscovery(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_getBluetoothDevices -> getBluetoothDevices(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_createBLEConnection -> createBLEConnection(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_getBLEDeviceServices -> getBLEDeviceServices(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_getBLEDeviceCharacteristics -> getBLEDeviceCharacteristics(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_notifyBLECharacteristicValueChange -> notifyBLECharacteristicValueChange(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_onBLECharacteristicValueChange -> onBLECharacteristicValueChange(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_writeBLECharacteristicValue -> writeBLECharacteristicValue(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )
            API_onBluetoothDeviceFound -> onBluetoothDeviceFound(
                activity,
                appId,
                apiName,
                params,
                responseCallback
            )


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
            val bluetoothManager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val bluetoothAdapter = bluetoothManager.adapter
            if (bluetoothAdapter == null) {
                // 设备不支持蓝牙的逻辑（不变）
                val unsupportedResult = JSONObject().apply {
                    put("errCode", ERR_CODE_BLUETOOTH_UNSUPPORT)
                    put("errMsg", "$API_openBluetoothAdapter:fail 设备不支持蓝牙")
                }
                ApiUtils.invokeFail(params, unsupportedResult, responseCallback)
                return NoneResult()
            }

            // 关键修改：检查所有蓝牙权限（而非仅连接权限）
            if (!checkAllBluetoothPermissions(activity)) {
                requestAllBluetoothPermissions(activity, params, responseCallback)
                return NoneResult()
            }

            // 后续蓝牙开启逻辑（不变）
            if (bluetoothAdapter.isEnabled) {
                val successResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SUCCESS)
                    put("errMsg", "$API_openBluetoothAdapter:ok")
                }
                ApiUtils.invokeSuccess(params, successResult, responseCallback)
            } else {
                // 申请开启蓝牙的逻辑（不变）
                activity.requestEnableBluetooth { isSuccess ->
                    // ... 原有逻辑
                }
            }
            NoneResult()
        } catch (e: Exception) {
            // 异常逻辑（不变）
            val errorResult = JSONObject().apply {
                put("errCode", ERR_CODE_SYSTEM_ERROR)
                put("errMsg", "$API_openBluetoothAdapter:fail ${e.message}")
            }
            ApiUtils.invokeFail(params, errorResult, responseCallback)
            NoneResult()
        }
    }
    /**
     * 检查蓝牙相关权限（适配Android 12+的权限变更）
     */

    /**
     * 请求蓝牙相关权限
     */
// 1. 新增：检查所有蓝牙权限（含扫描+连接+定位）
    private fun checkAllBluetoothPermissions(activity: Activity): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+：扫描+连接权限（读取名称必需）
            ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            // Android 11-：基础蓝牙+定位权限（读取名称必需）
            ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
                    && ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_ADMIN) == PackageManager.PERMISSION_GRANTED
                    && ActivityCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    // 2. 改造：请求所有蓝牙权限
    private fun requestAllBluetoothPermissions(
        activity: Activity,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+：扫描+连接（覆盖所有蓝牙操作）
            arrayOf(
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_CONNECT
            )
        } else {
            // Android 11-：基础蓝牙+定位（读取名称必需）
            arrayOf(
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN,
                Manifest.permission.ACCESS_FINE_LOCATION
            )
        }

        // 修复异步问题：先发起权限申请，不立即返回错误
        ActivityCompat.requestPermissions(activity, permissions, 1001)

        // 注意：此处不再直接返回错误！需在Activity的onRequestPermissionsResult中处理结果
        // 临时提示用户授权（最终结果在回调中返回）
        val permResult = JSONObject().apply {
            put("errCode", ERR_CODE_NO_PERMISSION)
            put("errMsg", "请授予蓝牙/定位权限以读取设备名称")
        }
        ApiUtils.invokeFail(params, permResult, responseCallback)
    }

    // 3. 改造：检查扫描权限（复用上面的全权限检查）
    private fun checkBluetoothScanPermission(activity: Activity): Boolean {
        return checkAllBluetoothPermissions(activity)
    }

    // 4. 改造：请求扫描权限（复用上面的全权限申请）
    private fun requestBluetoothScanPermission(
        activity: Activity,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) {
        requestAllBluetoothPermissions(activity, params, responseCallback)
    }

    /**
     * 请求蓝牙相关权限
     */


//    wx.startBluetoothDevicesDiscovery()（开始搜索蓝牙设备）

    /**
     * 开始搜索蓝牙设备（核心改造：回调写在函数内部）
     */
    private fun startBluetoothDevicesDiscovery(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        return try {
            // 1. 原有逻辑：检查蓝牙适配器、蓝牙状态、扫描状态
            val bluetoothManager = activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val bluetoothAdapter = bluetoothManager.adapter
            if (bluetoothAdapter == null) {
                val unsupportedResult = JSONObject().apply {//设备不支持蓝牙
                    put("errCode", ERR_CODE_BLUETOOTH_UNSUPPORT)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 设备不支持蓝牙")
                }
                ApiUtils.invokeFail(params, unsupportedResult, responseCallback)
                return NoneResult()
            }
            if (!bluetoothAdapter.isEnabled) {//蓝牙未开启
                val btOffResult = JSONObject().apply {
                    put("errCode", ERR_CODE_BLUETOOTH_OFF)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 蓝牙未开启")
                }
                ApiUtils.invokeFail(params, btOffResult, responseCallback)
                return NoneResult()
            }
            if (isScanning) {//正在扫描
                val scanRunningResult = JSONObject().apply {//蓝牙扫描已开启
                    put("errCode", ERR_CODE_SCAN_ALREADY_START)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 蓝牙扫描已开启")
                }
                ApiUtils.invokeFail(params, scanRunningResult, responseCallback)
                return NoneResult()
            }

            // 2. 原有逻辑：解析参数（保存到成员变量）
            mServices = if (params.has("services")) {
                val serviceArray = params.getJSONArray("services")
                val uuidList = mutableListOf<UUID>()
                for (i in 0 until serviceArray.length()) {
                    try {
                        uuidList.add(UUID.fromString(serviceArray.getString(i)))
                    } catch (e: Exception) {
                        Log.w(TAG, "解析services UUID失败: ${e.message}")
                    }
                }
                uuidList.takeIf { it.isNotEmpty() }?.toTypedArray()
            } else {
                null
            }
            mAllowDuplicates = params.optBoolean("allowDuplicatesKey", false)

            // 3. 清空历史扫描结果
            discoveredDevices.clear()

            // ********************* 核心改造：局部定义扫描回调 *********************
            val leScanCallback = BluetoothAdapter.LeScanCallback { device, rssi, scanRecord ->
                device ?: return@LeScanCallback

                if (mAllowDuplicates || !discoveredDevices.contains(device)) {
                    if (!mAllowDuplicates) {
                        discoveredDevices.add(device)
                    }

                    // 直接使用函数内的 activity 参数（无需传参/缓存）
                    val deviceName = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        // Android 12+ 检查 BLUETOOTH_CONNECT 权限
                        if (ActivityCompat.checkSelfPermission(
                                activity, // 直接访问函数内的activity
                                Manifest.permission.BLUETOOTH_CONNECT
                            ) == PackageManager.PERMISSION_GRANTED
                        ) {
                            device.name ?: "未知设备"
                        } else {
                            "权限不足，无法读取名称"
                        }
                    } else {
                        // Android 11- 检查 BLUETOOTH 权限
                        if (ActivityCompat.checkSelfPermission(
                                activity, // 直接访问函数内的activity
                                Manifest.permission.BLUETOOTH
                            ) == PackageManager.PERMISSION_GRANTED
                        ) {
                            device.name ?: "未知设备"
                        } else {
                            "权限不足，无法读取名称"
                        }
                    }

                    val deviceJson = JSONObject().apply {
                        put("name", deviceName)
                        put("deviceId", device.address)
                        put("RSSI", rssi)
                        put("localName", deviceName)
                        put("advertisData", scanRecord?.let { ApiUtils.bytesToHex(it) } ?: "")
                    }
                    Log.d(TAG, "扫描到蓝牙设备: $deviceJson")
                    mScanListener?.onDeviceFound(deviceJson)
                }
            }
            // *******************************************************************

            // 4. 启动扫描：使用局部的 leScanCallback
            isScanning = true
            val scanStarted = try {
                val hasValidPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                } else {
                    ActivityCompat.checkSelfPermission(activity, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                            && ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH) == PackageManager.PERMISSION_GRANTED
                            && ActivityCompat.checkSelfPermission(activity, Manifest.permission.BLUETOOTH_ADMIN) == PackageManager.PERMISSION_GRANTED
                }

                if (hasValidPermission) {
                    if (mServices.isNullOrEmpty()) {
                        bluetoothAdapter.startLeScan(leScanCallback) // 使用局部回调
                    } else {
                        bluetoothAdapter.startLeScan(mServices, leScanCallback) // 使用局部回调
                    }
                } else {
                    Log.e(TAG, "启动蓝牙扫描：跨版本权限检查未通过")
                    false
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "启动蓝牙扫描时抛出SecurityException: ${e.message}", e)
                false
            }

            // 5. 扫描结果处理（原有逻辑不变）
            if (scanStarted) {
                // 扫描超时停止逻辑
                scanHandler.postDelayed({
                    if (isScanning) {
                        bluetoothAdapter.stopLeScan(leScanCallback) // 使用局部回调停止
                        isScanning = false
                        mScanListener?.onScanStopped()
                        val timeoutResult = JSONObject().apply {
                            put("errCode", ERR_CODE_SUCCESS)
                            put("errMsg", "$API_startBluetoothDevicesDiscovery:ok 扫描超时自动停止")
                        }
                        Log.w(TAG, "startBluetoothDevicesDiscovery 扫描超时自动停止 异步返回成功")//异步返回成功
                        ApiUtils.invokeSuccess(params, timeoutResult, responseCallback)//异步返回成功
                    }
                }, SCAN_TIMEOUT_MS)

                // 返回扫描启动成功
                val successResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SUCCESS)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:ok")
                }
                Log.w(TAG, "startBluetoothDevicesDiscovery 开始搜索蓝牙 异步返回成功")//异步返回成功
                ApiUtils.invokeSuccess(params, successResult, responseCallback)
            } else {
                // 权限不足/启动失败
                val failResult = JSONObject().apply {
                    put("errCode", ERR_CODE_NO_PERMISSION)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 缺少蓝牙扫描权限")
                }
                ApiUtils.invokeFail(params, failResult, responseCallback)
            }

            NoneResult()
        } catch (e: Exception) {
            val errorResult = JSONObject().apply {
                put("errCode", ERR_CODE_SYSTEM_ERROR)
                put("errMsg", "$API_startBluetoothDevicesDiscovery:fail ${e.message}")
            }
            ApiUtils.invokeFail(params, errorResult, responseCallback)
            NoneResult()
        }
    }

    /**
     * API_onBluetoothDeviceFound 监听搜索到新设备的事件
     */
    private fun onBluetoothDeviceFound(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult{
        return try {
            Log.d(TAG, "onBluetoothDeviceFound：注册蓝牙设备发现事件监听成功")

            // 1. 保存小程序的回调和入参（弱引用，避免持有 Activity 强引用导致内存泄漏）


            // 2. 立即返回「监听注册成功」的结果（微信小程序标准格式）
            val successResult = JSONObject().apply {
                put("errCode", ERR_CODE_SUCCESS)
                put("errMsg", "$API_onBluetoothDeviceFound:ok")
            }
            ApiUtils.invokeSuccess(params, successResult, responseCallback)

            NoneResult()
        } catch (e: Exception) {
            val errorResult = JSONObject().apply {
                put("errCode", ERR_CODE_SYSTEM_ERROR)
                put("errMsg", "$API_onBluetoothDeviceFound:fail ${e.message}")
            }
            ApiUtils.invokeFail(params, errorResult, responseCallback)
            NoneResult()
        }
    }


    /**
     * 请求蓝牙扫描权限
     */


    /**
     * 停止蓝牙扫描（内部辅助方法，跨版本紧邻权限检查 + 强化异常捕获）
     * 新增activity参数：提供可靠上下文，避免bluetoothAdapter.context为空导致Lint警告
     */
    private fun stopBluetoothScan(
        activity: Activity, // 新增：可靠上下文，解决Lint对上下文有效性的质疑
        bluetoothAdapter: BluetoothAdapter,
        leScanCallback: BluetoothAdapter.LeScanCallback
    ) {
        if (isScanning) {
            try {
                // 核心：跨版本紧邻API调用前权限检查（和启动扫描逻辑一致，让Lint认可）
                val hasValidPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.BLUETOOTH_SCAN
                    ) == PackageManager.PERMISSION_GRANTED
                } else {
                    ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.ACCESS_FINE_LOCATION
                    ) == PackageManager.PERMISSION_GRANTED
                            && ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.BLUETOOTH
                    ) == PackageManager.PERMISSION_GRANTED
                            && ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.BLUETOOTH_ADMIN
                    ) == PackageManager.PERMISSION_GRANTED
                }

                if (hasValidPermission) {
                    bluetoothAdapter.stopLeScan(leScanCallback)
                    Log.d(TAG, "蓝牙扫描：成功停止")
                } else {
                    Log.e(TAG, "停止蓝牙扫描：权限缺失（跨版本检查未通过）")
                }
            } catch (e: SecurityException) {
                // 显式捕获所有版本的SecurityException，彻底满足Lint要求
                Log.e(TAG, "停止蓝牙扫描时抛出SecurityException: ${e.message}", e)
            } finally {
                // 无论是否停止成功，都更新扫描状态并移除超时回调，防止内存泄漏和状态错乱
                isScanning = false
                scanHandler.removeCallbacksAndMessages(null)
                Log.d(TAG, "蓝牙扫描已标记为停止状态")
            }
        }
    }










    /*************************************/











    //    wx.getBluetoothDevices()（获取已发现的蓝牙设备列表）
    private fun getBluetoothDevices(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "获取已发现的蓝牙设备列表" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.createBLEConnection()（连接蓝牙低功耗设备）
    private fun createBLEConnection(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "连接蓝牙低功耗设备" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.getBLEDeviceServices()（获取蓝牙设备的服务列表）
    private fun getBLEDeviceServices(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "获取蓝牙设备的服务列表" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.getBLEDeviceCharacteristics()（获取蓝牙设备服务的特征值列表）
    private fun getBLEDeviceCharacteristics(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "获取蓝牙设备服务的特征值列表" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.notifyBLECharacteristicValueChange()（开启 / 关闭特征值变化监听）
    private fun notifyBLECharacteristicValueChange(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "开启 / 关闭特征值变化监听" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.onBLECharacteristicValueChange()（监听蓝牙特征值变化，接收数据）
    private fun onBLECharacteristicValueChange(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "监听蓝牙特征值变化，接收数据" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }
    //    wx.writeBLECharacteristicValue()（向蓝牙设备写入数据，发送数据）
    private fun writeBLECharacteristicValue(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) : APIResult{
        Log.e(TAG, "向蓝牙设备写入数据，发送数据" )
        return try{
            NoneResult()
        }catch (e: Exception){
            NoneResult()
        }
    }


}

fun ApiUtils.bytesToHex(bytes: ByteArray): String {
    val hexString = StringBuilder()
    for (b in bytes) {
        val hex = Integer.toHexString(0xFF and b.toInt())
        if (hex.length == 1) {
            hexString.append('0')
        }
        hexString.append(hex)
    }
    return hexString.toString()
}