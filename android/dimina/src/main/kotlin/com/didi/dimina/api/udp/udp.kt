package com.didi.dimina.api.udp

import android.util.Base64
import android.util.Log
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.NoneResult
import com.didi.dimina.api.SyncResult
//import com.didi.dimina.api.network.NetworkApi.Companion.REQUEST
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.core.MiniApp
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/**
 * UDP Socket API实现 - 完全对齐微信小程序API规范
 * 严格遵循Dimina框架ApiHandler规范，参考微信官方UDPSocket API设计
 */
class UdpApi : ApiHandler {

    companion object {
        private const val TAG = "UdpSocketApi"

        // UDP API常量（对齐微信wx.createUDPSocket相关方法）
        const val CREATE_UDP_SOCKET = "createUDPSocket"
        const val UDP_BIND = "udpsocket.bind"
        const val UDP_SEND = "udpsocket.send"
        const val UDP_CLOSE = "udpsocket.close"
        const val UDP_ONMSG = "udpsocket.onMessage"
        const val UDP_OFFMSG = "udpsocket.offMessage"

        // Socket实例ID自增器
        private val idCounter = AtomicInteger(0)

        // 存储UDP Socket实例（instanceId -> UDPSocketInstance）
        private val socketInstances = ConcurrentHashMap<Int, UDPSocketInstance>()

        /**
         * UDP Socket实例封装类
         * 新增messageCallbackId存储JS层onMessage回调标识
         */
        data class UDPSocketInstance(
            val mid: Int,          // 实例ID（对应JS层的socket实例标识）
            val socketId: String,  // 唯一标识
            var datagramSocket: DatagramSocket? = null, // 原生UDP Socket
            var isListening: AtomicBoolean = AtomicBoolean(false), // 是否正在监听
            var listenThread: Thread? = null, // 消息监听线程
            var localAddress: String? = null, // 绑定后的本地地址
            val activity: DiminaActivity? = null, // 用于回调JS事件
//            var messageCallbackId: String? = null // JS层onMessage回调函数标识
        )
    }

    /**
     * 注册UDP相关API到Dimina框架
     */
    fun registerWith(registry: ApiRegistry) {
        registry.register(CREATE_UDP_SOCKET, this)
        registry.register(UDP_BIND, this)
        registry.register(UDP_ONMSG, this)
        registry.register(UDP_SEND, this)
        registry.register(UDP_CLOSE, this) // 补全注册
        Log.d(TAG, "UDP API注册完成：$CREATE_UDP_SOCKET, $UDP_BIND, $UDP_SEND, $UDP_CLOSE, $UDP_ONMSG")
    }

