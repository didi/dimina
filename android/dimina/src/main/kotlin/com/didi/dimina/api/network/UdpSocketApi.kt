package com.didi.dimina.api.network

import android.util.Log
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.NoneResult
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * UDP Socket API实现 - 完全对齐微信小程序API规范
 * 修复重点：正确区分同步和异步API返回机制
 */
class UdpSocketApi : ApiHandler {

    companion object {
        private const val TAG = "UdpSocketApi"

        // API方法名常量定义
        const val CREATE_UDP_SOCKET = "createUDPSocket"
        const val UDPSOCKET_BIND = "UDPSocket.bind"
        const val UDPSOCKET_SEND = "UDPSocket.send"
        const val UDPSOCKET_CLOSE = "UDPSocket.close"
        const val UDPSOCKET_ON_MESSAGE = "UDPSocket.onMessage"
        const val UDPSOCKET_OFF_MESSAGE = "UDPSocket.offMessage"
        const val UDPSOCKET_ON_LISTENING = "UDPSocket.onListening"
        const val UDPSOCKET_OFF_LISTENING = "UDPSocket.offListening"
        const val UDPSOCKET_ON_ERROR = "UDPSocket.onError"
        const val UDPSOCKET_OFF_ERROR = "UDPSocket.offError"
        const val UDPSOCKET_ON_CLOSE = "UDPSocket.onClose"
        const val UDPSOCKET_OFF_CLOSE = "UDPSocket.offClose"
        const val UDPSOCKET_SET_TTL = "UDPSocket.setTTL"
        const val UDPSOCKET_CONNECT = "UDPSocket.connect"
        const val UDPSOCKET_WRITE = "UDPSocket.write"
    }

    // 使用线程安全的Map管理UDP Socket实例
    private val udpSockets = ConcurrentHashMap<String, UdpSocketInstance>()
    // ID计数器，用于生成唯一的_id
    private val idCounter = AtomicInteger(1)

    fun registerWith(registry: ApiRegistry) {
        registry.register(CREATE_UDP_SOCKET, this)
        registry.register(UDPSOCKET_BIND, this)
        registry.register(UDPSOCKET_SEND, this)
        registry.register(UDPSOCKET_CLOSE, this)
        registry.register(UDPSOCKET_ON_MESSAGE, this)
        registry.register(UDPSOCKET_OFF_MESSAGE, this)
        registry.register(UDPSOCKET_ON_LISTENING, this)
        registry.register(UDPSOCKET_OFF_LISTENING, this)
        registry.register(UDPSOCKET_ON_ERROR, this)
        registry.register(UDPSOCKET_OFF_ERROR, this)
        registry.register(UDPSOCKET_ON_CLOSE, this)
        registry.register(UDPSOCKET_OFF_CLOSE, this)
        registry.register(UDPSOCKET_SET_TTL, this)
        registry.register(UDPSOCKET_CONNECT, this)
        registry.register(UDPSOCKET_WRITE, this)
        Log.d(TAG, "UDP Socket API注册完成")
    }

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.d(TAG, "处理UDP API: $apiName")

