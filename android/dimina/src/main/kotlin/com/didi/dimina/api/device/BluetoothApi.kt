package com.didi.dimina.api.device

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import androidx.core.content.ContextCompat
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Implements the WeChat Mini Program Bluetooth adapter and BLE central APIs. */
@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
@SuppressLint("MissingPermission")
class BluetoothApi : BaseApiHandler() {
    companion object {
        const val ARRAY_BUFFER_BASE64_KEY = "__diminaArrayBufferBase64"

        val SUPPORTED_API_NAMES = setOf(
            "openBluetoothAdapter",
            "closeBluetoothAdapter",
            "getBluetoothAdapterState",
            "startBluetoothDevicesDiscovery",
            "stopBluetoothDevicesDiscovery",
            "getBluetoothDevices",
            "getConnectedBluetoothDevices",
            "onBluetoothAdapterStateChange",
            "offBluetoothAdapterStateChange",
            "onBluetoothDeviceFound",
            "offBluetoothDeviceFound",
            "createBLEConnection",
            "closeBLEConnection",
            "getBLEDeviceServices",
            "getBLEDeviceCharacteristics",
            "readBLECharacteristicValue",
            "writeBLECharacteristicValue",
            "notifyBLECharacteristicValueChange",
            "getBLEDeviceRSSI",
            "setBLEMTU",
            "getBLEMTU",
            "onBLEConnectionStateChange",
            "offBLEConnectionStateChange",
            "onBLECharacteristicValueChange",
            "offBLECharacteristicValueChange",
            "onBLEMTUChange",
            "offBLEMTUChange",
            "isBluetoothDevicePaired",
            "makeBluetoothPair",
        )

        internal fun canonicalUuid(value: String): UUID {
            val clean = value.trim().removePrefix("{").removeSuffix("}")
            val expanded = when {
                clean.matches(Regex("[0-9a-fA-F]{4}")) -> "0000$clean-0000-1000-8000-00805f9b34fb"
                clean.matches(Regex("[0-9a-fA-F]{8}")) -> "$clean-0000-1000-8000-00805f9b34fb"
                clean.matches(Regex("[0-9a-fA-F]{32}")) -> clean.replace(
                    Regex("(.{8})(.{4})(.{4})(.{4})(.{12})"),
                    "$1-$2-$3-$4-$5",
                )
                else -> clean
            }
            return UUID.fromString(expanded)
        }

        internal fun arrayBufferPayload(bytes: ByteArray): JSONObject = JSONObject().put(
            ARRAY_BUFFER_BASE64_KEY,
            Base64.encodeToString(bytes, Base64.NO_WRAP),
        )

        internal fun decodeArrayBuffer(value: Any?): ByteArray? {
            if (value !is JSONObject || !value.has(ARRAY_BUFFER_BASE64_KEY)) return null
            return Base64.decode(value.optString(ARRAY_BUFFER_BASE64_KEY), Base64.DEFAULT)
        }
    }

    override val apiNames: Set<String> = SUPPORTED_API_NAMES

    private data class Listener(
        val callbackId: String,
        val response: (String) -> Unit,
    )

    private data class PendingCall(
        val apiName: String,
        val params: JSONObject,
        val response: (String) -> Unit,
    )

    private data class GattConnection(
        val appId: String,
        val deviceId: String,
        var gatt: BluetoothGatt? = null,
        var connected: Boolean = false,
        var mtu: Int = 23,
        var pending: PendingCall? = null,
        var timeoutTask: Runnable? = null,
    )

    private class PairRequest(
        val appId: String,
        val params: JSONObject,
        val response: (String) -> Unit,
        var timeoutTask: Runnable? = null,
    )

