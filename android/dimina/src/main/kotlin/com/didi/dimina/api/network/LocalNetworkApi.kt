package com.didi.dimina.api.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.util.Base64
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.ArrayDeque

private const val ARRAY_BUFFER_BASE64_KEY = "__diminaArrayBufferBase64"

private data class EventSink(
    val callbackId: String,
    val response: (String) -> Unit,
)

private class UdpState(val appId: String, val socketId: String) {
    val socket = MulticastSocket(null).apply { reuseAddress = true }
    @Volatile var receiving = false
    @Volatile var closed = false
}

private class TcpState(val appId: String, val socketId: String) {
    val socket = Socket()
    @Volatile var receiving = false
    @Volatile var closed = false
}

private class DiscoveryState(
    val appId: String,
    val serviceType: String,
    val manager: NsdManager,
) {
    lateinit var listener: NsdManager.DiscoveryListener
    @Volatile var started = false
    @Volatile var stopping = false
    var stopParams: JSONObject? = null
    var stopResponse: ((String) -> Unit)? = null
    val pendingServices = ArrayDeque<NsdServiceInfo>()
    var resolving = false
}

/** WeChat-compatible mDNS, UDP socket, and TCP client bridge. */
class LocalNetworkApi : BaseApiHandler() {
    companion object {
        internal val SUPPORTED_API_NAMES = setOf(
            "startLocalServiceDiscovery", "stopLocalServiceDiscovery",
            "onLocalServiceDiscoveryStop", "offLocalServiceDiscoveryStop",
            "onLocalServiceFound", "offLocalServiceFound",
            "onLocalServiceLost", "offLocalServiceLost",
            "onLocalServiceResolveFail", "offLocalServiceResolveFail",
            "UDPSocket.bind", "UDPSocket.close", "UDPSocket.connect", "UDPSocket.send",
            "UDPSocket.write", "UDPSocket.setTTL",
            "UDPSocket.onClose", "UDPSocket.offClose", "UDPSocket.onError", "UDPSocket.offError",
            "UDPSocket.onListening", "UDPSocket.offListening", "UDPSocket.onMessage", "UDPSocket.offMessage",
            "TCPSocket.bindWifi", "TCPSocket.close", "TCPSocket.connect", "TCPSocket.write",
            "TCPSocket.onBindWifi", "TCPSocket.offBindWifi", "TCPSocket.onClose", "TCPSocket.offClose",
            "TCPSocket.onConnect", "TCPSocket.offConnect", "TCPSocket.onError", "TCPSocket.offError",
            "TCPSocket.onMessage", "TCPSocket.offMessage",
        )
    }

    override val apiNames = SUPPORTED_API_NAMES

