package com.didi.dimina.api.network

import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory

/**
 * Wire-level abstraction over the underlying WebSocket engine.
 * Production uses [OkHttpSocketTransport]; tests inject a scripted fake so close-race /
 * background-timeout / event-mutual-exclusion behavior can be driven deterministically without
 * real sockets.
 */
internal interface SocketTransport {
    fun connect(spec: TransportConnectSpec, callbacks: TransportCallbacks): TransportHandle
}

/** A single in-flight or open connection handle returned by [SocketTransport.connect]. */
internal interface TransportHandle {
    /** Returns false if the underlying engine rejects/queues-fail the frame (maps to a send failure). */
    fun sendText(text: String): Boolean
    fun sendBytes(bytes: ByteArray): Boolean

    /** Starts a graceful close handshake; [TransportCallbacks.onClosed] fires when it completes. */
    fun close(code: Int, reason: String)

    /** Hard-terminates the connection with no close handshake and no further callbacks. */
    fun cancel()
}

/**
 * Callbacks a [TransportHandle] drives into the manager. All calls are expected to be posted onto
 * the manager's serial executor by the transport implementation (production: OkHttp's callback
 * thread posts in; tests: the fake calls directly since the test executor is immediate).
 */
internal interface TransportCallbacks {
    fun onOpen(headers: Map<String, String>, profileHints: TransportProfileHints)
    fun onMessageText(text: String)
    fun onMessageBinary(bytes: ByteArray)

    /** Server-initiated close handshake starting; implementations should echo-close and then call [onClosed]. */
    fun onClosing(code: Int, reason: String)
    fun onClosed(code: Int, reason: String)

    /**
     * Transport failure at any phase. [message] is the platform's own description: it may be
     * logged, but it must never reach an errMsg or a close `reason` (see
     * [WebSocketManager.connectFailureErrMsg]) - only [kind] may influence what the mini program
     * is told. Callers that have no structured information leave [kind] at its default.
     */
    fun onFailure(message: String?, kind: TransportFailureKind = TransportFailureKind.UNKNOWN)
}

/**
 * 传输层失败的**结构化**分类。errMsg 只能由它决定，不能由平台返回的文案决定：文案属于
 * OkHttp / JDK / 厂商 ROM，随版本和设备变化，用它做判据等于让契约取决于设备。
 */
internal enum class TransportFailureKind {
    /** 传输层按类型明确报告的超时。 */
    TIMEOUT,

    /** 其它失败，或调用方没有提供结构化信息。 */
    UNKNOWN,
}

internal data class TransportConnectSpec(
    val url: String,
    val headers: Map<String, String>,
    val protocols: List<String>,
    val tcpNoDelay: Boolean,
    val perMessageDeflate: Boolean,
    val connectTimeoutMs: Int,
)

/** Best-effort timing hints for profile completion; all optional. */
internal data class TransportProfileHints(
    val domainLookUpStart: Long? = null,
    val domainLookUpEnd: Long? = null,
    val connectStart: Long? = null,
    val connectEnd: Long? = null,
)

/** Injectable wall clock so timers/profile timestamps are deterministic under test. */
internal interface Clock {
    fun nowMs(): Long
}

internal interface Cancellable {
    fun cancel()
}

/** Injectable delayed-task scheduler; production posts back onto [SerialExecutor], tests fire manually. */
internal interface TaskScheduler {
    fun schedule(delayMs: Long, task: () -> Unit): Cancellable
}

/** Injectable single-threaded confinement for all manager state mutation. */
internal interface SerialExecutor {
    fun execute(task: () -> Unit)
}

private enum class SocketState { CREATED, CONNECTING, OPEN, CLOSING, CLOSED }

/** One live (non-CLOSED) connection. Removed from [OwnerState.sockets] the instant it goes terminal. */
private class SocketEntry(val socketId: String) {
    var transportHandle: TransportHandle? = null
    var state: SocketState = SocketState.CREATED
    var opened: Boolean = false
    var errorEmitted: Boolean = false
    var cancelled: Boolean = false
    var connectTimerHandle: Cancellable? = null
    var idleTimerHandle: Cancellable? = null

    /**
     * 单调递增的 idle 定时器代际。每次调度新的 idle 定时器（或显式取消旧的）都会推进它；
     * `scheduler.schedule` 把回调投进 [SerialExecutor] 队列之后，取消动作撤不回已经排队的
     * 那个闭包，只能让它到达 [WebSocketManager.handleIdleTimeout] 时比对代际、发现自己
     * 手里的值已经过期，静默作废。
     */
    var idleGeneration: Long = 0L
    var requestedCloseCode: Int? = null
    var requestedCloseReason: String? = null
    var fetchStartMs: Long = 0L
    var openedAtMs: Long = 0L

    /**
     * 校验后的连接超时值（来自 connectSocket 里的 WebSocketValidation.validateTimeout），
     * 供 startDialing 构造 TransportConnectSpec 时使用——两者不在同一个函数里，靠这个字段带过去。
     */
    var connectTimeoutMs: Int = WebSocketManager.DEFAULT_CONNECT_TIMEOUT_MS

    /**
     * 已派发过的任务态 open 载荷（`{header, profile}`）。connectSocket 一返回原生就立刻开始拨号，
     * 本机回环握手可能只要几毫秒，比调用方紧接着发来的 onSocketOpen 注册消息还快；如果这次注册
     * 输了这场竞速，只能靠在 onSocketEvent 里把这份载荷补发给它，否则这个 open 事件就永久丢了。
     */
    var openPayload: JSONObject? = null

    /**
     * 全局 `onSocketOpen` 的 open 载荷：只有 `header`，没有 `profile`——计时信息属于任务态
     * `SocketTask.onOpen` 的结果类型，全局监听拿不到它。与 [openPayload] 同样用于迟到注册的补发。
     */
    var globalOpenPayload: JSONObject? = null

    /** 已经收到过本代 open 事件的 callback id；正常派发和迟到补发共用，保证同一 id 只收到一次。 */
    val openDeliveredCallbackIds: MutableSet<String> = mutableSetOf()

    /** Ordered, de-duplicated per-event listener ids (task-mode `onSocketXxx`). */
    val listeners: MutableMap<String, LinkedHashSet<String>> = mutableMapOf()

    /**
     * 这次关闭是不是从全局 `wx.closeSocket` 发起。它用于全局绑定换代：全局目标一旦接受
     * 关闭请求，后续 `connectSocket` 可以绑定到新连接；`SocketTask.close()` 不影响该路由。
     */
    var closedByGlobalApi: Boolean = false

}

/**
 * 一条已经派发过的终态事件：载荷本身，外加已经收到过它的 callback id。正常派发和迟到
 * 补发写同一份名单，因此正常收到事件的 id 重复注册时也不会再收到陈旧补发。这份名单跟着
 * 记录一起被 [OwnerState.terminalReplay] 的容量淘汰。
 */
private class TerminalEvent(val payload: JSONObject) {
    val deliveredCallbackIds: MutableSet<String> = mutableSetOf()
}

