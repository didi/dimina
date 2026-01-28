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
import com.didi.dimina.api.udp.UdpApi
import com.didi.dimina.api.udp.UdpApi.Companion.CREATE_UDP_SOCKET
import com.didi.dimina.api.udp.UdpApi.Companion.UDP_BIND
import com.didi.dimina.api.udp.UdpApi.Companion.UDP_CLOSE
import com.didi.dimina.api.udp.UdpApi.Companion.UDP_ONMSG
import com.didi.dimina.api.udp.UdpApi.Companion.UDP_SEND
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import java.util.UUID

class BtApi : ApiHandler {
    // 扫描事件监听接口（全局）
    interface BluetoothScanListener {
        fun onDeviceFound(deviceJson: JSONObject)
        fun onScanStopped()
    }

    // 全局监听者
    private var mScanListener: BluetoothScanListener? = null

    // 全局蓝牙扫描回调（避免局部销毁）
    private val mLeScanCallback = BluetoothAdapter.LeScanCallback { device, rssi, scanRecord ->
        device ?: return@LeScanCallback

        // 过滤重复设备
        if (mAllowDuplicates || !discoveredDevices.contains(device)) {
            if (!mAllowDuplicates) {
                discoveredDevices.add(device)
            }

            // 构建设备JSON
            val deviceJson = JSONObject().apply {
//                put("name", device.name ?: "")
                put("deviceId", device.address)
                put("RSSI", rssi)
//                put("localName", device.name ?: "")
                put("advertisData", scanRecord?.let { ApiUtils.bytesToHex(it) } ?: "")
            }
            Log.d(TAG, "扫描到蓝牙设备: $deviceJson")

            // 分发到全局监听者（透传给小程序）
            mScanListener?.onDeviceFound(deviceJson)
        }
    }
    // 扫描参数（成员变量，跨生命周期保存）
    private var mServices: Array<UUID>? = null
    private var mAllowDuplicates = false


    companion object {
        private const val TAG = "BtApi"

        // 对齐微信 API 名称
        /*
        wx.openBluetoothAdapter()（初始化蓝牙适配器）
        wx.startBluetoothDevicesDiscovery()（开始搜索蓝牙设备）
        wx.getBluetoothDevices()（获取已发现的蓝牙设备列表）
        wx.createBLEConnection()（连接蓝牙低功耗设备）
        wx.getBLEDeviceServices()（获取蓝牙设备的服务列表）
        wx.getBLEDeviceCharacteristics()（获取蓝牙设备服务的特征值列表）
        wx.notifyBLECharacteristicValueChange()（开启 / 关闭特征值变化监听）
        wx.onBLECharacteristicValueChange()（监听蓝牙特征值变化，接收数据）
        wx.writeBLECharacteristicValue()（向蓝牙设备写入数据，发送数据）
        */

        const val API_openBluetoothAdapter = "openBluetoothAdapter"
        const val API_startBluetoothDevicesDiscovery = "startBluetoothDevicesDiscovery"
        const val API_getBluetoothDevices = "getBluetoothDevices"
        const val API_createBLEConnection = "createBLEConnection"
        const val API_getBLEDeviceServices = "getBLEDeviceServices"
        const val API_getBLEDeviceCharacteristics = "getBLEDeviceCharacteristics"
        const val API_notifyBLECharacteristicValueChange = "notifyBLECharacteristicValueChange"
        const val API_onBLECharacteristicValueChange = "onBLECharacteristicValueChange"
        const val API_writeBLECharacteristicValue = "writeBLECharacteristicValue"

        // 微信蓝牙API标准错误码（参考微信官方文档）
        private const val ERR_CODE_SUCCESS = 0 // 成功
        private const val ERR_CODE_SYSTEM_ERROR = 10000 // 系统错误
        private const val ERR_CODE_BLUETOOTH_NOT_INIT = 10001 // 蓝牙未初始化
        private const val ERR_CODE_USER_REJECT = 10002 // 用户拒绝开启蓝牙
        private const val ERR_CODE_NO_PERMISSION = 10003 // 缺少蓝牙权限
        private const val ERR_CODE_BLUETOOTH_UNSUPPORT = 10004 // 设备不支持蓝牙
        private const val ERR_CODE_SCAN_ALREADY_START = 10005 // 蓝牙扫描已开启（补充微信规范错误码）
        private const val ERR_CODE_BLUETOOTH_OFF = 10006 // 蓝牙未开启（补充微信规范错误码）





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
            val bluetoothManager =
                activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
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
            ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.BLUETOOTH_CONNECT
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            // 低版本需要 BLUETOOTH 和 BLUETOOTH_ADMIN 权限
            ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.BLUETOOTH
            ) == PackageManager.PERMISSION_GRANTED
                    && ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.BLUETOOTH_ADMIN
            ) == PackageManager.PERMISSION_GRANTED
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