    /**
     * 处理UDP API调用（核心入口，遵循Dimina ApiHandler规范）
     */
    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.d(TAG, "处理 API: $apiName, 参数: $params")
        return when (apiName) {
            CREATE_UDP_SOCKET -> createUDPSocket(activity, appId, apiName, params, responseCallback)
            UDP_BIND -> bindUDPSocket(activity, appId, apiName, params, responseCallback)
            UDP_SEND -> sendUDPMessage(activity, appId, apiName, params, responseCallback)
            UDP_ONMSG -> udpOnmsg(activity, appId, apiName, params, responseCallback)
            UDP_CLOSE -> closeUDPSocket(activity, appId, apiName, params, responseCallback) // 补全处理
            else -> {
                Log.w(TAG, "未知的UDP API: $apiName")
                NoneResult()
            }
        }
    }

    /**
     * 1. 创建UDP Socket（对应微信wx.createUDPSocket()）- 同步API
     */
    private fun createUDPSocket(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            val mid = idCounter.getAndIncrement() // 原子性递增计数
            val socketId = "${System.currentTimeMillis()}_$mid"

            // 创建原生DatagramSocket（未绑定端口）
            val datagramSocket = DatagramSocket(null).apply {
                reuseAddress = true // 允许地址复用，避免端口占用
            }

            // 封装Socket实例并存储
            val socketInstance = UDPSocketInstance(
                mid = mid,
                socketId = socketId,
                datagramSocket = datagramSocket,
                activity = activity,
            )
            socketInstances[mid] = socketInstance

            Log.d(TAG, "创建UDP Socket成功: mid=$mid, socketId=$socketId")

            // 构建返回给JS层的Socket对象（对齐微信返回格式）
            val resultObj = JSONObject().apply {
                put("mid", mid)          // 实例ID，供后续方法调用
                put("socketId", socketId) // 唯一标识
                put("errMsg", "$CREATE_UDP_SOCKET:ok") // 微信风格错误信息
            }

            // 同步返回结果
            val jsValue = JSValue.createObject(resultObj.toString())
            SyncResult(jsValue)

        } catch (e: Exception) {
            Log.e(TAG, "创建UDP Socket失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$CREATE_UDP_SOCKET:fail")
                put("errorCode", -1)
                put("errorMsg", e.message ?: "Unknown error")
            }
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)
        }
    }

    /**
     * 2. 绑定UDP端口（对应微信UDPSocket.bind()）- 同步API
     */
    private fun bindUDPSocket(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            Log.d(TAG, "UDP 绑定端口------------------------------------")
            // 解析参数（ mid 为必填， port/address 可选）
            val mid = params.getInt("mid")
            val port = if (params.has("port")) params.getInt("port") else 0 // 0表示系统随机分配
            val address = if (params.has("address")) params.getString("address") else "0.0.0.0"

            // 获取Socket实例
            val socketInstance = socketInstances[mid] ?: run {
                throw IllegalArgumentException("未找到 mid=$mid 的UDP Socket实例")
            }
            val datagramSocket = socketInstance.datagramSocket ?: run {
                throw IllegalStateException("mid=$mid 的 Socket 已关闭")
            }
            // 绑定端口和地址
            val bindAddress = InetAddress.getByName(address)
            datagramSocket.bind(InetSocketAddress(bindAddress, port))
            // 更新实例信息
            val localSocketAddress = datagramSocket.localSocketAddress as InetSocketAddress
            socketInstance.localAddress = "${localSocketAddress.address.hostAddress}:${localSocketAddress.port}"
            socketInstance.isListening.set(true) // 仅标记为可监听，不启动线程
            Log.d(TAG, "UDP Socket绑定成功: mid=$mid,端口=${localSocketAddress.port}, 地址=${socketInstance.localAddress}")

            // 【关键】移除监听线程启动逻辑，仅保留绑定逻辑
            // startUDPListening(socketInstance,activity, appId, apiName, params, responseCallback)

            // 构建返回结果
            val resultObj = JSONObject().apply {
                put("mid", mid)
                put("port", localSocketAddress.port)
                put("localAddress", socketInstance.localAddress)
                put("errMsg", "$UDP_BIND:ok")
            }
            val jsValue = JSValue.createObject(resultObj.toString())
            Log.d(TAG, "UDP 绑定端口完成------------------------------------")
            SyncResult(jsValue)//同步返回
        } catch (e: Exception) {
            // 异常逻辑不变
            Log.e(TAG, "UDP Socket绑定失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$UDP_BIND:fail")
                put("errorCode", -2)
                put("errorMsg", e.message ?: "Bind failed")
            }
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)//同步返回
        }
    }
    /**
     * 3. 注册UDP消息监听（对应微信UDPSocket.onMessage()）- 同步API
     */
    private fun udpOnmsg(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            Log.d(TAG, "UDP 注册消息监听------------------------------------")

            // 解析参数：mid（实例ID）、callback（JS回调函数标识）
            val mid = params.getInt("mid")
            val socketId = params.getString("socketId")
            Log.d(TAG, "注册UDP消息回调: mid=$mid, socketId=$socketId")

            // 获取Socket实例
            val socketInstance = socketInstances[mid] ?: run {
                throw IllegalArgumentException("未找到 mid=$mid 的UDP Socket实例")
            }

            // 【新增校验】确保Socket已绑定端口
            if (socketInstance.localAddress.isNullOrEmpty()) {
                throw IllegalStateException("mid=$mid 的UDP Socket未绑定端口，请先调用bind")
            }

            // 【核心】注册监听时才启动UDP消息监听线程
            startUDPListening(socketInstance, activity, appId, apiName, params, responseCallback)


            // 构建返回结果
            val resultObj = JSONObject().apply {
                put("mid", mid)
                put("socketId", socketInstance.socketId)
                put("errMsg", "$UDP_ONMSG:ok")
            }
            val jsValue = JSValue.createObject(resultObj.toString())
            Log.d(TAG, "UDP 消息监听注册完成------------------------------------")

            SyncResult(jsValue)//同步返回
        } catch (e: Exception) {
            Log.e(TAG, "UDP 监听消息注册失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$UDP_ONMSG:fail")
                put("errorCode", -5)
                put("errorMsg", e.message ?: "Register onMessage failed")
            }
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)//同步返回
        }
    }
    /**
     * 4. 发送UDP消息（对应微信UDPSocket.send()）- 同步API
     */
    private fun sendUDPMessage(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            // 解析参数（必填：mid、address、port、data）
            val mid = params.getInt("mid")
            val targetAddress = params.getString("address")
            val targetPort = params.getInt("port")
            val message = params.getString("message")

            // 获取Socket实例
            val socketInstance = socketInstances[mid] ?: run {
                throw IllegalArgumentException("未找到 mid=$mid 的 UDP Socket实例")
            }
            val datagramSocket = socketInstance.datagramSocket ?: run {
                throw IllegalStateException("mid=$mid 的 Socket已关闭")
            }

            // 构建UDP数据包并发送
            val dataBytes = message.toByteArray(StandardCharsets.UTF_8)
            val inetAddress = InetAddress.getByName(targetAddress)
            val packet = DatagramPacket(
                dataBytes,
                dataBytes.size,
                inetAddress,
                targetPort
            )
            datagramSocket.send(packet)

            Log.d(TAG, "UDP消息发送成功: mid=$mid, 目标=$targetAddress:$targetPort, 数据长度=${dataBytes.size}")

            // 构建返回结果
            val resultObj = JSONObject().apply {
                put("mid", mid)
                put("sentBytes", dataBytes.size)
                put("errMsg", "$UDP_SEND:ok")
            }

            val jsValue = JSValue.createObject(resultObj.toString())
            SyncResult(jsValue)

        } catch (e: Exception) {
            Log.e(TAG, "UDP消息发送失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$UDP_SEND:fail")
                put("errorCode", -3)
                put("errorMsg", e.message ?: "Send failed")
            }
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)
        }
    }

    /**
     * 5. 关闭UDP Socket（对应微信UDPSocket.close()）- 同步API
     */
    private fun closeUDPSocket(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return try {
            // 解析参数
            val mid = params.getInt("mid")
            Log.d(TAG, "关闭UDP Socket: mid=$mid")

            // 获取并清理Socket实例
            val socketInstance = socketInstances.remove(mid) ?: run {
                throw IllegalArgumentException("未找到 mid=$mid 的 UDP Socket实例")
            }

            // 停止监听线程
            socketInstance.isListening.set(false)
            socketInstance.listenThread?.interrupt()
            // 关闭原生Socket
            socketInstance.datagramSocket?.close()


            Log.d(TAG, "UDP Socket关闭成功: mid=$mid")

            // 构建返回结果
            val resultObj = JSONObject().apply {
                put("mid", mid)
                put("errMsg", "$UDP_CLOSE:ok")
            }

            val jsValue = JSValue.createObject(resultObj.toString())
            SyncResult(jsValue)

        } catch (e: Exception) {
            Log.e(TAG, "UDP Socket关闭失败", e)
            val errorObj = JSONObject().apply {
                put("errMsg", "$UDP_CLOSE:fail")
                put("errorCode", -4)
                put("errorMsg", e.message ?: "Close failed")
            }
            val jsValue = JSValue.createObject(errorObj.toString())
            SyncResult(jsValue)
        }
    }


    /**
     * 内部方法：启动UDP消息监听线程（后台接收消息并回调JS层）
     * 核心修复：正确触发JS层的onMessage回调函数
     */
    private fun startUDPListening(
        socketInstance: UDPSocketInstance,
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ) {
        // 避免重复启动监听（关键：多次调用onMessage不重复创建线程）
        if (socketInstance.listenThread?.isAlive == true) {
            Log.w(TAG, "mid=${socketInstance.mid}的监听线程已启动，无需重复创建")
            return
        }

        // 启动后台线程监听消息
        socketInstance.listenThread = thread(name = "UDP-Listen-${socketInstance.mid}", isDaemon = true) {
            val datagramSocket = socketInstance.datagramSocket ?: return@thread
            val buffer = ByteArray(1024 * 4) // 4KB接收缓冲区
            val packet = DatagramPacket(buffer, buffer.size)
            val weakActivity = WeakReference(activity)

            Log.d(TAG, "启动UDP监听线程: mid=${socketInstance.mid}")

            // 循环条件：isListening为true + Socket未关闭
            while (socketInstance.isListening.get() && !datagramSocket.isClosed) {
                try {
                    datagramSocket.receive(packet) // 阻塞接收
                    val currentActivity = weakActivity.get() ?: break

                    // 1. 校验消息长度（必须小于4096）
                    val receiveLength = packet.length
                    if (receiveLength >= 4096) {
                        Log.w(TAG, "mid=${socketInstance.mid}收到超长UDP消息，长度=$receiveLength，已丢弃")
                        // 重置缓冲区长度，继续监听
                        packet.length = buffer.size
                        continue
                    }

                    // 2. 提取有效字节数据（避免缓冲区空字节）
                    val receiveData = ByteArray(receiveLength)
                    System.arraycopy(packet.data, 0, receiveData, 0, receiveLength)
                    // 3. 转换为小程序要求的ArrayBuffer格式（通过Base64传输，JS端可还原为ArrayBuffer）
                    val arrayBufferBase64 = Base64.encodeToString(receiveData, Base64.NO_WRAP)


                    // 构建微信小程序规范的回调数据
                    val remoteInfo = JSONObject().apply {
                        put("address", packet.address.hostAddress)
                        put("family", if (packet.address is Inet6Address) "ipv6" else "ipv4")
                        put("port", packet.port)
                        put("size", packet.length)
                    }
                    val localInfo = JSONObject().apply {
                        val localAddress = datagramSocket.localAddress?.hostAddress ?: ""
                        put("address", localAddress)
                        put("family", if (datagramSocket.localAddress is Inet6Address) "ipv6" else "ipv4")
                        put("port", datagramSocket.localPort)
                    }

                    val result = JSONObject().apply {
                        put("message", arrayBufferBase64) // ArrayBuffer通过Base64透传
                        put("remoteInfo", remoteInfo)
                        put("localInfo", localInfo)

                        put("mid", socketInstance.mid)
                        put("socketId", socketInstance.socketId)
                        put("errMsg", "onUDPSocketMessage:ok")
                    }
                    Log.d(TAG, "收到UDP消息: mid=${socketInstance.mid}, 远端=$remoteInfo, 数据=$receiveData")

                    // 主线程回调JS
                    currentActivity.runOnUiThread {
                        ApiUtils.invokeSuccess(params, result, responseCallback)
                    }

                    // 重置缓冲区
                    packet.length = buffer.size
                } catch (e: Exception) {
                    if (!socketInstance.isListening.get() || datagramSocket.isClosed) {
                        Log.d(TAG, "UDP监听线程退出: mid=${socketInstance.mid}, 原因=${e.message}")
                        break
                    }
                    Log.e(TAG, "UDP监听异常: mid=${socketInstance.mid}", e)
                }
            }

            Log.d(TAG, "UDP监听线程结束: mid=${socketInstance.mid}")
        }
    }
    private fun startUDPListening1(
        socketInstance: UDPSocketInstance,
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ) {
        // 避免重复启动监听
        if (socketInstance.listenThread?.isAlive == true) {
            Log.w(TAG, "mid=${socketInstance.mid}的监听线程已启动，无需重复创建")
            return
        }

        // 启动后台线程监听消息
        socketInstance.listenThread = thread(name = "UDP-Listen-${socketInstance.mid}", isDaemon = true) {
            val datagramSocket = socketInstance.datagramSocket ?: return@thread
            val buffer = ByteArray(1024 * 4) // 4KB接收缓冲区
            val packet = DatagramPacket(buffer, buffer.size)
            // 持有activity弱引用，避免内存泄漏
            val weakActivity = WeakReference(activity)

            Log.d(TAG, "启动UDP监听线程: mid=${socketInstance.mid}")

            while (socketInstance.isListening.get() && !datagramSocket.isClosed) {
                try {
                    // 阻塞接收UDP消息
                    datagramSocket.receive(packet)
                    // 解析消息内容和远端信息
                    val receiveData = String(packet.data, 0, packet.length, StandardCharsets.UTF_8)
                    val currentActivity = weakActivity.get() ?: break

                    // 1. 远端信息：对齐微信小程序字段（address/family/port/size）
                    val remoteInfo = JSONObject().apply {
                        put("address", packet.address.hostAddress)
                        // family: 微信规范值为 "ipv4" / "ipv6"
                        put("family", if (packet.address is Inet6Address) "ipv6" else "ipv4")
                        put("port", packet.port)
                        put("size", packet.length)
                    }

                    // 2. 本地信息：补充微信规范的本地端口/地址字段
                    val localInfo = JSONObject().apply {
                        val localAddress = datagramSocket.localAddress?.hostAddress ?: ""
                        put("address", localAddress)
                        put("family", if (datagramSocket.localAddress is Inet6Address) "ipv6" else "ipv4")
                        put("port", datagramSocket.localPort)
                    }

                    Log.d(TAG, "收到UDP消息: mid=${socketInstance.mid}, 远端=$remoteInfo, 数据=$receiveData")

                    // 3. 响应结果：完全对齐微信小程序 UDP 回调格式
                    val result = JSONObject().apply {
                        put("mid", socketInstance.mid) // 小程序规范：标识UDP Socket实例
                        put("data", receiveData) // 小程序规范：接收到的原始数据
                        put("remoteInfo", remoteInfo) // 小程序规范：远端地址信息
                        put("localInfo", localInfo) // 小程序规范：本地绑定信息
                        put("errMsg", "onUDPSocketMessage:ok") // 小程序规范：错误信息（成功固定为 xxx:ok）
                    }

                    // 4. 回调执行：确保在主线程调用（微信小程序回调始终在主线程）
                    currentActivity.runOnUiThread {
                        ApiUtils.invokeSuccess(params, result, responseCallback)
//                        ApiUtils.invokeComplete(params, responseCallback)
                    }

                    // 重置数据包缓冲区（准备接收下一条消息）
                    packet.length = buffer.size
                } catch (e: Exception) {
                    // 线程中断/Socket关闭时退出循环，不抛异常
                    if (!socketInstance.isListening.get() || datagramSocket.isClosed) {
                        Log.d(TAG, "UDP监听线程退出: mid=${socketInstance.mid}, 原因=${e.message}")
                        break
                    }
                    Log.e(TAG, "UDP监听异常: mid=${socketInstance.mid}", e)

                    // 5. 异常响应：对齐微信小程序错误格式
                    val errorResult = JSONObject().apply {
                        put("mid", socketInstance.mid)
                        put("errMsg", "onUDPSocketMessage:fail ${e.message ?: "unknown error"}") // 小程序规范：失败固定为 xxx:fail 描述
                    }
                    weakActivity.get()?.runOnUiThread {
                        ApiUtils.invokeFail(params, errorResult, responseCallback)
                        ApiUtils.invokeComplete(params, responseCallback)
                    }
                }
            }

            Log.d(TAG, "UDP监听线程结束: mid=${socketInstance.mid}")
        }
    }



}