    private val executor = Executors.newCachedThreadPool()
    private val udpSockets = ConcurrentHashMap<String, UdpState>()
    private val tcpSockets = ConcurrentHashMap<String, TcpState>()
    private val discoveries = ConcurrentHashMap<String, DiscoveryState>()
    private val listeners = ConcurrentHashMap<String, EventSink>()

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            when (apiName) {
                "startLocalServiceDiscovery" -> startDiscovery(activity, appId, params, responseCallback)
                "stopLocalServiceDiscovery" -> stopDiscovery(appId, params, responseCallback)
                "onLocalServiceDiscoveryStop", "onLocalServiceFound", "onLocalServiceLost",
                "onLocalServiceResolveFail", "UDPSocket.onClose", "UDPSocket.onError",
                "UDPSocket.onListening", "UDPSocket.onMessage", "TCPSocket.onBindWifi",
                "TCPSocket.onClose", "TCPSocket.onConnect", "TCPSocket.onError", "TCPSocket.onMessage" -> {
                    addListener(appId, apiName, params, responseCallback)
                    NoneResult()
                }
                "offLocalServiceDiscoveryStop", "offLocalServiceFound", "offLocalServiceLost",
                "offLocalServiceResolveFail", "UDPSocket.offClose", "UDPSocket.offError",
                "UDPSocket.offListening", "UDPSocket.offMessage", "TCPSocket.offBindWifi",
                "TCPSocket.offClose", "TCPSocket.offConnect", "TCPSocket.offError", "TCPSocket.offMessage" -> {
                    removeListener(appId, apiName, params)
                    NoneResult()
                }
                "UDPSocket.bind" -> bindUdp(appId, params, apiName)
                "UDPSocket.close" -> { closeUdp(appId, params); NoneResult() }
                "UDPSocket.connect" -> { connectUdp(appId, params); NoneResult() }
                "UDPSocket.send", "UDPSocket.write" -> { sendUdp(appId, params); NoneResult() }
                "UDPSocket.setTTL" -> { setUdpTtl(appId, params); NoneResult() }
                "TCPSocket.bindWifi" -> { bindTcpWifi(activity, appId, params); NoneResult() }
                "TCPSocket.close" -> { closeTcp(appId, params); NoneResult() }
                "TCPSocket.connect" -> { connectTcp(appId, params); NoneResult() }
                "TCPSocket.write" -> { writeTcp(appId, params); NoneResult() }
                else -> super.handleAction(activity, appId, apiName, params, responseCallback)
            }
        } catch (error: Exception) {
            if (apiName == "UDPSocket.bind") {
                SyncResult(JSValue.createError("$apiName:fail ${error.message ?: "operation failed"}"))
            } else if (apiName.startsWith("UDPSocket.") || apiName.startsWith("TCPSocket.")) {
                val event = if (apiName.startsWith("UDPSocket.")) "UDPSocket.onError" else "TCPSocket.onError"
                emitError(appId, event, params.optString("socketId", ""), error)
                NoneResult()
            } else {
                AsyncResult(JSONObject().put("errMsg", "$apiName:fail ${error.message ?: "operation failed"}"))
            }
        }
    }

    private fun bindUdp(appId: String, params: JSONObject, apiName: String): SyncResult {
        val state = udpState(appId, socketId(params))
        if (state.socket.isBound) return SyncResult(JSValue.createNumber(state.socket.localPort.toDouble()))
        val port = params.optInt("port", 0)
        require(port in 0..65535) { "invalid port" }
        state.socket.bind(InetSocketAddress(port))
        startUdpReceive(state)
        emit(appId, "UDPSocket.onListening", state.socketId, JSONObject())
        return SyncResult(JSValue.createNumber(state.socket.localPort.toDouble()))
    }

    private fun connectUdp(appId: String, params: JSONObject) {
        val state = udpState(appId, socketId(params))
        val address = requiredString(params, "address")
        val port = requiredPort(params)
        executor.execute {
            try {
                ensureUdpBound(state)
                state.socket.connect(InetAddress.getByName(address), port)
            } catch (error: Exception) {
                emitError(appId, "UDPSocket.onError", state.socketId, error)
            }
        }
    }

    private fun sendUdp(appId: String, params: JSONObject) {
        val state = udpState(appId, socketId(params))
        val address = requiredString(params, "address")
        val port = requiredPort(params)
        val message = params.opt("message")
        val bytes = messageBytes(message)
        val isArrayBuffer = message is JSONObject && message.has(ARRAY_BUFFER_BASE64_KEY)
        val offset = if (isArrayBuffer) params.optInt("offset", 0).coerceAtLeast(0) else 0
        val defaultLength = (bytes.size - offset).coerceAtLeast(0)
        val length = if (isArrayBuffer) params.optInt("length", defaultLength).coerceAtMost(defaultLength) else bytes.size
        require(offset <= bytes.size && length >= 0) { "invalid offset or length" }
        executor.execute {
            try {
                ensureUdpBound(state)
                if (params.optBoolean("setBroadcast", false)) state.socket.broadcast = true
                state.socket.send(DatagramPacket(bytes, offset, length, InetAddress.getByName(address), port))
            } catch (error: Exception) {
                emitError(appId, "UDPSocket.onError", state.socketId, error)
            }
        }
    }

    private fun setUdpTtl(appId: String, params: JSONObject) {
        val ttl = params.optInt("ttl", -1)
        require(ttl in 0..255) { "ttl must be between 0 and 255" }
        udpState(appId, socketId(params)).socket.timeToLive = ttl
    }

    private fun ensureUdpBound(state: UdpState) {
        if (!state.socket.isBound) {
            synchronized(state) {
                if (!state.socket.isBound) {
                    state.socket.bind(InetSocketAddress(0))
                    startUdpReceive(state)
                    emit(state.appId, "UDPSocket.onListening", state.socketId, JSONObject())
                }
            }
        }
    }

    private fun startUdpReceive(state: UdpState) {
        if (state.receiving) return
        state.receiving = true
        executor.execute {
            val buffer = ByteArray(65_507)
            while (!state.closed) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    state.socket.receive(packet)
                    val local = state.socket.localAddress
                    val result = JSONObject()
                        .put("message", encodedBytes(packet.data.copyOfRange(packet.offset, packet.offset + packet.length)))
                        .put("remoteInfo", addressInfo(packet.address, packet.port, packet.length))
                        .put("localInfo", addressInfo(local, state.socket.localPort, null))
                    emit(state.appId, "UDPSocket.onMessage", state.socketId, result)
                } catch (error: Exception) {
                    if (!state.closed) emitError(state.appId, "UDPSocket.onError", state.socketId, error)
                    break
                }
            }
        }
    }

    private fun closeUdp(appId: String, params: JSONObject) {
        val id = socketId(params)
        val state = udpSockets.remove(socketKey(appId, id)) ?: return
        state.closed = true
        state.socket.close()
        emit(appId, "UDPSocket.onClose", id, JSONObject())
        clearSocketListeners(appId, "UDPSocket", id)
    }

    private fun bindTcpWifi(activity: DiminaActivity, appId: String, params: JSONObject) {
        val state = tcpState(appId, socketId(params))
        val requestedBssid = requiredString(params, "BSSID")
        activity.handleNearbyWifiPermission { granted ->
            if (!granted) {
                emitError(appId, "TCPSocket.onError", state.socketId, SecurityException("permission denied"))
                return@handleNearbyWifiPermission
            }
            performBindTcpWifi(activity, appId, state, requestedBssid)
        }
    }

    @Suppress("DEPRECATION")
    private fun performBindTcpWifi(
        activity: DiminaActivity,
        appId: String,
        state: TcpState,
        requestedBssid: String,
    ) {
        executor.execute {
            try {
                val manager = activity.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                    @Suppress("DEPRECATION")
                    val currentBssid = (activity.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                        .connectionInfo?.bssid
                    if (!currentBssid.equals(requestedBssid, ignoreCase = true)) {
                        throw IllegalStateException("wifi network not found")
                    }
                }
                val network = manager.allNetworks.firstOrNull { candidate ->
                    val capabilities = manager.getNetworkCapabilities(candidate) ?: return@firstOrNull false
                    if (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return@firstOrNull false
                    Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
                        wifiBssid(capabilities)?.equals(requestedBssid, ignoreCase = true) == true
                } ?: throw IllegalStateException("wifi network not found")
                network.bindSocket(state.socket)
                emit(appId, "TCPSocket.onBindWifi", state.socketId, JSONObject())
            } catch (error: Exception) {
                emitError(appId, "TCPSocket.onError", state.socketId, error)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun wifiBssid(capabilities: NetworkCapabilities): String? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        return (capabilities.transportInfo as? WifiInfo)?.bssid
    }

    private fun connectTcp(appId: String, params: JSONObject) {
        val state = tcpState(appId, socketId(params))
        val address = requiredString(params, "address")
        val port = requiredPort(params)
        val timeoutMs = (params.optDouble("timeout", 2.0).coerceAtLeast(0.0) * 1000).toInt()
        executor.execute {
            try {
                state.socket.connect(InetSocketAddress(address, port), timeoutMs)
                emit(appId, "TCPSocket.onConnect", state.socketId, JSONObject())
                startTcpReceive(state)
            } catch (error: Exception) {
                state.closed = true
                try { state.socket.close() } catch (_: Exception) {}
                tcpSockets.remove(socketKey(appId, state.socketId), state)
                emitError(appId, "TCPSocket.onError", state.socketId, error)
            }
        }
    }

    private fun writeTcp(appId: String, params: JSONObject) {
        val state = tcpState(appId, socketId(params))
        val bytes = messageBytes(params.opt("data"))
        executor.execute {
            try {
                state.socket.getOutputStream().apply { write(bytes); flush() }
            } catch (error: Exception) {
                emitError(appId, "TCPSocket.onError", state.socketId, error)
            }
        }
    }

    private fun startTcpReceive(state: TcpState) {
        if (state.receiving) return
        state.receiving = true
        try {
            val input = state.socket.getInputStream()
            val buffer = ByteArray(16 * 1024)
            while (!state.closed) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count == 0) continue
                val remote = state.socket.remoteSocketAddress as? InetSocketAddress
                val local = state.socket.localSocketAddress as? InetSocketAddress
                val result = JSONObject()
                    .put("message", encodedBytes(buffer.copyOf(count)))
                    .put("remoteInfo", addressInfo(remote?.address, remote?.port ?: 0, null))
                    .put("localInfo", addressInfo(local?.address, local?.port ?: 0, null))
                emit(state.appId, "TCPSocket.onMessage", state.socketId, result)
            }
            if (!state.closed) closeTcpState(state)
        } catch (error: Exception) {
            if (!state.closed) {
                emitError(state.appId, "TCPSocket.onError", state.socketId, error)
                closeTcpState(state)
            }
        }
    }

    private fun closeTcp(appId: String, params: JSONObject) {
        val id = socketId(params)
        tcpSockets.remove(socketKey(appId, id))?.let(::closeTcpState)
    }

    private fun closeTcpState(state: TcpState) {
        if (state.closed) return
        state.closed = true
        try { state.socket.close() } catch (_: Exception) {}
        tcpSockets.remove(socketKey(state.appId, state.socketId), state)
        emit(state.appId, "TCPSocket.onClose", state.socketId, JSONObject())
        clearSocketListeners(state.appId, "TCPSocket", state.socketId)
    }

    private fun startDiscovery(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        response: (String) -> Unit,
    ): APIResult {
        val serviceType = params.optString("serviceType", "").trim()
        if (serviceType.isEmpty()) return AsyncResult(JSONObject().put("errMsg", "startLocalServiceDiscovery:fail invalid param"))
        if (discoveries.containsKey(appId)) {
            return AsyncResult(JSONObject().put("errMsg", "startLocalServiceDiscovery:fail scan task already exist"))
        }
        val manager = activity.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        val state = DiscoveryState(appId, serviceType, manager)
        state.listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(regType: String) {
                state.started = true
                completeSuccess("startLocalServiceDiscovery", params, response)
            }

            override fun onServiceFound(service: NsdServiceInfo) = resolveService(state, service)

            override fun onServiceLost(service: NsdServiceInfo) {
                emit(appId, "onLocalServiceLost", null, serviceResult(serviceType, service.serviceName))
            }

            override fun onDiscoveryStopped(serviceType: String) {
                discoveries.remove(appId, state)
                emit(appId, "onLocalServiceDiscoveryStop", null, JSONObject())
                state.stopParams?.let { stopParams ->
                    state.stopResponse?.let { stopResponse ->
                        completeSuccess("stopLocalServiceDiscovery", stopParams, stopResponse)
                    }
                }
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                discoveries.remove(appId, state)
                completeFailure("startLocalServiceDiscovery", params, response, "error $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                state.stopping = false
                val stopParams = state.stopParams
                val stopResponse = state.stopResponse
                state.stopParams = null
                state.stopResponse = null
                if (stopParams != null && stopResponse != null) {
                    completeFailure("stopLocalServiceDiscovery", stopParams, stopResponse, "error $errorCode")
                }
            }
        }
        discoveries[appId] = state
        return try {
            manager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, state.listener)
            NoneResult()
        } catch (error: Exception) {
            discoveries.remove(appId, state)
            AsyncResult(JSONObject().put("errMsg", "startLocalServiceDiscovery:fail ${error.message}"))
        }
    }

    @Suppress("DEPRECATION")
    private fun resolveService(state: DiscoveryState, service: NsdServiceInfo) {
        synchronized(state) {
            state.pendingServices.addLast(service)
            if (state.resolving) return
            state.resolving = true
        }
        resolveNextService(state)
    }

    @Suppress("DEPRECATION")
    private fun resolveNextService(state: DiscoveryState) {
        val service = synchronized(state) {
            if (state.pendingServices.isEmpty()) {
                state.resolving = false
                return
            }
            state.pendingServices.removeFirst()
        }
        try {
            state.manager.resolveService(service, object : NsdManager.ResolveListener {
                override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                    emit(state.appId, "onLocalServiceResolveFail", null, serviceResult(state.serviceType, serviceInfo.serviceName))
                    resolveNextService(state)
                }

                override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                    val result = serviceResult(state.serviceType, serviceInfo.serviceName)
                        .put("ip", serviceInfo.host?.hostAddress ?: "")
                        .put("port", serviceInfo.port)
                    emit(state.appId, "onLocalServiceFound", null, result)
                    resolveNextService(state)
                }
            })
        } catch (_: Exception) {
            emit(state.appId, "onLocalServiceResolveFail", null, serviceResult(state.serviceType, service.serviceName))
            resolveNextService(state)
        }
    }

    private fun stopDiscovery(appId: String, params: JSONObject, response: (String) -> Unit): APIResult {
        val state = discoveries[appId] ?: return AsyncResult(JSONObject().put("errMsg", "stopLocalServiceDiscovery:ok"))
        if (state.stopping) return NoneResult()
        state.stopping = true
        state.stopParams = params
        state.stopResponse = response
        return try {
            state.manager.stopServiceDiscovery(state.listener)
            NoneResult()
        } catch (error: Exception) {
            state.stopping = false
            state.stopParams = null
            state.stopResponse = null
            AsyncResult(JSONObject().put("errMsg", "stopLocalServiceDiscovery:fail ${error.message}"))
        }
    }

    private fun addListener(appId: String, event: String, params: JSONObject, response: (String) -> Unit) {
        val callbackId = params.optString("callbackId", params.optString("success", ""))
        if (callbackId.isNotEmpty()) listeners[eventKey(appId, event, params.optString("socketId", ""))] = EventSink(callbackId, response)
    }

    private fun removeListener(appId: String, offEvent: String, params: JSONObject) {
        val event = offEvent.replaceFirst("off", "on").replace(".off", ".on")
        listeners.remove(eventKey(appId, event, params.optString("socketId", "")))
    }

    private fun emit(appId: String, event: String, socketId: String?, result: JSONObject) {
        val sink = listeners[eventKey(appId, event, socketId ?: "")] ?: return
        sink.response(ApiUtils.createCallbackResponse(sink.callbackId, result))
    }

    private fun emitError(appId: String, event: String, socketId: String, error: Exception) {
        emit(appId, event, socketId, JSONObject().put("errMsg", error.message ?: "operation failed"))
    }

    private fun udpState(appId: String, socketId: String) =
        udpSockets.computeIfAbsent(socketKey(appId, socketId)) { UdpState(appId, socketId) }

    private fun tcpState(appId: String, socketId: String) =
        tcpSockets.computeIfAbsent(socketKey(appId, socketId)) { TcpState(appId, socketId) }

    private fun socketId(params: JSONObject) = requiredString(params, "socketId")
    private fun socketKey(appId: String, socketId: String) = "$appId\u0000$socketId"
    private fun eventKey(appId: String, event: String, socketId: String) = "$appId\u0000$event\u0000$socketId"

    private fun clearSocketListeners(appId: String, type: String, socketId: String) {
        listeners.keys.removeAll { it.startsWith("$appId\u0000$type.") && it.endsWith("\u0000$socketId") }
    }

    private fun requiredString(params: JSONObject, key: String): String {
        val value = params.optString(key, "")
        require(value.isNotEmpty()) { "$key is required" }
        return value
    }

    private fun requiredPort(params: JSONObject): Int {
        val port = params.optInt("port", -1)
        require(port in 0..65535) { "invalid port" }
        return port
    }

    private fun messageBytes(value: Any?): ByteArray {
        if (value is String) return value.toByteArray(StandardCharsets.UTF_8)
        if (value is JSONObject && value.has(ARRAY_BUFFER_BASE64_KEY)) {
            return Base64.decode(value.optString(ARRAY_BUFFER_BASE64_KEY), Base64.DEFAULT)
        }
        throw IllegalArgumentException("message must be a string or ArrayBuffer")
    }

    private fun encodedBytes(bytes: ByteArray) = JSONObject()
        .put(ARRAY_BUFFER_BASE64_KEY, Base64.encodeToString(bytes, Base64.NO_WRAP))

    private fun addressInfo(address: InetAddress?, port: Int, size: Int?): JSONObject {
        val result = JSONObject()
            .put("address", address?.hostAddress ?: "")
            .put("family", when (address) {
                is Inet6Address -> "IPv6"
                is Inet4Address -> "IPv4"
                else -> "IPv4"
            })
            .put("port", port)
        if (size != null) result.put("size", size)
        return result
    }

    private fun serviceResult(serviceType: String, serviceName: String) = JSONObject()
        .put("serviceType", serviceType)
        .put("serviceName", serviceName)

    private fun completeSuccess(apiName: String, params: JSONObject, response: (String) -> Unit) {
        ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "$apiName:ok"), response)
        ApiUtils.invokeComplete(params, response)
    }

    private fun completeFailure(apiName: String, params: JSONObject, response: (String) -> Unit, message: String) {
        ApiUtils.invokeFail(params, JSONObject().put("errMsg", "$apiName:fail $message"), response)
        ApiUtils.invokeComplete(params, response)
    }

    fun clearApp(appId: String) {
        discoveries.remove(appId)?.let { state ->
            try { state.manager.stopServiceDiscovery(state.listener) } catch (_: Exception) {}
        }
        udpSockets.entries.filter { it.value.appId == appId }.forEach { (key, state) ->
            state.closed = true
            state.socket.close()
            udpSockets.remove(key)
        }
        tcpSockets.entries.filter { it.value.appId == appId }.forEach { (key, state) ->
            state.closed = true
            try { state.socket.close() } catch (_: Exception) {}
            tcpSockets.remove(key)
        }
        listeners.keys.removeAll { it.startsWith("$appId\u0000") }
    }
}