    private val initializedApps = ConcurrentHashMap.newKeySet<String>()
    private val scanningApps = ConcurrentHashMap.newKeySet<String>()
    private val foundDevices = ConcurrentHashMap<String, ConcurrentHashMap<String, JSONObject>>()
    private val scanCallbacks = ConcurrentHashMap<String, ScanCallback>()
    private val connections = ConcurrentHashMap<String, GattConnection>()
    private val pairRequests = ConcurrentHashMap<String, PairRequest>()
    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }

    private val adapterStateListeners = ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>()
    private val deviceFoundListeners = ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>()
    private val connectionStateListeners = ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>()
    private val characteristicListeners = ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>()
    private val mtuListeners = ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>()

    @Volatile
    private var receiverContext: Context? = null

    private val systemReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                BluetoothAdapter.ACTION_STATE_CHANGED -> {
                    val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                    val available = state == BluetoothAdapter.STATE_ON
                    adapterStateListeners.forEach { (appId, listeners) ->
                        val result = JSONObject()
                            .put("available", available)
                            .put("discovering", available && scanningApps.contains(appId))
                        emit(listeners, result)
                    }
                }

                BluetoothDevice.ACTION_BOND_STATE_CHANGED -> {
                    val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
                    } ?: return
                    when (device.bondState) {
                        BluetoothDevice.BOND_BONDED -> {
                            val completed = pairRequests.remove(device.address) ?: return
                            completed.timeoutTask?.let(mainHandler::removeCallbacks)
                            completeSuccess("makeBluetoothPair", completed.params, completed.response)
                        }
                        BluetoothDevice.BOND_NONE -> {
                            val previous = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.BOND_NONE)
                            if (previous == BluetoothDevice.BOND_BONDING) {
                                val completed = pairRequests.remove(device.address) ?: return
                                completed.timeoutTask?.let(mainHandler::removeCallbacks)
                                completeFailure("makeBluetoothPair", completed.params, completed.response, 10003, "pairing failed")
                            }
                        }
                    }
                }
            }
        }
    }

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            when (apiName) {
                "openBluetoothAdapter" -> openAdapter(activity, appId, params, responseCallback)
                "closeBluetoothAdapter" -> closeAdapter(activity, appId)
                "getBluetoothAdapterState" -> adapterState(activity, appId, apiName)
                "startBluetoothDevicesDiscovery" -> startDiscovery(activity, appId, params, apiName)
                "stopBluetoothDevicesDiscovery" -> stopDiscovery(activity, appId, apiName)
                "getBluetoothDevices" -> getDevices(appId, apiName)
                "getConnectedBluetoothDevices" -> getConnectedDevices(appId, params, apiName)
                "onBluetoothAdapterStateChange" -> addListener(adapterStateListeners, appId, params, responseCallback)
                "offBluetoothAdapterStateChange" -> removeListener(adapterStateListeners, appId, params)
                "onBluetoothDeviceFound" -> addListener(deviceFoundListeners, appId, params, responseCallback)
                "offBluetoothDeviceFound" -> removeListener(deviceFoundListeners, appId, params)
                "onBLEConnectionStateChange" -> addListener(connectionStateListeners, appId, params, responseCallback)
                "offBLEConnectionStateChange" -> removeListener(connectionStateListeners, appId, params)
                "onBLECharacteristicValueChange" -> addListener(characteristicListeners, appId, params, responseCallback)
                "offBLECharacteristicValueChange" -> removeListener(characteristicListeners, appId, params)
                "onBLEMTUChange" -> addListener(mtuListeners, appId, params, responseCallback)
                "offBLEMTUChange" -> removeListener(mtuListeners, appId, params)
                "createBLEConnection" -> createConnection(activity, appId, params, responseCallback)
                "closeBLEConnection" -> closeConnection(appId, params, apiName)
                "getBLEDeviceServices" -> getServices(appId, params, responseCallback)
                "getBLEDeviceCharacteristics" -> getCharacteristics(appId, params, apiName)
                "readBLECharacteristicValue" -> readCharacteristic(appId, params, responseCallback)
                "writeBLECharacteristicValue" -> writeCharacteristic(appId, params, responseCallback)
                "notifyBLECharacteristicValueChange" -> setNotification(appId, params, responseCallback)
                "getBLEDeviceRSSI" -> readRssi(appId, params, responseCallback)
                "setBLEMTU" -> setMtu(appId, params, responseCallback)
                "getBLEMTU" -> getMtu(appId, params, apiName)
                "isBluetoothDevicePaired" -> isPaired(activity, appId, params, apiName)
                "makeBluetoothPair" -> makePair(activity, appId, params, responseCallback)
                else -> super.handleAction(activity, appId, apiName, params, responseCallback)
            }
        } catch (error: IllegalArgumentException) {
            failure(apiName, 10013, error.message ?: "invalid_data")
        } catch (error: SecurityException) {
            failure(apiName, 10001, error.message ?: "permission denied")
        } catch (error: Exception) {
            failure(apiName, 10008, error.message ?: "system error")
        }
    }

    private fun openAdapter(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        response: (String) -> Unit,
    ): APIResult {
        if (!hasBluetoothPermission(activity)) {
            activity.handleBluetoothPermission { granted ->
                if (!granted) {
                    completeFailure("openBluetoothAdapter", params, response, 10001, "permission denied")
                    return@handleBluetoothPermission
                }
                val result = performOpen(activity, appId)
                if (result.value.optString("errMsg").endsWith(":ok")) {
                    completeSuccess("openBluetoothAdapter", params, response, result.value)
                } else {
                    completeFailure(
                        "openBluetoothAdapter",
                        params,
                        response,
                        result.value.optInt("errCode", 10008),
                        result.value.optString("errMsg").substringAfter("fail ", "system error"),
                    )
                }
            }
            return NoneResult()
        }
        return performOpen(activity, appId)
    }

    private fun performOpen(activity: DiminaActivity, appId: String): AsyncResult {
        val adapter = getAdapter(activity) ?: return failure("openBluetoothAdapter", 10009, "system not support")
        initializedApps.add(appId)
        ensureSystemReceiver(activity.applicationContext)
        return if (adapter.isEnabled) success("openBluetoothAdapter")
        else failure("openBluetoothAdapter", 10001, "not available")
    }

    private fun closeAdapter(activity: DiminaActivity, appId: String): AsyncResult {
        if (!initializedApps.contains(appId)) return failure("closeBluetoothAdapter", 10000, "not init")
        stopScanQuietly(activity, appId)
        connections.entries
            .filter { it.value.appId == appId }
            .forEach { (key, connection) ->
                connection.timeoutTask?.let(mainHandler::removeCallbacks)
                connection.pending?.let { pending ->
                    completeFailure(pending.apiName, pending.params, pending.response, 10006, "no connection")
                }
                connection.pending = null
                connection.gatt?.disconnect()
                connection.gatt?.close()
                connections.remove(key)
            }
        pairRequests.entries.filter { it.value.appId == appId }.forEach { (deviceId, request) ->
            request.timeoutTask?.let(mainHandler::removeCallbacks)
            if (pairRequests.remove(deviceId, request)) {
                completeFailure("makeBluetoothPair", request.params, request.response, 10006, "no connection")
            }
        }
        foundDevices.remove(appId)
        initializedApps.remove(appId)
        return success("closeBluetoothAdapter")
    }

    private fun adapterState(activity: DiminaActivity, appId: String, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val available = getAdapter(activity)?.isEnabled == true
        return AsyncResult(JSONObject()
            .put("available", available)
            .put("discovering", available && scanningApps.contains(appId))
            .put("errMsg", "$apiName:ok"))
    }

    private fun startDiscovery(activity: DiminaActivity, appId: String, params: JSONObject, apiName: String): APIResult {
        ensureAvailable(activity, appId, apiName)?.let { return it }
        if (scanningApps.contains(appId)) return success(apiName)
        val scanner = getAdapter(activity)?.bluetoothLeScanner ?: return failure(apiName, 10001, "not available")
        val filters = mutableListOf<ScanFilter>()
        val services = params.optJSONArray("services")
        if (services != null) {
            for (index in 0 until services.length()) {
                filters.add(ScanFilter.Builder().setServiceUuid(ParcelUuid(canonicalUuid(services.getString(index)))).build())
            }
        }
        val settings = ScanSettings.Builder()
            .setScanMode(scanMode(params.optString("powerLevel", "medium")))
            .setReportDelay(params.optLong("interval", 0L).coerceAtLeast(0L))
            .build()
        val allowDuplicates = params.optBoolean("allowDuplicatesKey", false)
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                handleScanResults(appId, listOf(result), allowDuplicates)
            }

            override fun onBatchScanResults(results: MutableList<ScanResult>) {
                handleScanResults(appId, results, allowDuplicates)
            }

            override fun onScanFailed(errorCode: Int) {
                scanningApps.remove(appId)
                adapterStateListeners[appId]?.let {
                    emit(it, JSONObject().put("available", true).put("discovering", false))
                }
            }
        }
        scanCallbacks[appId] = callback
        scanner.startScan(filters, settings, callback)
        scanningApps.add(appId)
        return success(apiName)
    }

    private fun stopDiscovery(activity: DiminaActivity, appId: String, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        stopScanQuietly(activity, appId)
        return success(apiName)
    }

    private fun handleScanResults(appId: String, results: List<ScanResult>, allowDuplicates: Boolean) {
        val appDevices = foundDevices.getOrPut(appId) { ConcurrentHashMap() }
        val changed = JSONArray()
        results.forEach { result ->
            val device = scanResultToJson(result)
            val previous = appDevices.put(result.device.address, device)
            if (allowDuplicates || previous == null) changed.put(device)
        }
        if (changed.length() > 0) {
            deviceFoundListeners[appId]?.let { emit(it, JSONObject().put("devices", changed)) }
        }
    }

    private fun scanResultToJson(result: ScanResult): JSONObject {
        val record = result.scanRecord
        val localName = record?.deviceName.orEmpty()
        val serviceData = JSONObject()
        record?.serviceData?.forEach { (uuid, bytes) ->
            serviceData.put(uuid.uuid.toString().uppercase(Locale.ROOT), arrayBufferPayload(bytes))
        }
        val serviceUuids = JSONArray()
        record?.serviceUuids?.forEach { serviceUuids.put(it.uuid.toString().uppercase(Locale.ROOT)) }
        return JSONObject()
            .put("deviceId", result.device.address)
            .put("name", result.device.name ?: localName)
            .put("localName", localName)
            .put("RSSI", result.rssi)
            .put("advertisData", arrayBufferPayload(record?.bytes ?: ByteArray(0)))
            .put("advertisServiceUUIDs", serviceUuids)
            .put("serviceData", serviceData)
    }

    private fun getDevices(appId: String, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val devices = JSONArray()
        foundDevices[appId]?.values?.forEach { devices.put(it) }
        return AsyncResult(JSONObject().put("devices", devices).put("errMsg", "$apiName:ok"))
    }

    private fun getConnectedDevices(appId: String, params: JSONObject, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val requested = mutableSetOf<UUID>()
        params.optJSONArray("services")?.let { services ->
            for (index in 0 until services.length()) requested.add(canonicalUuid(services.getString(index)))
        }
        val devices = JSONArray()
        connections.values.filter { it.appId == appId && it.connected }.forEach { connection ->
            val services = connection.gatt?.services?.map { it.uuid }?.toSet().orEmpty()
            val discovered = foundDevices[appId]?.get(connection.deviceId)
            val advertisedServices = mutableSetOf<UUID>()
            discovered?.optJSONArray("advertisServiceUUIDs")?.let { values ->
                for (index in 0 until values.length()) {
                    runCatching { canonicalUuid(values.getString(index)) }.getOrNull()?.let(advertisedServices::add)
                }
            }
            if (requested.isEmpty() || services.any { it in requested } || advertisedServices.any { it in requested }) {
                devices.put(discovered ?: JSONObject().put("deviceId", connection.deviceId).put("name", connection.gatt?.device?.name.orEmpty()))
            }
        }
        return AsyncResult(JSONObject().put("devices", devices).put("errMsg", "$apiName:ok"))
    }

    private fun createConnection(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        response: (String) -> Unit,
    ): APIResult {
        ensureAvailable(activity, appId, "createBLEConnection")?.let { return it }
        val deviceId = requireDeviceId(params)
        val key = connectionKey(appId, deviceId)
        if (connections[key]?.connected == true) return success("createBLEConnection")
        val device = getAdapter(activity)?.getRemoteDevice(deviceId)
            ?: return failure("createBLEConnection", 10002, "no device")
        val connection = GattConnection(appId, deviceId, pending = PendingCall("createBLEConnection", params, response))
        connections[key] = connection
        val callback = createGattCallback(connection)
        connection.gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(activity, false, callback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(activity, false, callback)
        }
        if (connection.gatt == null) {
            connections.remove(key)
            return failure("createBLEConnection", 10003, "connection fail")
        }
        val timeout = params.optLong("timeout", 0L)
        if (timeout > 0L) {
            val task = Runnable {
                val pending = synchronized(connection) {
                    if (connections[key] !== connection || connection.connected || connection.pending?.apiName != "createBLEConnection") {
                        null
                    } else {
                        connection.pending.also {
                            connection.pending = null
                            connection.timeoutTask = null
                        }
                    }
                }
                if (pending == null) return@Runnable
                connections.remove(key, connection)
                connection.gatt?.disconnect()
                connection.gatt?.close()
                completeFailure(pending.apiName, pending.params, pending.response, 10012, "operate time out")
            }
            connection.timeoutTask = task
            mainHandler.postDelayed(task, timeout)
        }
        return NoneResult()
    }

    private fun closeConnection(appId: String, params: JSONObject, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val deviceId = requireDeviceId(params)
        val connection = connections.remove(connectionKey(appId, deviceId))
            ?: return failure(apiName, 10002, "no device")
        connection.timeoutTask?.let(mainHandler::removeCallbacks)
        connection.timeoutTask = null
        connection.pending?.let { pending ->
            connection.pending = null
            completeFailure(pending.apiName, pending.params, pending.response, 10006, "no connection")
        }
        connection.gatt?.disconnect()
        if (!connection.connected) {
            connection.gatt?.close()
        }
        return success(apiName)
    }

    private fun getServices(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "getBLEDeviceServices"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val services = connection.gatt?.services.orEmpty()
        if (services.isNotEmpty()) return servicesResult(apiName, services)
        connection.pending = PendingCall(apiName, params, response)
        if (connection.gatt?.discoverServices() != true) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun servicesResult(apiName: String, services: List<android.bluetooth.BluetoothGattService>): AsyncResult {
        val result = JSONArray()
        services.forEach { service ->
            result.put(JSONObject()
                .put("uuid", service.uuid.toString().uppercase(Locale.ROOT))
                .put("isPrimary", service.type == android.bluetooth.BluetoothGattService.SERVICE_TYPE_PRIMARY))
        }
        return AsyncResult(JSONObject().put("services", result).put("errMsg", "$apiName:ok"))
    }

    private fun getCharacteristics(appId: String, params: JSONObject, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val service = findService(connection, params) ?: return failure(apiName, 10004, "no service")
        val characteristics = JSONArray()
        service.characteristics.forEach { characteristic ->
            val properties = characteristic.properties
            characteristics.put(JSONObject()
                .put("uuid", characteristic.uuid.toString().uppercase(Locale.ROOT))
                .put("properties", JSONObject()
                    .put("read", properties and BluetoothGattCharacteristic.PROPERTY_READ != 0)
                    .put("write", properties and BluetoothGattCharacteristic.PROPERTY_WRITE != 0)
                    .put("writeNoResponse", properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0)
                    .put("notify", properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0)
                    .put("indicate", properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0)))
        }
        return AsyncResult(JSONObject().put("characteristics", characteristics).put("errMsg", "$apiName:ok"))
    }

    private fun readCharacteristic(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "readBLECharacteristicValue"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val characteristic = findCharacteristic(connection, params) ?: return missingCharacteristic(connection, params, apiName)
        if (characteristic.properties and BluetoothGattCharacteristic.PROPERTY_READ == 0) {
            return failure(apiName, 10007, "property not support")
        }
        connection.pending = PendingCall(apiName, params, response)
        if (connection.gatt?.readCharacteristic(characteristic) != true) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun writeCharacteristic(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "writeBLECharacteristicValue"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val characteristic = findCharacteristic(connection, params) ?: return missingCharacteristic(connection, params, apiName)
        val value = decodeArrayBuffer(params.opt("value")) ?: return failure(apiName, 10013, "invalid_data")
        val withoutResponse = params.optString("writeType") == "writeNoResponse"
        val requiredProperty = if (withoutResponse) BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE else BluetoothGattCharacteristic.PROPERTY_WRITE
        if (characteristic.properties and requiredProperty == 0) return failure(apiName, 10007, "property not support")
        val writeType = if (withoutResponse) BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        connection.pending = PendingCall(apiName, params, response)
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            connection.gatt?.writeCharacteristic(characteristic, value, writeType) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            characteristic.value = value
            characteristic.writeType = writeType
            @Suppress("DEPRECATION")
            connection.gatt?.writeCharacteristic(characteristic) == true
        }
        if (!started) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun setNotification(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "notifyBLECharacteristicValueChange"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val characteristic = findCharacteristic(connection, params) ?: return missingCharacteristic(connection, params, apiName)
        val enabled = params.optBoolean("state", true)
        val supportsNotify = characteristic.properties and BluetoothGattCharacteristic.PROPERTY_NOTIFY != 0
        val supportsIndicate = characteristic.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0
        if (enabled && !supportsNotify && !supportsIndicate) return failure(apiName, 10007, "property not support")
        val gatt = connection.gatt ?: return failure(apiName, 10006, "no connection")
        if (!gatt.setCharacteristicNotification(characteristic, enabled)) return failure(apiName, 10008, "system error")
        val descriptor = characteristic.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"))
        if (descriptor == null) return if (enabled) failure(apiName, 10007, "property not support") else success(apiName)
        val value = when {
            !enabled -> BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            supportsIndicate && !supportsNotify -> BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
            else -> BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
        }
        connection.pending = PendingCall(apiName, params, response)
        val started = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            gatt.writeDescriptor(descriptor, value) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            descriptor.value = value
            @Suppress("DEPRECATION")
            gatt.writeDescriptor(descriptor)
        }
        if (!started) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun readRssi(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "getBLEDeviceRSSI"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        connection.pending = PendingCall(apiName, params, response)
        if (connection.gatt?.readRemoteRssi() != true) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun setMtu(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "setBLEMTU"
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        val mtu = params.optInt("mtu", 23)
        if (mtu !in 23..511) return failure(apiName, 10013, "invalid_data")
        connection.pending = PendingCall(apiName, params, response)
        if (connection.gatt?.requestMtu(mtu) != true) {
            connection.pending = null
            return failure(apiName, 10008, "system error")
        }
        return NoneResult()
    }

    private fun getMtu(appId: String, params: JSONObject, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val connection = requireConnection(appId, params, apiName) ?: return failure(apiName, 10006, "no connection")
        return AsyncResult(JSONObject().put("mtu", connection.mtu).put("errMsg", "$apiName:ok"))
    }

    private fun isPaired(activity: DiminaActivity, appId: String, params: JSONObject, apiName: String): AsyncResult {
        ensureInitialized(appId, apiName)?.let { return it }
        val device = getAdapter(activity)?.getRemoteDevice(requireDeviceId(params))
            ?: return failure(apiName, 10002, "no device")
        return AsyncResult(JSONObject().put("paired", device.bondState == BluetoothDevice.BOND_BONDED).put("errMsg", "$apiName:ok"))
    }

    private fun makePair(activity: DiminaActivity, appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val apiName = "makeBluetoothPair"
        ensureAvailable(activity, appId, apiName)?.let { return it }
        val device = getAdapter(activity)?.getRemoteDevice(requireDeviceId(params))
            ?: return failure(apiName, 10002, "no device")
        if (device.bondState == BluetoothDevice.BOND_BONDED) return success(apiName)
        val pin = params.optString("pin", "")
        if (pin.isEmpty()) return failure(apiName, 10013, "invalid_data")
        val pinBytes = try {
            Base64.decode(pin, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            return failure(apiName, 10013, "invalid_data")
        }
        if (!device.setPin(pinBytes)) return failure(apiName, 10003, "pairing failed")
        val request = PairRequest(appId, params, response)
        pairRequests[device.address] = request
        if (!device.createBond()) {
            pairRequests.remove(device.address)
            return failure(apiName, 10003, "pairing failed")
        }
        val timeout = params.optLong("timeout", 20_000L).coerceAtLeast(1L)
        val task = Runnable {
            if (!pairRequests.remove(device.address, request)) return@Runnable
            completeFailure(apiName, params, response, 10012, "operate time out")
        }
        request.timeoutTask = task
        mainHandler.postDelayed(task, timeout)
        return NoneResult()
    }

    private fun createGattCallback(connection: GattConnection): BluetoothGattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
            val connected = status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED
            val disconnected = newState == BluetoothProfile.STATE_DISCONNECTED && !connected
            val pending = synchronized(connection) {
                connection.timeoutTask?.let(mainHandler::removeCallbacks)
                connection.timeoutTask = null
                connection.connected = connected
                val current = connection.pending
                if (current?.apiName == "createBLEConnection" || (disconnected && current != null)) {
                    connection.pending = null
                    current
                } else null
            }
            emitConnectionState(connection.appId, connection.deviceId, connected)
            if (pending?.apiName == "createBLEConnection") {
                if (connected) completeSuccess(pending.apiName, pending.params, pending.response)
                else {
                    completeFailure(pending.apiName, pending.params, pending.response, 10003, "connection fail")
                    connections.remove(connectionKey(connection.appId, connection.deviceId), connection)
                    gatt.close()
                }
            }
            if (disconnected) {
                if (pending != null && pending.apiName != "createBLEConnection") {
                    completeFailure(pending.apiName, pending.params, pending.response, 10006, "no connection")
                }
                connections.remove(connectionKey(connection.appId, connection.deviceId), connection)
                gatt.close()
            }
        }

        override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
            val pending = takePending(connection, "getBLEDeviceServices") ?: return
            if (status == BluetoothGatt.GATT_SUCCESS) {
                val result = servicesResult(pending.apiName, gatt.services).value
                completeSuccess(pending.apiName, pending.params, pending.response, result)
            } else completeFailure(pending.apiName, pending.params, pending.response, 10008, "system error")
        }

        @Deprecated("Deprecated in Android")
        override fun onCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            handleCharacteristicRead(connection, characteristic, characteristic.value ?: ByteArray(0), status)
        }

        override fun onCharacteristicRead(
            gatt: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray,
            status: Int,
        ) {
            handleCharacteristicRead(connection, characteristic, value, status)
        }

        override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            finishPending(connection, "writeBLECharacteristicValue", status)
        }

        override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            finishPending(connection, "notifyBLECharacteristicValueChange", status)
        }

        @Deprecated("Deprecated in Android")
        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            emitCharacteristic(connection, characteristic, characteristic.value ?: ByteArray(0))
        }

        override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            emitCharacteristic(connection, characteristic, value)
        }

        override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) {
            val pending = takePending(connection, "getBLEDeviceRSSI") ?: return
            if (status == BluetoothGatt.GATT_SUCCESS) {
                completeSuccess(pending.apiName, pending.params, pending.response, JSONObject().put("RSSI", rssi))
            } else completeFailure(pending.apiName, pending.params, pending.response, 10008, "system error")
        }

        override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                connection.mtu = mtu
                mtuListeners[connection.appId]?.let {
                    emit(it, JSONObject().put("deviceId", connection.deviceId).put("mtu", mtu))
                }
            }
            val pending = takePending(connection, "setBLEMTU") ?: return
            if (status == BluetoothGatt.GATT_SUCCESS) {
                completeSuccess(pending.apiName, pending.params, pending.response, JSONObject().put("mtu", mtu))
            } else completeFailure(pending.apiName, pending.params, pending.response, 10008, "system error")
        }
    }

    private fun handleCharacteristicRead(
        connection: GattConnection,
        characteristic: BluetoothGattCharacteristic,
        value: ByteArray,
        status: Int,
    ) {
        val pending = takePending(connection, "readBLECharacteristicValue") ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) {
            emitCharacteristic(connection, characteristic, value)
            completeSuccess(pending.apiName, pending.params, pending.response)
        } else completeFailure(pending.apiName, pending.params, pending.response, 10008, "system error")
    }

    private fun emitCharacteristic(connection: GattConnection, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
        val result = JSONObject()
            .put("deviceId", connection.deviceId)
            .put("serviceId", characteristic.service.uuid.toString().uppercase(Locale.ROOT))
            .put("characteristicId", characteristic.uuid.toString().uppercase(Locale.ROOT))
            .put("value", arrayBufferPayload(value))
        characteristicListeners[connection.appId]?.let { emit(it, result) }
    }

    private fun finishPending(connection: GattConnection, apiName: String, status: Int) {
        val pending = takePending(connection, apiName) ?: return
        if (status == BluetoothGatt.GATT_SUCCESS) completeSuccess(apiName, pending.params, pending.response)
        else completeFailure(apiName, pending.params, pending.response, 10008, "system error")
    }

    private fun takePending(connection: GattConnection, apiName: String): PendingCall? {
        val pending = connection.pending
        if (pending?.apiName != apiName) return null
        connection.pending = null
        return pending
    }

    private fun findService(connection: GattConnection, params: JSONObject): android.bluetooth.BluetoothGattService? {
        val serviceId = params.optString("serviceId")
        if (serviceId.isEmpty()) return null
        return connection.gatt?.getService(canonicalUuid(serviceId))
    }

    private fun findCharacteristic(connection: GattConnection, params: JSONObject): BluetoothGattCharacteristic? {
        val service = findService(connection, params) ?: return null
        val characteristicId = params.optString("characteristicId")
        if (characteristicId.isEmpty()) return null
        return service.getCharacteristic(canonicalUuid(characteristicId))
    }

    private fun missingCharacteristic(connection: GattConnection, params: JSONObject, apiName: String): AsyncResult {
        return if (findService(connection, params) == null) failure(apiName, 10004, "no service")
        else failure(apiName, 10005, "no characteristic")
    }

    private fun requireConnection(appId: String, params: JSONObject, apiName: String): GattConnection? {
        val connection = connections[connectionKey(appId, requireDeviceId(params))]
        return connection?.takeIf { it.connected && it.gatt != null }
    }

    private fun requireDeviceId(params: JSONObject): String {
        val deviceId = params.optString("deviceId").trim()
        require(deviceId.isNotEmpty()) { "deviceId is required" }
        return deviceId
    }

    private fun ensureAvailable(activity: DiminaActivity, appId: String, apiName: String): AsyncResult? {
        ensureInitialized(appId, apiName)?.let { return it }
        if (getAdapter(activity)?.isEnabled != true) return failure(apiName, 10001, "not available")
        return null
    }

    private fun ensureInitialized(appId: String, apiName: String): AsyncResult? =
        if (initializedApps.contains(appId)) null else failure(apiName, 10000, "not init")

    private fun getAdapter(context: Context): BluetoothAdapter? =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

    private fun hasBluetoothPermission(context: Context): Boolean {
        val permissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        } else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
        return permissions.all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    }

    private fun ensureSystemReceiver(context: Context) {
        if (receiverContext != null) return
        synchronized(this) {
            if (receiverContext != null) return
            val filter = IntentFilter().apply {
                addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
                addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED)
            }
            ContextCompat.registerReceiver(context, systemReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            receiverContext = context
        }
    }

    private fun stopScanQuietly(context: Context, appId: String) {
        scanCallbacks.remove(appId)?.let { callback ->
            try {
                getAdapter(context)?.bluetoothLeScanner?.stopScan(callback)
            } catch (_: Exception) {
                // Scanner may already be stopped by the system Bluetooth switch.
            }
        }
        scanningApps.remove(appId)
    }

    private fun scanMode(powerLevel: String): Int = when (powerLevel.lowercase(Locale.ROOT)) {
        "low" -> ScanSettings.SCAN_MODE_LOW_POWER
        "high" -> ScanSettings.SCAN_MODE_LOW_LATENCY
        else -> ScanSettings.SCAN_MODE_BALANCED
    }

    private fun addListener(
        store: ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>,
        appId: String,
        params: JSONObject,
        response: (String) -> Unit,
    ): NoneResult {
        val callbackId = params.optString("callbackId", params.optString("success"))
        if (callbackId.isNotEmpty()) store.getOrPut(appId) { ConcurrentHashMap() }[callbackId] = Listener(callbackId, response)
        return NoneResult()
    }

    private fun removeListener(
        store: ConcurrentHashMap<String, ConcurrentHashMap<String, Listener>>,
        appId: String,
        params: JSONObject,
    ): NoneResult {
        val callbackId = params.optString("callbackId")
        if (callbackId.isEmpty()) store.remove(appId) else store[appId]?.remove(callbackId)
        return NoneResult()
    }

    private fun emit(listeners: Map<String, Listener>, result: JSONObject) {
        listeners.values.forEach { listener ->
            listener.response(ApiUtils.createCallbackResponse(listener.callbackId, result))
        }
    }

    private fun emitConnectionState(appId: String, deviceId: String, connected: Boolean) {
        connectionStateListeners[appId]?.let {
            emit(it, JSONObject().put("deviceId", deviceId).put("connected", connected))
        }
    }

    private fun success(apiName: String): AsyncResult = AsyncResult(JSONObject().put("errMsg", "$apiName:ok"))

    private fun failure(apiName: String, errCode: Int, message: String): AsyncResult = AsyncResult(
        JSONObject().put("errCode", errCode).put("errMsg", "$apiName:fail $message"),
    )

    private fun completeSuccess(
        apiName: String,
        params: JSONObject,
        response: (String) -> Unit,
        result: JSONObject = JSONObject(),
    ) {
        if (!result.has("errMsg")) result.put("errMsg", "$apiName:ok")
        ApiUtils.invokeSuccess(params, result, response)
        ApiUtils.invokeComplete(params, response)
    }

    private fun completeFailure(
        apiName: String,
        params: JSONObject,
        response: (String) -> Unit,
        errCode: Int,
        message: String,
    ) {
        ApiUtils.invokeFail(params, failure(apiName, errCode, message).value, response)
        ApiUtils.invokeComplete(params, response)
    }

    private fun connectionKey(appId: String, deviceId: String) = "$appId\u0000$deviceId"

    fun clearApp(appId: String) {
        receiverContext?.let { stopScanQuietly(it, appId) }
        connections.entries.filter { it.value.appId == appId }.forEach { (key, connection) ->
            connection.timeoutTask?.let(mainHandler::removeCallbacks)
            connection.gatt?.disconnect()
            connection.gatt?.close()
            connections.remove(key)
        }
        pairRequests.entries.filter { it.value.appId == appId }.forEach { (deviceId, request) ->
            request.timeoutTask?.let(mainHandler::removeCallbacks)
            pairRequests.remove(deviceId, request)
        }
        initializedApps.remove(appId)
        foundDevices.remove(appId)
        adapterStateListeners.remove(appId)
        deviceFoundListeners.remove(appId)
        connectionStateListeners.remove(appId)
        characteristicListeners.remove(appId)
        mtuListeners.remove(appId)
    }
}