/** Per mini-program (appId) WebSocket state. */
private class OwnerState(val appId: String) {
    val sockets: MutableMap<String, SocketEntry> = LinkedHashMap()

    // Legacy (no-socketId) global API state.
    var legacyBoundSocketId: String? = null

    /**
     * Ordered, de-duplicated per-event listener ids for the global `wx.onSocketXxx` API.
     * Same shape as [SocketEntry.listeners]. The current script layer registers exactly one
     * callback id per event and fans the event out to the business listeners itself, so in that
     * path the set holds a single id; keeping a set rather than one slot is what lets a caller
     * that registers several *distinct* ids - a host extension, or a direct bridge caller - have
     * all of them delivered, rather than each registration replacing the last. Registering the
     * same id twice still collapses to one delivery.
     */
    val legacySlots: MutableMap<String, LinkedHashSet<String>> = mutableMapOf()

    var backgrounded: Boolean = false
    var graceTimer: Cancellable? = null
    var emitter: ((String) -> Unit)? = null

    /**
     * 这个小程序 app.json 里 `networkTimeout.connectSocket` 的毫秒值；null 表示没配这一项。
     * 连接超时的优先级是 调用方 `timeout` > 这里 > [WebSocketManager.DEFAULT_CONNECT_TIMEOUT_MS]。
     */
    var appJsonConnectTimeoutMs: Int? = null

    /**
     * 已派发过的终态事件（error/close）载荷，键是 "$socketId|$event"。连接一旦进入终态，
     * entry 就从 [sockets] 里删掉了；但 connectSocket 一返回原生就立刻开始拨号，本机回环
     * 的 ECONNREFUSED 可能只要几毫秒，比调用方紧接着发来的 onSocketError/onSocketClose
     * 注册消息还快，输了这场竞速时条目已经找不到了，只能把记录挂在 owner 上，注册时
     * 按需补发。用 LinkedHashMap 保证插入顺序，超过 [WebSocketManager.TERMINAL_REPLAY_CAPACITY]
     * 时淘汰最旧的一条。
     */
    val terminalReplay: MutableMap<String, TerminalEvent> = LinkedHashMap()
}

private fun JSONObject.optRawOrNull(key: String): Any? {
    if (!has(key)) return null
    val value = opt(key)
    return if (value == JSONObject.NULL) null else value
}

/**
 * Process-level per-appId WebSocket state machine for Android. See [WebSocketApi] for the bridge
 * wiring and MiniApp/DiminaActivity lifecycle hookup.
 */