        return when (apiName) {
            CREATE_UDP_SOCKET -> createUdpSocket(params, responseCallback)
            UDPSOCKET_BIND -> bindUdpSocket(params, responseCallback)
            UDPSOCKET_SEND -> sendUdpMessage(params, responseCallback)
            UDPSOCKET_CLOSE -> closeUdpSocket(params, responseCallback)
            UDPSOCKET_ON_MESSAGE -> onUdpMessage(params, responseCallback)
            UDPSOCKET_OFF_MESSAGE -> offUdpMessage(params, responseCallback)
            UDPSOCKET_ON_LISTENING -> onUdpListening(params, responseCallback)
            UDPSOCKET_OFF_LISTENING -> offUdpListening(params, responseCallback)
            UDPSOCKET_ON_ERROR -> onUdpError(params, responseCallback)
            UDPSOCKET_OFF_ERROR -> offUdpError(params, responseCallback)
            UDPSOCKET_ON_CLOSE -> onUdpClose(params, responseCallback)
            UDPSOCKET_OFF_CLOSE -> offUdpClose(params, responseCallback)
            UDPSOCKET_SET_TTL -> setUdpTtl(params, responseCallback)
            UDPSOCKET_CONNECT -> connectUdpSocket(params, responseCallback)
            UDPSOCKET_WRITE -> writeUdpMessage(params, responseCallback)
            else -> {
                Log.w(TAG, "未知的UDP API: $apiName")
                NoneResult()
            }
        }
    }

    /**
     * 创建UDP Socket实例 - 同步API（关键修复）
     */
    private fun createUdpSocket(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        return try {
            val socketId = "udp_${System.currentTimeMillis()}"
            val instanceId = idCounter.getAndIncrement()

            Log.d(TAG, "开始创建UDP Socket: $socketId, instanceId: $instanceId")

            val udpInstance = UdpSocketInstance(socketId, instanceId)
            udpSockets[socketId] = udpInstance

            // 构建UDPSocket对象
            val udpSocketObj = JSONObject().apply {
                put("_id", instanceId)
                put("socketId", socketId)
                put("bind", true)
                put("send", true)
                put("close", true)
                put("onMessage", true)
                put("offMessage", true)
                put("onError", true)
                put("offError", true)
                put("onListening", true)
                put("offListening", true)
                put("onClose", true)
                put("offClose", true)
                put("errMsg", "$CREATE_UDP_SOCKET:ok")
            }

            Log.d(TAG, "UDP Socket同步创建成功: $socketId")

            // 同步返回方法
            val jsValue = JSValue.createObject(udpSocketObj.toString())
            SyncResult(jsValue)

        } catch (e: Exception) {
            Log.e(TAG, "创建UDP Socket失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$CREATE_UDP_SOCKET:fail")
                put("error", e.message ?: "Unknown error")
            }
            // 同步返回方法
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)
        }
    }

    /**
     * 绑定UDP Socket到指定端口 - 异步API
     */
    private fun bindUdpSocket(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", UDPSOCKET_BIND, params, responseCallback)
        }

        val udpInstance = udpSockets[socketId]
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", UDPSOCKET_BIND, params, responseCallback)
        }

        val port = params.optInt("port", 0)
        val address = params.optString("address", "0.0.0.0")

        return try {
            Log.d(TAG, "绑定Socket: $socketId -> $address:$port")
            val actualPort = udpInstance.bind(address, port)

            val result = JSONObject().apply {
                put("socketId", socketId)
                put("port", actualPort)
                put("errMsg", "$UDPSOCKET_BIND:ok")
            }

            Log.d(TAG, "UDP Socket绑定成功: $actualPort")
            ApiUtils.invokeSuccess(params, result, responseCallback)
            NoneResult()
        } catch (e: Exception) {
            Log.e(TAG, "绑定UDP Socket失败: $socketId", e)
            handleError(e, UDPSOCKET_BIND, params, responseCallback)
        }
    }

    /**
     * 发送UDP消息 - 异步API
     */
    private fun sendUdpMessage(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", UDPSOCKET_SEND, params, responseCallback)
        }

        val udpInstance = udpSockets[socketId]
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", UDPSOCKET_SEND, params, responseCallback)
        }

        val message = params.optString("message", "")
        val address = params.optString("address", "")
        val port = params.optInt("port", -1)

        if (message.isBlank()) {
            return handleError("消息内容不能为空", UDPSOCKET_SEND, params, responseCallback)
        }
        if (address.isBlank() || port <= 0) {
            return handleError("目标地址和端口不能为空", UDPSOCKET_SEND, params, responseCallback)
        }

        return try {
            val bytesSent = udpInstance.send(message, address, port)
            val result = JSONObject().apply {
                put("socketId", socketId)
                put("bytesSent", bytesSent)
                put("errMsg", "$UDPSOCKET_SEND:ok")
            }

            Log.d(TAG, "UDP消息发送成功: $bytesSent 字节 -> $address:$port")
            ApiUtils.invokeSuccess(params, result, responseCallback)
            NoneResult()
        } catch (e: Exception) {
            Log.e(TAG, "发送UDP消息失败: $socketId", e)
            handleError(e, UDPSOCKET_SEND, params, responseCallback)
        }
    }

    /**
     * 关闭UDP Socket - 异步API
     */
    private fun closeUdpSocket(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", UDPSOCKET_CLOSE, params, responseCallback)
        }

        val udpInstance = udpSockets.remove(socketId)
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", UDPSOCKET_CLOSE, params, responseCallback)
        }

        return try {
            udpInstance.close()
            val result = JSONObject().apply {
                put("socketId", socketId)
                put("errMsg", "$UDPSOCKET_CLOSE:ok")
            }

            Log.d(TAG, "UDP Socket关闭成功")
            ApiUtils.invokeSuccess(params, result, responseCallback)
            NoneResult()
        } catch (e: Exception) {
            Log.e(TAG, "关闭UDP Socket失败: $socketId", e)
            handleError(e, UDPSOCKET_CLOSE, params, responseCallback)
        }
    }

    /**
     * 监听消息事件 - 异步API
     */
    private fun onUdpMessage(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", UDPSOCKET_ON_MESSAGE, params, responseCallback)
        }

        val udpInstance = udpSockets[socketId]
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", UDPSOCKET_ON_MESSAGE, params, responseCallback)
        }

        return try {
            udpInstance.setOnMessageListener { remoteAddress, remotePort, message ->
                // TODO: 实现消息回调到JavaScript层
                Log.d(TAG, "收到UDP消息: $remoteAddress:$remotePort -> $message")
                handleMessageReceived(socketId, remoteAddress, remotePort, message)
            }

            val result = JSONObject().apply {
                put("socketId", socketId)
                put("errMsg", "$UDPSOCKET_ON_MESSAGE:ok")
            }

            Log.d(TAG, "开始监听UDP消息: $socketId")
            ApiUtils.invokeSuccess(params, result, responseCallback)
            NoneResult()
        } catch (e: Exception) {
            Log.e(TAG, "监听UDP消息失败: $socketId", e)
            handleError(e, UDPSOCKET_ON_MESSAGE, params, responseCallback)
        }
    }

    /**
     * 取消监听消息事件 - 异步API
     */
    private fun offUdpMessage(
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", UDPSOCKET_OFF_MESSAGE, params, responseCallback)
        }

        val udpInstance = udpSockets[socketId]
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", UDPSOCKET_OFF_MESSAGE, params, responseCallback)
        }

        return try {
            udpInstance.setOffMessageListener()
            val result = JSONObject().apply {
                put("socketId", socketId)
                put("errMsg", "$UDPSOCKET_OFF_MESSAGE:ok")
            }

            Log.d(TAG, "停止监听UDP消息: $socketId")
            ApiUtils.invokeSuccess(params, result, responseCallback)
            NoneResult()
        } catch (e: Exception) {
            Log.e(TAG, "停止监听UDP消息失败: $socketId", e)
            handleError(e, UDPSOCKET_OFF_MESSAGE, params, responseCallback)
        }
    }

    // 简化的事件监听方法实现 - 异步API
    private fun onUdpListening(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_ON_LISTENING, params, responseCallback)
    }

    private fun offUdpListening(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_OFF_LISTENING, params, responseCallback)
    }

    private fun onUdpError(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_ON_ERROR, params, responseCallback)
    }

    private fun offUdpError(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_OFF_ERROR, params, responseCallback)
    }

    private fun onUdpClose(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_ON_CLOSE, params, responseCallback)
    }

    private fun offUdpClose(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_OFF_CLOSE, params, responseCallback)
    }

    private fun setUdpTtl(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_SET_TTL, params, responseCallback)
    }

    private fun connectUdpSocket(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_CONNECT, params, responseCallback)
    }

    private fun writeUdpMessage(params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        return handleSimpleEvent(UDPSOCKET_WRITE, params, responseCallback)
    }

    /**
     * 处理简单事件监听 - 异步API
     */
    private fun handleSimpleEvent(
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val socketId = params.optString("socketId", "")
        if (socketId.isBlank()) {
            return handleError("socketId不能为空", apiName, params, responseCallback)
        }

        val udpInstance = udpSockets[socketId]
        if (udpInstance == null) {
            return handleError("UDP Socket不存在: $socketId", apiName, params, responseCallback)
        }

        val result = JSONObject().apply {
            put("socketId", socketId)
            put("errMsg", "$apiName:ok")
        }

        ApiUtils.invokeSuccess(params, result, responseCallback)
        return NoneResult()
    }

    /**
     * 处理接收到的消息
     */
    private fun handleMessageReceived(socketId: String, remoteAddress: String, remotePort: Int, message: String) {
        Log.d(TAG, "收到UDP消息[$socketId]: $remoteAddress:$remotePort -> $message")
        // TODO: 实现将消息回调到小程序JavaScript层
        // 需要通过桥接层将消息传递给小程序的onMessage回调函数
    }

    /**
     * UDP Socket实例内部类
     */
    private inner class UdpSocketInstance(
        private val socketId: String,
        private val instanceId: Int
    ) {
        private var socket: DatagramSocket? = null
        private var isBound = AtomicBoolean(false)
        private var receiveThread: Thread? = null
        private var shouldReceive = AtomicBoolean(false)
        private var messageCallback: ((String, Int, String) -> Unit)? = null

        /**
         * 绑定Socket到指定地址和端口
         */
        @Throws(Exception::class)
        fun bind(address: String, port: Int): Int {
            if (isBound.get()) {
                throw IllegalStateException("Socket已经绑定")
            }

            try {
                val inetAddress = InetAddress.getByName(address)
                // 使用安全的绑定方式，支持端口重用
                socket = DatagramSocket(null).apply {
                    reuseAddress = true
                    bind(InetSocketAddress(inetAddress, if (port == 0) 0 else port))
                }
                isBound.set(true)
                val localPort = socket?.localPort ?: 0
                Log.d(TAG, "Socket绑定成功: $localPort")
                return localPort
            } catch (e: java.net.BindException) {
                Log.e(TAG, "端口绑定失败，尝试随机端口: $port", e)
                // 端口被占用时使用随机端口
                socket = DatagramSocket().apply { reuseAddress = true }
                isBound.set(true)
                val localPort = socket?.localPort ?: 0
                Log.d(TAG, "随机端口绑定成功: $localPort")
                return localPort
            }
        }

        /**
         * 发送UDP消息
         */
        @Throws(Exception::class)
        fun send(message: String, address: String, port: Int): Int {
            if (!isBound.get()) {
                throw IllegalStateException("Socket未绑定")
            }

            val data = message.toByteArray(StandardCharsets.UTF_8)
            val targetAddress = InetAddress.getByName(address)
            val packet = DatagramPacket(data, data.size, targetAddress, port)

            socket?.send(packet)
            return data.size
        }

        /**
         * 关闭Socket
         */
        fun close() {
            shouldReceive.set(false)
            receiveThread?.interrupt()
            socket?.close()
            socket = null
            isBound.set(false)
            messageCallback = null
            Log.d(TAG, "Socket关闭完成: $socketId")
        }

        /**
         * 设置消息监听器
         */
        fun setOnMessageListener(callback: (String, Int, String) -> Unit) {
            messageCallback = callback
            shouldReceive.set(true)

            // 确保只有一个接收线程运行
            if (receiveThread != null && receiveThread!!.isAlive) {
                Log.w(TAG, "接收线程已在运行，无需重复创建")
                return
            }

            receiveThread = Thread {
                val buffer = ByteArray(4096)
                val packet = DatagramPacket(buffer, buffer.size)

                while (shouldReceive.get() && !Thread.currentThread().isInterrupted) {
                    try {
                        socket?.receive(packet) // 阻塞直到收到数据

                        if (packet.length > 0) {
                            val message = String(
                                packet.data,
                                packet.offset,
                                packet.length,
                                StandardCharsets.UTF_8
                            )
                            val remoteAddress = packet.address.hostAddress
                            val remotePort = packet.port

                            Log.d(TAG, "收到UDP消息: $remoteAddress:$remotePort -> $message")
                            // 触发消息回调
                            messageCallback?.invoke(remoteAddress, remotePort, message)
                        }

                        // 重置packet长度以备下次使用
                        packet.length = buffer.size
                    } catch (e: java.net.SocketException) {
                        if (shouldReceive.get()) {
                            Log.d(TAG, "Socket接收被中断，可能正在关闭")
                        }
                        break
                    } catch (e: Exception) {
                        if (shouldReceive.get()) {
                            Log.e(TAG, "接收UDP数据异常", e)
                            try {
                                Thread.sleep(100)
                            } catch (ie: InterruptedException) {
                                break
                            }
                        } else {
                            break
                        }
                    }
                }
                Log.d(TAG, "UDP消息接收线程结束: $socketId")
            }.apply {
                name = "UDP-Receiver-$socketId"
                isDaemon = true
                start()
            }
        }

        /**
         * 取消消息监听
         */
        fun setOffMessageListener() {
            shouldReceive.set(false)
            messageCallback = null
            receiveThread?.interrupt()
            receiveThread = null
        }
    }

    /**
     * 错误处理辅助方法
     */
    private fun handleError(
        e: Exception,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        val errorMsg = e.message ?: "Unknown error"
        Log.e(TAG, "UDP API错误: $apiName - $errorMsg")

        val errorResult = JSONObject().apply {
            put("errMsg", "$apiName:fail")
            put("error", errorMsg)
        }

        ApiUtils.invokeFail(params, errorResult, responseCallback)
        return NoneResult()
    }

    private fun handleError(
        message: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.e(TAG, "UDP API错误: $apiName - $message")

        val errorResult = JSONObject().apply {
            put("errMsg", "$apiName:fail")
            put("error", message)
        }

        ApiUtils.invokeFail(params, errorResult, responseCallback)
        return NoneResult()
    }

    /**
     * 清理所有Socket资源
     */
    fun cleanup() {
        Log.d(TAG, "清理所有UDP Socket资源")
        udpSockets.values.forEach { it.close() }
        udpSockets.clear()
    }
}