//    wx.startBluetoothDevicesDiscovery()（开始搜索蓝牙设备）

    /**
     * 开始搜索蓝牙设备（对齐微信 startBluetoothDevicesDiscovery 逻辑）
     * 微信API文档参考：https://developers.weixin.qq.com/miniprogram/dev/api/device/bluetooth/wx.startBluetoothDevicesDiscovery.html
     */

    // ******************** 外部注册监听方法 ********************
    fun setBluetoothScanListener(listener: BluetoothScanListener?) {
        this.mScanListener = listener
    }

    // ******************** 完整的 startBluetoothDevicesDiscovery 函数 ********************
    private fun startBluetoothDevicesDiscovery(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        return try {
            // 1. 获取蓝牙适配器，检查设备是否支持蓝牙
            val bluetoothManager =
                activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
            val bluetoothAdapter = bluetoothManager.adapter
            if (bluetoothAdapter == null) {
                val unsupportedResult = JSONObject().apply {
                    put("errCode", ERR_CODE_BLUETOOTH_UNSUPPORT)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 设备不支持蓝牙")
                }
                ApiUtils.invokeFail(params, unsupportedResult, responseCallback)
                return NoneResult()
            }

            // 2. 检查蓝牙是否已初始化（开启）
            if (!bluetoothAdapter.isEnabled) {
                val btOffResult = JSONObject().apply {
                    put("errCode", ERR_CODE_BLUETOOTH_OFF)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 蓝牙未开启")
                }
                ApiUtils.invokeFail(params, btOffResult, responseCallback)
                return NoneResult()
            }

            // 3. 检查扫描是否已在进行中
            if (isScanning) {
                val scanRunningResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SCAN_ALREADY_START)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 蓝牙扫描已开启")
                }
                ApiUtils.invokeFail(params, scanRunningResult, responseCallback)
                return NoneResult()
            }

            // 4. 检查蓝牙扫描权限（适配Android不同版本）
            if (!checkBluetoothScanPermission(activity)) {
                requestBluetoothScanPermission(activity, params, responseCallback)
                return NoneResult()
            }

            // 5. 解析参数：保存为成员变量（跨生命周期使用）
            // 解析services（要搜索的蓝牙服务UUID列表）
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
            // 解析是否允许重复上报设备
            mAllowDuplicates = params.optBoolean("allowDuplicatesKey", false)

            // 6. 清空历史扫描结果（不变）
            discoveredDevices.clear()

            // 7. 启动扫描：使用全局成员变量 mLeScanCallback（不再创建局部回调）
            isScanning = true
            val scanStarted = try {
                // 跨版本紧邻权限检查（让Lint认可，避免运行时异常）
                val hasValidPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    // Android 12+：检查 BLUETOOTH_SCAN
                    ActivityCompat.checkSelfPermission(
                        activity,
                        Manifest.permission.BLUETOOTH_SCAN
                    ) == PackageManager.PERMISSION_GRANTED
                } else {
                    // Android 11及以下：检查 位置权限 + 基础蓝牙权限
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

                // 权限有效则启动扫描
                if (hasValidPermission) {
                    if (mServices.isNullOrEmpty()) {
                        bluetoothAdapter.startLeScan(mLeScanCallback)
                    } else {
                        bluetoothAdapter.startLeScan(mServices, mLeScanCallback)
                    }
                } else {
                    Log.e(TAG, "启动蓝牙扫描：跨版本权限检查未通过")
                    false
                }
            } catch (e: SecurityException) {
                Log.e(TAG, "启动蓝牙扫描时抛出SecurityException: ${e.message}", e)
                false
            }

            // 8. 返回启动结果（不变，仅通知「扫描是否启动成功」，不处理后续设备回调）
            if (scanStarted) {
                // 设置超时停止（不变，调用全局停止逻辑）
                scanHandler.postDelayed({
                    stopBluetoothScan(activity, bluetoothAdapter, mLeScanCallback)
                    mScanListener?.onScanStopped() // 分发扫描停止事件
                }, SCAN_TIMEOUT_MS)

                // 返回启动成功结果给小程序（本次调用的唯一同步结果）
                val successResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SUCCESS)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:ok")
                }
                ApiUtils.invokeSuccess(params, successResult, responseCallback)
            } else {
                // 扫描启动失败
                isScanning = false
                val scanFailResult = JSONObject().apply {
                    put("errCode", ERR_CODE_SYSTEM_ERROR)
                    put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 扫描启动失败")
                }
                ApiUtils.invokeFail(params, scanFailResult, responseCallback)
            }

            NoneResult()
        } catch (e: Exception) {
            isScanning = false
            val errorMsg = "微信API：开始蓝牙扫描失败 - ${e.message}"
            Log.e(TAG, errorMsg, e)
            val errorResult = JSONObject().apply {
                put("errCode", ERR_CODE_SYSTEM_ERROR)
                put("errMsg", "$API_startBluetoothDevicesDiscovery:fail $errorMsg")
            }
            ApiUtils.invokeFail(params, errorResult, responseCallback)
            NoneResult()
        }
    }

    /**
     * 检查蓝牙扫描权限（适配Android不同版本）
     */
    private fun checkBluetoothScanPermission(activity: Activity): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+ 需要 BLUETOOTH_SCAN 权限
            ActivityCompat.checkSelfPermission(
                activity,
                Manifest.permission.BLUETOOTH_SCAN
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            // Android 11及以下 需要 位置权限 + 基础蓝牙权限
            (ActivityCompat.checkSelfPermission(
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
            ) == PackageManager.PERMISSION_GRANTED)
        }
    }

    /**
     * 请求蓝牙扫描权限
     */
    private fun requestBluetoothScanPermission(
        activity: Activity,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ) {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN)
        } else {
            arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN
            )
        }

        ActivityCompat.requestPermissions(
            activity,
            permissions,
            1002 // 扫描权限请求码（与开启蓝牙的1001区分）
        )

        // 返回权限缺失错误
        val permResult = JSONObject().apply {
            put("errCode", ERR_CODE_NO_PERMISSION)
            put("errMsg", "$API_startBluetoothDevicesDiscovery:fail 缺少蓝牙扫描权限，请授权")
        }
        ApiUtils.invokeFail(params, permResult, responseCallback)
    }

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