class WebSocketManager internal constructor(
    internal val transport: SocketTransport,
    internal val scheduler: TaskScheduler,
    internal val clock: Clock,
    internal val executor: SerialExecutor,
) {
    companion object {
        const val MAX_CONNECTIONS_PER_OWNER = 5
        const val DEFAULT_BACKGROUND_GRACE_MS = 5000L
        const val DEFAULT_CONNECT_TIMEOUT_MS = 60000

        /** 终态事件补发记录的上限。按最多 [MAX_CONNECTIONS_PER_OWNER] 条并发连接算，留够几轮用例的量即可。 */
        const val TERMINAL_REPLAY_CAPACITY = 32


        /** Safety bound for [disposeOwner]/[disposeAll]'s blocking wait; a hang here must not hang app-destroy forever. */
        private const val DISPOSE_AWAIT_TIMEOUT_MS = 3000L

        @Volatile
        private var sharedOverride: WebSocketManager? = null

        private val productionInstance: WebSocketManager by lazy {
            WebSocketManager(
                transport = OkHttpSocketTransport(),
                scheduler = RealTaskScheduler(),
                clock = RealClock(),
                executor = RealSerialExecutor(),
            )
        }

        /** Process-wide singleton used by [WebSocketApi]; production code must always go through this. */
        val shared: WebSocketManager
            get() = sharedOverride ?: productionInstance

        /** Test-only seam: replace (or clear, with null) the process-wide singleton. */
        internal fun setSharedForTesting(manager: WebSocketManager?) {
            sharedOverride = manager
        }
    }

    private val tag = "WebSocketManager"
    private val owners = mutableMapOf<String, OwnerState>()

    /** Host-level idle timeout; 0 = disabled (default). Not exposed to mini-program JS. */
    @Volatile
    var idleTimeoutMs: Long = 0L

    private fun getOrCreateOwner(appId: String): OwnerState = owners.getOrPut(appId) { OwnerState(appId) }

    /**
     * Registers/refreshes the push channel for [appId]'s persistent (`triggerCallback`) events.
     * Called on every [WebSocketApi] invocation; safe to call repeatedly.
     */
    fun updateEmitter(appId: String, emitter: (String) -> Unit) {
        executor.execute {
            getOrCreateOwner(appId).emitter = emitter
        }
    }

    /**
     * Registers [appId]'s parsed `app.json` `networkTimeout.connectSocket`, in milliseconds;
     * `null` means the mini program declares no such value. The configuration is per mini program
     * and sits between the call-site `timeout` and the [DEFAULT_CONNECT_TIMEOUT_MS] last resort.
     */
    fun updateNetworkTimeout(appId: String, connectSocketMs: Int?) {
        executor.execute {
            // A non-positive configured value carries no usable deadline, so it counts as unset and
            // falls through to the default, same as a caller-supplied non-positive `timeout`.
            getOrCreateOwner(appId).appJsonConnectTimeoutMs = connectSocketMs?.takeIf { it > 0 }
        }
    }

    /** Background/foreground policy entry point. */
    fun setBackgrounded(appId: String, backgrounded: Boolean) {
        executor.execute {
            val owner = getOrCreateOwner(appId)
            if (owner.backgrounded == backgrounded) return@execute
            owner.backgrounded = backgrounded
            owner.graceTimer?.cancel()
            owner.graceTimer = if (backgrounded) {
                scheduler.schedule(DEFAULT_BACKGROUND_GRACE_MS) {
                    executor.execute { handleBackgroundGraceExpired(owner) }
                }
            } else {
                null
            }
        }
    }

    /**
     * Synchronous, silent teardown of one owner's entire socket state.
     *
     * Blocks the caller until the teardown has actually run on [executor]: callers (MiniApp.clear())
     * destroy the JsCore immediately afterward, so a merely-enqueued-but-not-yet-run cleanup could
     * race a dying JsCore (sockets/timers left alive, or a stray event delivered post-destroy).
     */
    fun disposeOwner(appId: String) {
        awaitOnExecutor {
            val owner = owners.remove(appId) ?: return@awaitOnExecutor
            silentlyTearDown(owner)
        }
    }

    /** Disposes every owner (used by MiniApp.clearAll()); see [disposeOwner] for the blocking contract. */
    fun disposeAll() {
        awaitOnExecutor {
            val allOwners = owners.values.toList()
            owners.clear()
            allOwners.forEach { silentlyTearDown(it) }
        }
    }

    /** Runs [task] on [executor] and blocks the calling thread until it has actually completed. */
    private fun awaitOnExecutor(task: () -> Unit) {
        val latch = java.util.concurrent.CountDownLatch(1)
        executor.execute {
            try {
                task()
            } finally {
                latch.countDown()
            }
        }
        val completed = latch.await(DISPOSE_AWAIT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        if (!completed) {
            LogUtils.e(tag, "WebSocket dispose did not complete within ${DISPOSE_AWAIT_TIMEOUT_MS}ms")
        }
    }

    private fun silentlyTearDown(owner: OwnerState) {
        owner.graceTimer?.cancel()
        owner.graceTimer = null
        owner.sockets.values.toList().forEach { entry ->
            entry.connectTimerHandle?.cancel()
            cancelIdleTimer(entry)
            entry.transportHandle?.cancel()
        }
        owner.sockets.clear()
        owner.legacySlots.clear()
        owner.legacyBoundSocketId = null
        owner.emitter = null
    }

    /**
     * Handles a `connectSocket` invocation (always task-mode: connectSocket always carries a
     * socketId). Triggers `success`/`fail`/`complete` on [responseCallback] via ApiUtils.
     */
    fun connectSocket(appId: String, appVersion: String, params: JSONObject, responseCallback: (String) -> Unit) {
        executor.execute {
            val owner = getOrCreateOwner(appId)

            fun fail(msg: String) {
                val res = JSONObject().put("errMsg", "connectSocket:fail $msg")
                ApiUtils.invokeFail(params, res, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, res)
            }

            if (owner.backgrounded) {
                fail("interrupted")
                return@execute
            }

            val socketId = params.optString("socketId", "")
            if (socketId.isEmpty() || owner.sockets.containsKey(socketId)) {
                fail("invalid socketId")
                return@execute
            }

            // 官方上限统计所有尚未终态的连接，包含 CREATED、CONNECTING、OPEN 和 CLOSING。
            if (owner.sockets.size >= MAX_CONNECTIONS_PER_OWNER) {
                // Two `fail` words on purpose: WeChat builds this string as "${name}:fail ${errMsg}"
                // over an errMsg that already starts with "fail ", and that doubled word is the
                // literal text every mini program receives.
                fail("fail reach max websocket connect count $MAX_CONNECTIONS_PER_OWNER")
                return@execute
            }

            val urlResult = WebSocketValidation.validateUrl(params.optRawOrNull("url"))
            val validUrl = when (urlResult) {
                is WebSocketValidation.Result.Fail -> { fail(urlResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> urlResult.value
            }

            val rawTimeout = params.optRawOrNull("timeout")
            val timeoutResult = WebSocketValidation.validateTimeout(rawTimeout)
            val validatedTimeout = when (timeoutResult) {
                is WebSocketValidation.Result.Fail -> { fail(timeoutResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> timeoutResult.value
            }
            // Precedence: a usable call-site `timeout` wins, then app.json's
            // `networkTimeout.connectSocket`, then the 60s default. A `timeout` that names no
            // usable deadline counts as "not specified" and keeps falling through rather than
            // silently pinning the connection to the default.
            //
            // 下限是 1 毫秒，不是「大于 0」：毫秒以下的值向下取整就是 0，而 0 毫秒的截止点比
            // 拨号本身还早到，连接会在还没发起时就超时失败。
            val callerSpecifiedTimeout = rawTimeout is Number && rawTimeout.toDouble() >= 1
            val timeoutMs = if (callerSpecifiedTimeout) {
                validatedTimeout
            } else {
                owner.appJsonConnectTimeoutMs ?: DEFAULT_CONNECT_TIMEOUT_MS
            }

            val protocolsResult = WebSocketValidation.validateProtocols(params.optRawOrNull("protocols"))
            val protocols = when (protocolsResult) {
                is WebSocketValidation.Result.Fail -> { fail(protocolsResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> protocolsResult.value
            }

            val headerResult = WebSocketValidation.validateHeader(params.optRawOrNull("header"))
            val callerHeader = when (headerResult) {
                is WebSocketValidation.Result.Fail -> { fail(headerResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> headerResult.value
            }
            // 容器自己的 Referer：调用方传的那份已经在校验里被丢掉了，这里补上固定值。
            val header = LinkedHashMap(callerHeader).apply {
                put("Referer", WebSocketValidation.refererValue(appId, appVersion))
            }

            val tcpNoDelay = params.optBoolean("tcpNoDelay", false)
            val perMessageDeflate = params.optBoolean("perMessageDeflate", false)

            // socketId 只要求当前没有同名存活连接，因此终态后的 id 可以复用。新连接已经
            // 全部校验通过后，旧连接留下的 error/close 不能再被这代监听误认为自己的事件。
            clearTerminalReplay(owner, socketId)
            val entry = SocketEntry(socketId)
            entry.fetchStartMs = clock.nowMs()
            entry.connectTimeoutMs = timeoutMs
            owner.sockets[socketId] = entry

            // 全局 API 的绑定跟着「服务层还看得见的连接」走：绑定目标一旦对服务层已是 CLOSED，
            // 这次 connectSocket 就改绑到新连接。判据不能用「条目还在不在 sockets 里」——正在
            // 关闭的连接会一直留在里面等 close 事件，用它判定会让绑定永远卡在被关掉的那条上。
            val boundIsClosedToService = owner.legacyBoundSocketId?.let { isClosedToService(owner, it) } ?: true
            if (boundIsClosedToService) {
                owner.legacyBoundSocketId = socketId
            }

            // Success fires immediately once validation passes and the dial starts, not when the
            // connection actually opens.
            val connectOk = JSONObject().put("errMsg", "connectSocket:ok")
            ApiUtils.invokeSuccess(params, connectOk, responseCallback)
            ApiUtils.invokeComplete(params, responseCallback, connectOk)

            entry.connectTimerHandle = scheduler.schedule(timeoutMs.toLong()) {
                executor.execute { handleConnectTimeout(owner, entry) }
            }

            // The actual dial is queued rather than run inline, so a same-tick close can cancel it
            // before any network call happens.
            scheduler.schedule(0) {
                executor.execute {
                    startDialing(owner, entry, validUrl, header, protocols, tcpNoDelay, perMessageDeflate)
                }
            }
        }
    }

    /**
     * 全局绑定目标是否已经交出路由。native 的 CLOSING 既可能来自全局 API，也可能来自
     * `SocketTask.close()`，因此必须记录关闭入口，不能只按传输层状态判断。
     */
    private fun isClosedToService(owner: OwnerState, socketId: String): Boolean {
        val entry = owner.sockets[socketId] ?: return true
        return entry.closedByGlobalApi
    }

    private fun startDialing(
        owner: OwnerState,
        entry: SocketEntry,
        validUrl: WebSocketValidation.ValidatedUrl,
        header: Map<String, String>,
        protocols: List<String>,
        tcpNoDelay: Boolean,
        perMessageDeflate: Boolean,
    ) {
        if (entry.cancelled) return
        if (owner.sockets[entry.socketId] !== entry) return
        entry.state = SocketState.CONNECTING

        val callbacks = object : TransportCallbacks {
            override fun onOpen(headers: Map<String, String>, profileHints: TransportProfileHints) {
                executor.execute { handleTransportOpen(owner, entry, headers, profileHints) }
            }

            override fun onMessageText(text: String) {
                executor.execute { handleTransportMessageText(owner, entry, text) }
            }

            override fun onMessageBinary(bytes: ByteArray) {
                executor.execute { handleTransportMessageBinary(owner, entry, bytes) }
            }

            override fun onClosing(code: Int, reason: String) {
                executor.execute {
                    if (owner.sockets[entry.socketId] === entry && entry.state == SocketState.OPEN) {
                        entry.state = SocketState.CLOSING
                    }
                }
            }

            override fun onClosed(code: Int, reason: String) {
                executor.execute { handleTransportClosed(owner, entry, code, reason) }
            }

            override fun onFailure(message: String?, kind: TransportFailureKind) {
                executor.execute { handleTransportFailure(owner, entry, message, kind) }
            }
        }

        val spec = TransportConnectSpec(validUrl.url, header, protocols, tcpNoDelay, perMessageDeflate, entry.connectTimeoutMs)
        entry.transportHandle = try {
            transport.connect(spec, callbacks)
        } catch (e: Exception) {
            // The dial can fail synchronously - OkHttp's request builder throws on a header the
            // validator let through, for instance. The executor only logs whatever escapes here, so
            // without this the entry would sit in CONNECTING until the connect timer fires, minutes
            // after `success` was already reported. Same thread as the rest of the state machine.
            handleTransportFailure(owner, entry, e.message, classifyTransportFailure(e))
            return
        }
    }

    private fun handleTransportOpen(
        owner: OwnerState,
        entry: SocketEntry,
        headers: Map<String, String>,
        hints: TransportProfileHints,
    ) {
        if (owner.sockets[entry.socketId] !== entry) return

        entry.state = SocketState.OPEN
        entry.opened = true
        entry.openedAtMs = clock.nowMs()
        entry.connectTimerHandle?.cancel()
        entry.connectTimerHandle = null
        startIdleTimerIfNeeded(owner, entry)

        val fetchStart = entry.fetchStartMs
        val connectStart = hints.connectStart ?: fetchStart
        val connectEnd = hints.connectEnd ?: entry.openedAtMs
        val domainLookUpStart = hints.domainLookUpStart ?: fetchStart
        val domainLookUpEnd = hints.domainLookUpEnd ?: domainLookUpStart

        val profile = JSONObject().apply {
            put("fetchStart", fetchStart)
            put("domainLookUpStart", domainLookUpStart)
            put("domainLookUpEnd", domainLookUpEnd)
            put("connectStart", connectStart)
            put("connectEnd", connectEnd)
            put("rtt", maxOf(0L, connectEnd - connectStart))
            put("handshakeCost", maxOf(0L, entry.openedAtMs - connectEnd))
            put("cost", maxOf(0L, entry.openedAtMs - fetchStart))
        }

        // The task-mode result is `{header, profile}` while the global `wx.onSocketOpen` result is
        // `{header}` alone, so the two paths carry separate payloads rather than one shared object.
        val headerJson = JSONObject(headers as Map<*, *>)
        val payload = JSONObject()
            .put("header", headerJson)
            .put("profile", profile)
        val globalPayload = JSONObject().put("header", headerJson)
        entry.openPayload = payload
        entry.globalOpenPayload = globalPayload
        dispatchEvent(owner, entry, "open", payload, globalPayload)
    }

    private fun handleTransportMessageText(owner: OwnerState, entry: SocketEntry, text: String) {
        if (owner.sockets[entry.socketId] !== entry) return
        resetIdleTimerIfNeeded(owner, entry)
        dispatchEvent(owner, entry, "message", JSONObject().put("data", text))
    }

    private fun handleTransportMessageBinary(owner: OwnerState, entry: SocketEntry, bytes: ByteArray) {
        if (owner.sockets[entry.socketId] !== entry) return
        resetIdleTimerIfNeeded(owner, entry)
        val base64 = Base64.getEncoder().encodeToString(bytes)
        dispatchEvent(owner, entry, "message", JSONObject().put("data", base64).put("isBuffer", true))
    }

    private fun handleTransportClosed(owner: OwnerState, entry: SocketEntry, code: Int, reason: String) {
        if (owner.sockets[entry.socketId] !== entry) return
        if (!entry.opened) {
            // Defensive: an unopened connection must never surface `close`.
            // The reason here comes off the wire and is entirely the server's to choose, so it is
            // deliberately dropped rather than folded into the API-level error string - iOS and
            // HarmonyOS both report the generic connection-failed text on this path.
            terminateHandshakeWithError(owner, entry, connectFailureErrMsg(TransportFailureKind.UNKNOWN))
            return
        }
        val reportedCode = entry.requestedCloseCode ?: code
        val reportedReason = entry.requestedCloseReason ?: reason
        detachEntry(owner, entry)
        dispatchEvent(owner, entry, "close", closeEventPayload(reportedCode, reportedReason))
    }

    private fun handleTransportFailure(
        owner: OwnerState,
        entry: SocketEntry,
        message: String?,
        kind: TransportFailureKind,
    ) {
        if (owner.sockets[entry.socketId] !== entry) return
        // 平台原文只进日志：调用方看到的 errMsg 由 kind 决定，见 [connectFailureErrMsg]。
        LogUtils.d(tag, "WebSocket transport failure on ${entry.socketId} ($kind): $message")
        if (!entry.opened) {
            terminateHandshakeWithError(owner, entry, connectFailureErrMsg(kind))
            return
        }
        // A transport failure while a client-initiated close is already in flight (requestedCloseCode
        // set) must report close only, never error — only a genuinely unsolicited failure on an
        // otherwise-untouched connection gets an error event.
        val clientCloseInFlight = entry.requestedCloseCode != null
        if (!clientCloseInFlight && !entry.errorEmitted) {
            entry.errorEmitted = true
            dispatchEvent(owner, entry, "error", JSONObject().put("errMsg", connectFailureErrMsg(kind)))
        }
        val code = entry.requestedCloseCode ?: 1006
        // 这条 close 是本地合成的：没有收到任何线上 close 帧，所以没有 reason 可引。空串是最
        // 诚实的表示，也与 RFC6455 里 1006 不携带 reason 一致。服务端主动关闭那条路径走
        // handleTransportClosed，reason 来自线帧、原样带回，不受这里约束。
        val reason = entry.requestedCloseReason ?: ""
        detachEntry(owner, entry)
        dispatchEvent(owner, entry, "close", closeEventPayload(code, reason))
    }

    private fun handleConnectTimeout(owner: OwnerState, entry: SocketEntry) {
        if (owner.sockets[entry.socketId] !== entry) return
        if (entry.state == SocketState.OPEN) return
        // 走和传输层上报同一个出口：容器计时器到期与传输层报超时是同一件事，调用方不该为它
        // 写两个分支。
        terminateHandshakeWithError(owner, entry, connectFailureErrMsg(TransportFailureKind.TIMEOUT))
    }

    private fun handleBackgroundGraceExpired(owner: OwnerState) {
        owner.graceTimer = null
        if (!owner.backgrounded) return
        owner.sockets.values.toList().forEach { entry ->
            if (entry.opened) {
                terminateClientSide(owner, entry, 1006, "interrupted")
            } else {
                terminateHandshakeWithError(owner, entry, "connectSocket:fail interrupted")
            }
        }
    }

    private fun startIdleTimerIfNeeded(owner: OwnerState, entry: SocketEntry) {
        if (idleTimeoutMs <= 0) return
        cancelIdleTimer(entry)
        val generation = ++entry.idleGeneration
        entry.idleTimerHandle = scheduler.schedule(idleTimeoutMs) {
            executor.execute { handleIdleTimeout(owner, entry, generation) }
        }
    }

    private fun resetIdleTimerIfNeeded(owner: OwnerState, entry: SocketEntry) {
        if (entry.state == SocketState.OPEN) startIdleTimerIfNeeded(owner, entry)
    }

    /**
     * 取消 entry 的 idle 定时器（若有）。所有显式取消的地方都必须走这里而不是直接调
     * `idleTimerHandle?.cancel()`——`cancel()` 只能拦住尚未开始执行的定时任务本身，拦不住
     * 它已经 `executor.execute` 进串行队列的那个闭包；推进 [SocketEntry.idleGeneration] 让
     * 那个迟到的闭包在 [handleIdleTimeout] 里比对代际时发现自己已经过期，静默作废。
     */
    private fun cancelIdleTimer(entry: SocketEntry) {
        entry.idleTimerHandle?.cancel()
        entry.idleTimerHandle = null
        entry.idleGeneration++
    }

    private fun handleIdleTimeout(owner: OwnerState, entry: SocketEntry, generation: Long) {
        if (generation != entry.idleGeneration) return
        if (owner.sockets[entry.socketId] !== entry) return
        if (entry.state != SocketState.OPEN) return
        terminateClientSide(owner, entry, 1006, "idle timeout")
    }

    /** Client-mechanism teardown (background/idle) of an OPEN connection: cancel + close event, no error. */
    private fun terminateClientSide(owner: OwnerState, entry: SocketEntry, code: Int, reason: String) {
        entry.transportHandle?.cancel()
        detachEntry(owner, entry)
        dispatchEvent(owner, entry, "close", closeEventPayload(code, reason))
    }

    /** Client-mechanism teardown of a not-yet-open connection: cancel + at-most-one error, no close. */
    private fun terminateHandshakeWithError(owner: OwnerState, entry: SocketEntry, errMsg: String) {
        entry.transportHandle?.cancel()
        detachEntry(owner, entry)
        if (!entry.errorEmitted) {
            entry.errorEmitted = true
            dispatchEvent(owner, entry, "error", JSONObject().put("errMsg", errMsg))
        }
    }

    private fun detachEntry(owner: OwnerState, entry: SocketEntry) {
        entry.connectTimerHandle?.cancel()
        cancelIdleTimer(entry)
        if (owner.sockets[entry.socketId] === entry) {
            owner.sockets.remove(entry.socketId)
        }
    }

    private fun closeEventPayload(code: Int, reason: String): JSONObject =
        JSONObject().put("code", code).put("reason", reason)

    /**
     * 传输层失败 → errMsg 的**唯一**转换点。本端任何地方都不得再自行拼 connect 阶段的 errMsg。
     *
     * 规则：errMsg 只由容器自己的固定英文串构成，且**只依据结构化的 [kind]** 选串。平台给的
     * 描述文本（`Throwable.message`）一律不参与——既不拼进去，也不用来分类。errMsg 是给程序
     * 判定用的契约文本，跟着设备语言或 SDK 版本变就等于没有契约。原文只进日志。
     */
    private fun connectFailureErrMsg(kind: TransportFailureKind): String = when (kind) {
        TransportFailureKind.TIMEOUT -> "connectSocket:fail timeout"
        TransportFailureKind.UNKNOWN -> "connectSocket:fail WebSocket connection failed"
    }

    /**
     * Dispatches [event] first to the connection's task-mode listeners (registration order), then,
     * if this connection is the legacy binding target, to the corresponding global slot.
     * [globalPayload] is the result the global listeners receive; it differs from the task-mode
     * [payload] for `open`, whose global result type carries no `profile`.
     */
    private fun dispatchEvent(
        owner: OwnerState,
        entry: SocketEntry,
        event: String,
        payload: JSONObject,
        globalPayload: JSONObject = payload,
    ) {
        val deliveredCallbackIds = when (event) {
            "open" -> entry.openDeliveredCallbackIds
            "error", "close" -> recordTerminalEvent(owner, entry.socketId, event, payload).deliveredCallbackIds
            else -> null
        }
        val emitter = owner.emitter ?: return
        entry.listeners[event]?.forEach { callbackId ->
            emitEventOnce(emitter, deliveredCallbackIds, callbackId, payload)
        }
        if (owner.legacyBoundSocketId == entry.socketId) {
            owner.legacySlots[event]?.forEach { callbackId ->
                emitEventOnce(emitter, deliveredCallbackIds, callbackId, globalPayload)
            }
        }
    }

    private fun emitEventOnce(
        emitter: (String) -> Unit,
        deliveredCallbackIds: MutableSet<String>?,
        callbackId: String,
        payload: JSONObject,
    ) {
        if (deliveredCallbackIds != null && !deliveredCallbackIds.add(callbackId)) return
        emitter(ApiUtils.createCallbackResponse(callbackId, payload))
    }

    /** 记录一条终态事件，供 entry 从 [OwnerState.sockets] 删除之后才到达的迟到注册补发；见 [OwnerState.terminalReplay]。 */
    private fun recordTerminalEvent(owner: OwnerState, socketId: String, event: String, payload: JSONObject): TerminalEvent {
        val key = "$socketId|$event"
        // 先 delete 再 set，保证这条记录被刷新到插入顺序的最末尾。
        owner.terminalReplay.remove(key)
        val record = TerminalEvent(payload)
        owner.terminalReplay[key] = record
        while (owner.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
            val iterator = owner.terminalReplay.keys.iterator()
            if (!iterator.hasNext()) break
            iterator.next()
            iterator.remove()
        }
        return record
    }

    /** 新一代同 socketId 连接开始前，移除上一代连接留下的终态补发记录。 */
    private fun clearTerminalReplay(owner: OwnerState, socketId: String) {
        owner.terminalReplay.remove("$socketId|error")
        owner.terminalReplay.remove("$socketId|close")
    }

    /** Handles `sendSocketMessage`, task-mode or legacy-global-mode per [hasSocketId]. */
    fun sendSocketMessage(
        appId: String,
        hasSocketId: Boolean,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ) {
        executor.execute {
            val owner = getOrCreateOwner(appId)

            fun fail(msg: String) {
                val res = JSONObject().put("errMsg", "sendSocketMessage:fail $msg")
                ApiUtils.invokeFail(params, res, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, res)
            }

            if (owner.backgrounded) {
                fail("interrupted")
                return@execute
            }

            val entry = if (hasSocketId) {
                owner.sockets[params.optString("socketId", "")]
            } else {
                owner.legacyBoundSocketId?.let { owner.sockets[it] }
            }

            if (entry == null || entry.state != SocketState.OPEN) {
                fail("WebSocket is not connected")
                return@execute
            }

            val isBuffer = params.optBoolean("isBuffer", false)
            val dataRaw = params.optRawOrNull("data")

            val sendOk = if (isBuffer) {
                val bytes = decodeBase64OrNull(dataRaw as? String)
                if (bytes == null) {
                    fail("data must be string or ArrayBuffer")
                    return@execute
                }
                entry.transportHandle?.sendBytes(bytes) ?: false
            } else {
                if (dataRaw !is String) {
                    fail("data must be string or ArrayBuffer")
                    return@execute
                }
                entry.transportHandle?.sendText(dataRaw) ?: false
            }

            if (sendOk) {
                // Idle timeout resets on traffic in either direction, not just inbound.
                resetIdleTimerIfNeeded(owner, entry)
                val res = JSONObject().put("errMsg", "sendSocketMessage:ok")
                ApiUtils.invokeSuccess(params, res, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, res)
            } else {
                fail("WebSocket is not connected")
            }
        }
    }

    private fun decodeBase64OrNull(s: String?): ByteArray? {
        if (s == null) return null
        return try {
            Base64.getDecoder().decode(s)
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** Handles `closeSocket`, task-mode or legacy-global-mode per [hasSocketId]. */
    fun closeSocket(
        appId: String,
        hasSocketId: Boolean,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ) {
        executor.execute {
            val owner = getOrCreateOwner(appId)

            fun fail(msg: String) {
                val res = JSONObject().put("errMsg", "closeSocket:fail $msg")
                ApiUtils.invokeFail(params, res, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, res)
            }

            fun ok() {
                val res = JSONObject().put("errMsg", "closeSocket:ok")
                ApiUtils.invokeSuccess(params, res, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, res)
            }

            if (owner.backgrounded) {
                fail("interrupted")
                return@execute
            }

            if (!hasSocketId) {
                val boundEntry = owner.legacyBoundSocketId?.let { owner.sockets[it] }
                // wx.closeSocket 的官方示例明确要求在 wx.onSocketOpen 之后调用。全局接口只处理
                // 已打开的绑定连接，不关闭握手中连接，也不扫描其他 SocketTask。
                if (boundEntry == null || boundEntry.state != SocketState.OPEN) {
                    fail("WebSocket is not connected")
                    return@execute
                }
                val codeResult = WebSocketValidation.validateCloseCode(params.optRawOrNull("code"))
                val reasonResult = WebSocketValidation.validateReason(params.optRawOrNull("reason"))
                when {
                    codeResult is WebSocketValidation.Result.Fail -> fail(codeResult.errMsg)
                    reasonResult is WebSocketValidation.Result.Fail -> fail(reasonResult.errMsg)
                    else -> {
                        val code = (codeResult as WebSocketValidation.Result.Ok).value
                        val reason = (reasonResult as WebSocketValidation.Result.Ok).value
                        closeEntryByClient(owner, boundEntry, code, reason, viaGlobalApi = true)
                        ok()
                    }
                }
                return@execute
            }

            val socketId = params.optString("socketId", "")
            val entry = owner.sockets[socketId]
            if (entry == null || entry.state == SocketState.CLOSING) {
                // No live entry, or already closing -> "not connected" (avoid double close events).
                fail("WebSocket is not connected")
                return@execute
            }

            val codeResult = WebSocketValidation.validateCloseCode(params.optRawOrNull("code"))
            val code = when (codeResult) {
                is WebSocketValidation.Result.Fail -> { fail(codeResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> codeResult.value
            }
            val reasonResult = WebSocketValidation.validateReason(params.optRawOrNull("reason"))
            val reason = when (reasonResult) {
                is WebSocketValidation.Result.Fail -> { fail(reasonResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> reasonResult.value
            }

            closeEntryByClient(owner, entry, code, reason, viaGlobalApi = false)
            ok()
        }
    }

    /**
     * [viaGlobalApi] 记录这次关闭走的是哪道门：`wx.closeSocket` 为 true，`SocketTask.close()`
     * 为 false。它决定这条连接对服务层是否立刻算 CLOSED，见 [SocketEntry.closedByGlobalApi]。
     * 标记在发起的那一刻置位而不是等握手完成——传输层状态事后分不出发起方。
     */
    private fun closeEntryByClient(
        owner: OwnerState,
        entry: SocketEntry,
        code: Int,
        reason: String,
        viaGlobalApi: Boolean,
    ) {
        if (viaGlobalApi) entry.closedByGlobalApi = true
        when (entry.state) {
            SocketState.CREATED -> {
                entry.cancelled = true
                terminateClientSide(owner, entry, code, reason)
            }
            SocketState.CONNECTING -> {
                terminateClientSide(owner, entry, code, reason)
            }
            SocketState.OPEN -> {
                entry.requestedCloseCode = code
                entry.requestedCloseReason = reason
                entry.state = SocketState.CLOSING
                entry.transportHandle?.close(code, reason)
            }
            SocketState.CLOSING, SocketState.CLOSED -> {
                // No-op: callers validate against this state before reaching here.
            }
        }
    }

    /**
     * Handles `onSocketOpen`/`onSocketMessage`/`onSocketError`/`onSocketClose`: registers a
     * persistent callback id (`params.callback`) for `event`, task-mode or legacy-global-mode per
     * [hasSocketId]. Both modes keep an ordered, de-duplicated set of ids: fe stores one callback
     * id per registered listener function and sends a separate `onSocketXxx` for each of them.
     * `event` is one of "open"|"message"|"error"|"close". [apiName] is the actual bridge API name
     * (e.g. "onSocketOpen") used for the completion `errMsg`.
     *
     * success/complete are still invoked for every registration and unregistration so the bridge
     * call has a definite outcome on the fe side, matching every other API here.
     */
    fun onSocketEvent(
        event: String,
        appId: String,
        hasSocketId: Boolean,
        params: JSONObject,
        apiName: String,
        responseCallback: (String) -> Unit,
    ) {
        executor.execute {
            val owner = getOrCreateOwner(appId)
            val callbackId = params.optString("callback", "")
            if (callbackId.isNotEmpty()) {
                if (hasSocketId) {
                    val socketId = params.optString("socketId", "")
                    owner.sockets[socketId]?.listeners?.getOrPut(event) { LinkedHashSet() }?.add(callbackId)
                    replayMissedEvent(owner, socketId, event, callbackId, isGlobal = false)
                } else {
                    owner.legacySlots.getOrPut(event) { LinkedHashSet() }.add(callbackId)
                    // 全局态的补发对象是当前 legacy 绑定的那条连接；没有绑定就没有可补的事件。
                    owner.legacyBoundSocketId?.let { replayMissedEvent(owner, it, event, callbackId, isGlobal = true) }
                }
            }
            val res = JSONObject().put("errMsg", "$apiName:ok")
            ApiUtils.invokeSuccess(params, res, responseCallback)
            ApiUtils.invokeComplete(params, responseCallback, res)
        }
    }

    /**
     * 把注册时已经错过的事件补发给 [callbackId]。connectSocket 一返回原生就开始拨号，本机回环
     * 握手或连接被拒可能只要几毫秒，比调用方紧接着发来的 onSocketXxx 注册消息还快，输了这场
     * 竞速的注册只能靠这里补发，否则那个事件就永久丢了。open 取 [socketId] 那条连接自己保存的
     * 载荷，error / close 时条目已经从 [OwnerState.sockets] 删掉，只能取 owner 的终态记录。
     *
     * 两条记录各自记着已经实际投递过的 callback id，正常派发和补发共用，所以同一个 id 即使
     * 在正常收到事件后又直接向桥重复注册，也不会收到第二份陈旧事件。message 没有"当前值"可言，不补发。
     *
     * [isGlobal] 区分注册来自全局 `wx.onSocketXxx` 还是任务态 `SocketTask.onXxx`：open 事件两者的
     * 结果类型不同，补发必须和正常派发拿到同一份载荷。
     */
    private fun replayMissedEvent(
        owner: OwnerState,
        socketId: String,
        event: String,
        callbackId: String,
        isGlobal: Boolean,
    ) {
        val emitter = owner.emitter ?: return
        when (event) {
            "open" -> {
                val entry = owner.sockets[socketId] ?: return
                if (entry.state != SocketState.OPEN) return
                val payload = (if (isGlobal) entry.globalOpenPayload else entry.openPayload) ?: return
                if (!entry.openDeliveredCallbackIds.add(callbackId)) return
                emitter(ApiUtils.createCallbackResponse(callbackId, payload))
            }
            "error", "close" -> {
                val record = owner.terminalReplay["$socketId|$event"] ?: return
                if (!record.deliveredCallbackIds.add(callbackId)) return
                emitter(ApiUtils.createCallbackResponse(callbackId, record.payload))
            }
        }
    }

    /**
     * `off` 结束一次监听生命周期，同时回收这次生命周期在事件投递账本里的 id。逻辑层后续
     * 重新注册会生成新的 callback id；及时移除旧 id，避免长连接反复 on/off 时集合无界增长。
     */
    private fun forgetDeliveredCallback(owner: OwnerState, socketId: String, event: String, callbackId: String) {
        val deliveredIds = when (event) {
            "open" -> owner.sockets[socketId]?.openDeliveredCallbackIds
            "error", "close" -> owner.terminalReplay["$socketId|$event"]?.deliveredCallbackIds
            else -> null
        } ?: return
        if (callbackId.isNotEmpty()) deliveredIds.remove(callbackId) else deliveredIds.clear()
    }

    /**
     * Handles `offSocketOpen`/`offSocketMessage`/`offSocketError`/`offSocketClose`.
     * Both modes: if `params.callback` is a usable string id, remove exactly that id and leave the
     * other listeners of that event alone; otherwise clear every listener for that event.
     * This is a bridge-private rollback/compatibility operation; neither wx nor SocketTask exposes it.
     */
    fun offSocketEvent(
        event: String,
        appId: String,
        hasSocketId: Boolean,
        params: JSONObject,
        apiName: String,
        responseCallback: (String) -> Unit,
    ) {
        executor.execute {
            val owner = getOrCreateOwner(appId)
            val callbackId = params.optString("callback", "")

            if (hasSocketId) {
                val socketId = params.optString("socketId", "")
                val set = owner.sockets[socketId]?.listeners?.get(event)
                if (set != null) {
                    if (callbackId.isNotEmpty()) set.remove(callbackId) else set.clear()
                }
                forgetDeliveredCallback(owner, socketId, event, callbackId)
            } else {
                val slot = owner.legacySlots[event]
                if (slot != null) {
                    if (callbackId.isNotEmpty()) slot.remove(callbackId) else slot.clear()
                }
                owner.legacyBoundSocketId?.let {
                    forgetDeliveredCallback(owner, it, event, callbackId)
                }
            }
            val res = JSONObject().put("errMsg", "$apiName:ok")
            ApiUtils.invokeSuccess(params, res, responseCallback)
            ApiUtils.invokeComplete(params, responseCallback, res)
        }
    }
}

/**
 * 交给 OkHttp 的连接超时（毫秒）：跟着调用方请求的值走，并留 1000 毫秒余量，让容器自己的连接
 * 定时器始终先到点、OkHttp 的超时只当兜底——否则两个超时同时到点，最终报的是哪一条错误就不
 * 确定了。[WebSocketValidation.validateTimeout] 放行的最大值就是 `Int.MAX_VALUE`，直接加余量
 * 会越过 OkHttp 的上限（它要求毫秒数不超过 `Integer.MAX_VALUE`）并抛 `timeout too large`，让
 * 这条连接立刻失败，而 iOS 和 HarmonyOS 收下同一个值都能正常拨号，所以结果钳在 `Int.MAX_VALUE`。
 * 触顶时余量被压到 0、两个截止点重合，谁先到不再有保证；但那是约 24 天后的事，握手活不到那时候。
 */
internal fun okHttpConnectTimeoutMs(requestedMs: Int): Long =
    minOf(requestedMs.toLong() + 1000L, Int.MAX_VALUE.toLong())

/**
 * 把一个传输层异常归到 [TransportFailureKind]，**只看类型，不看 `message`**。
 *
 * `java.net.SocketTimeoutException` 是 JDK 对「超时」这件事的类型级表示；OkHttp 自己的调用
 * 超时抛的是父类 `java.io.InterruptedIOException`（`RealCall.timeoutExit` 里 `new
 * InterruptedIOException("timeout")`），所以判父类一条就同时覆盖两者。
 *
 * 之所以不去匹配 `message`：那串文本由 OkHttp、JDK 或厂商 ROM 决定，不同版本措辞不同
 * （`timeout` / `timed out` / `connect timed out` / `Read timed out`），能否被本地化也不在
 * 我们控制之内。用它做判据的话，同一个失败在两台设备上会被分到不同的固定串。
 */
internal fun classifyTransportFailure(t: Throwable?): TransportFailureKind = when (t) {
    is java.io.InterruptedIOException -> TransportFailureKind.TIMEOUT
    else -> TransportFailureKind.UNKNOWN
}

/** Production [SocketTransport] backed by a lazily-created singleton [okhttp3.OkHttpClient]. */
/**
 * 把握手响应头折成 open 载荷要的单值 map。
 *
 * 一个响应可以合法地重复同一个字段名，而载荷结构是 `Map<String, String>`，所以必须折叠。
 * 按 RFC 7230 §3.2.2 折：重复字段等价于「用逗号把各值按到达顺序连起来」的单个字段，且字段名
 * **大小写不敏感**——`X-A` 与 `x-a` 是同一个字段的重复，不是两个字段。保留的拼写是**最先到达**
 * 的那个，不做规范化改写。让最后一个值覆盖前面的做法会静默丢值，还会把大小写变体裂成两个键。
 *
 * 这是**响应**头的规则，与**请求**头刻意不同：请求头带的是调用方写下的东西，原样穿透、
 * 不折大小写；响应头带的是线上说的东西。
 *
 * 逐条按下标读，不走 `Headers.values(name)`：那个方法本身就是大小写不敏感的，按名去取会把同
 * 一个字段的全部值取回来，重复字段有几条就会被算几遍。
 *
 * 已知有损点：多条 `Set-Cookie` 也照此拼接。它在实践中不使用 list 语法（`Expires` 自身含逗号），
 * 拼完无法可靠拆回；仍然这么做是因为 iOS 的 HTTP 栈本就这样合并，给这里开豁免会重新制造三端分叉。
 */
internal fun mergeResponseHeaders(headers: Headers): Map<String, String> {
    val merged = LinkedHashMap<String, String>()
    // 小写名 -> 最先到达的那个拼写，也就是 merged 里实际用的键。
    val keyByLowercasedName = HashMap<String, String>()
    for (index in 0 until headers.size) {
        val name = headers.name(index)
        val value = headers.value(index)
        val key = keyByLowercasedName.getOrPut(name.lowercase()) { name }
        val existing = merged[key]
        merged[key] = if (existing == null) value else "$existing, $value"
    }
    return merged
}

internal class OkHttpSocketTransport : SocketTransport {
    companion object {
        private val baseClient: OkHttpClient by lazy { OkHttpClient.Builder().build() }

        private val tcpNoDelaySocketFactory: SocketFactory by lazy {
            object : SocketFactory() {
                override fun createSocket(): Socket = Socket().apply { tcpNoDelay = true }
                override fun createSocket(host: String?, port: Int): Socket =
                    Socket(host, port).apply { tcpNoDelay = true }
                override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int): Socket =
                    Socket(host, port, localHost, localPort).apply { tcpNoDelay = true }
                override fun createSocket(host: java.net.InetAddress?, port: Int): Socket =
                    Socket(host, port).apply { tcpNoDelay = true }
                override fun createSocket(
                    address: java.net.InetAddress?,
                    port: Int,
                    localAddress: java.net.InetAddress?,
                    localPort: Int,
                ): Socket = Socket(address, port, localAddress, localPort).apply { tcpNoDelay = true }
            }
        }
    }

    override fun connect(spec: TransportConnectSpec, callbacks: TransportCallbacks): TransportHandle {
        val requestBuilder = Request.Builder().url(spec.url)
        spec.headers.forEach { (name, value) -> requestBuilder.addHeader(name, value) }
        // Protocols are set by native itself; the disallowed-header set only constrains callers.
        if (spec.protocols.isNotEmpty()) {
            requestBuilder.addHeader("Sec-WebSocket-Protocol", spec.protocols.joinToString(", "))
        }
        val request = requestBuilder.build()

        val timestamps = ProfileTimestamps()
        var clientBuilder = baseClient.newBuilder().eventListener(TimestampEventListener(timestamps))
        // perMessageDeflate: no-op, OkHttp auto-negotiates and cannot be disabled.
        if (spec.tcpNoDelay) {
            clientBuilder = clientBuilder.socketFactory(tcpNoDelaySocketFactory)
        }
        // OkHttp 默认连接超时 10 秒，调用方要求更长时会被它先掐断，所以跟着请求值走。
        clientBuilder = clientBuilder.connectTimeout(okHttpConnectTimeoutMs(spec.connectTimeoutMs), TimeUnit.MILLISECONDS)
        val client = clientBuilder.build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                callbacks.onOpen(mergeResponseHeaders(response.headers), timestamps.toHints())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                callbacks.onMessageText(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                callbacks.onMessageBinary(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
                callbacks.onClosing(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                callbacks.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                callbacks.onFailure(t.message, classifyTransportFailure(t))
            }
        }

        val webSocket = client.newWebSocket(request, listener)
        return OkHttpTransportHandle(webSocket)
    }
}

private class ProfileTimestamps {
    @Volatile var domainLookUpStart: Long? = null
    @Volatile var domainLookUpEnd: Long? = null
    @Volatile var connectStart: Long? = null
    @Volatile var connectEnd: Long? = null

    fun toHints(): TransportProfileHints =
        TransportProfileHints(domainLookUpStart, domainLookUpEnd, connectStart, connectEnd)
}

/** Best-effort real dns/connect timestamps for the open-event profile; iOS lacks this precision, Android has it. */
private class TimestampEventListener(private val timestamps: ProfileTimestamps) : EventListener() {
    override fun dnsStart(call: Call, domainName: String) {
        timestamps.domainLookUpStart = System.currentTimeMillis()
    }

    override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<java.net.InetAddress>) {
        timestamps.domainLookUpEnd = System.currentTimeMillis()
    }

    override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
        timestamps.connectStart = System.currentTimeMillis()
    }

    override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: okhttp3.Protocol?) {
        timestamps.connectEnd = System.currentTimeMillis()
    }

    override fun secureConnectEnd(call: Call, handshake: okhttp3.Handshake?) {
        timestamps.connectEnd = System.currentTimeMillis()
    }
}

private class OkHttpTransportHandle(private val webSocket: WebSocket) : TransportHandle {
    override fun sendText(text: String): Boolean = webSocket.send(text)
    override fun sendBytes(bytes: ByteArray): Boolean = webSocket.send(Buffer().write(bytes).readByteString())
    override fun close(code: Int, reason: String) {
        webSocket.close(code, reason)
    }
    override fun cancel() {
        webSocket.cancel()
    }
}

/** Production [TaskScheduler] backed by a [java.util.concurrent.ScheduledExecutorService]. */
internal class RealTaskScheduler : TaskScheduler {
    private val scheduledExecutor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "dimina-websocket-timer").apply { isDaemon = true }
    }

    override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
        val future = scheduledExecutor.schedule({ task() }, delayMs, TimeUnit.MILLISECONDS)
        return object : Cancellable {
            override fun cancel() {
                future.cancel(false)
            }
        }
    }
}

/** Production [Clock] backed by [System.currentTimeMillis]. */
internal class RealClock : Clock {
    override fun nowMs(): Long = System.currentTimeMillis()
}

/** Production [SerialExecutor] backed by a single-thread executor. */
internal class RealSerialExecutor : SerialExecutor {
    private val singleThreadExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "dimina-websocket").apply { isDaemon = true }
    }

    override fun execute(task: () -> Unit) {
        singleThreadExecutor.execute {
            try {
                task()
            } catch (e: Exception) {
                LogUtils.e("WebSocketManager", "Unhandled exception on serial executor: ${e.message}")
            }
        }
    }
}
