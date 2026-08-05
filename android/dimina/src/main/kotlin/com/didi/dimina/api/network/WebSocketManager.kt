package com.didi.dimina.api.network

import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import okhttp3.Call
import okhttp3.EventListener
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

    /** Transport failure at any phase; `message` may be null/blank. */
    fun onFailure(message: String?)
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
     * 已派发过的 open 载荷。connectSocket 一返回原生就立刻开始拨号，本机回环握手可能
     * 只要几毫秒，比调用方紧接着发来的 onSocketOpen 注册消息还快；如果这次注册输了
     * 这场竞速，只能靠在 onSocketEvent 里把这份载荷补发给它，否则这个 open 事件就永久丢了。
     */
    var openPayload: JSONObject? = null

    /** Ordered, de-duplicated per-event listener ids (task-mode `onSocketXxx`). */
    val listeners: MutableMap<String, LinkedHashSet<String>> = mutableMapOf()
}

/** Per mini-program (appId) WebSocket state. */
private class OwnerState(val appId: String) {
    val sockets: MutableMap<String, SocketEntry> = LinkedHashMap()

    // Legacy (no-socketId) global API state.
    var legacyBoundSocketId: String? = null

    /**
     * Ordered, de-duplicated per-event listener ids for the global `wx.onSocketXxx` API.
     * Same shape as [SocketEntry.listeners]: fe keeps one callback id per registered listener
     * function and sends a separate `onSocketXxx` for each, so a single id per event would
     * silently drop every listener but the last one.
     */
    val legacySlots: MutableMap<String, LinkedHashSet<String>> = mutableMapOf()

    var backgrounded: Boolean = false
    var graceTimer: Cancellable? = null
    var emitter: ((String) -> Unit)? = null

    /**
     * 已派发过的终态事件（error/close）载荷，键是 "$socketId|$event"。连接一旦进入终态，
     * entry 就从 [sockets] 里删掉了；但 connectSocket 一返回原生就立刻开始拨号，本机回环
     * 的 ECONNREFUSED 可能只要几毫秒，比调用方紧接着发来的 onSocketError/onSocketClose
     * 注册消息还快，输了这场竞速时条目已经找不到了，只能把记录挂在 owner 上，注册时
     * 按需补发。用 LinkedHashMap 保证插入顺序，超过 [WebSocketManager.TERMINAL_REPLAY_CAPACITY]
     * 时淘汰最旧的一条。
     */
    val terminalReplay: MutableMap<String, JSONObject> = LinkedHashMap()
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
            entry.idleTimerHandle?.cancel()
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
                ApiUtils.invokeFail(params, JSONObject().put("errMsg", "connectSocket:fail $msg"), responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
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

            if (owner.sockets.size >= MAX_CONNECTIONS_PER_OWNER) {
                fail("reach max websocket connect count $MAX_CONNECTIONS_PER_OWNER")
                return@execute
            }

            val urlResult = WebSocketValidation.validateUrl(params.optRawOrNull("url"))
            val validUrl = when (urlResult) {
                is WebSocketValidation.Result.Fail -> { fail(urlResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> urlResult.value
            }

            val timeoutResult = WebSocketValidation.validateTimeout(params.optRawOrNull("timeout"))
            val timeoutMs = when (timeoutResult) {
                is WebSocketValidation.Result.Fail -> { fail(timeoutResult.errMsg); return@execute }
                is WebSocketValidation.Result.Ok -> timeoutResult.value
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

            val entry = SocketEntry(socketId)
            entry.fetchStartMs = clock.nowMs()
            entry.connectTimeoutMs = timeoutMs
            owner.sockets[socketId] = entry

            // Bind if no live legacy binding exists yet.
            val boundIsDead = owner.legacyBoundSocketId?.let { !owner.sockets.containsKey(it) } ?: true
            if (boundIsDead) {
                owner.legacyBoundSocketId = socketId
            }

            // Success fires immediately once validation passes and the dial starts, not when the
            // connection actually opens.
            ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "connectSocket:ok"), responseCallback)
            ApiUtils.invokeComplete(params, responseCallback)

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
        if (!owner.sockets.containsKey(entry.socketId)) return
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
                    if (owner.sockets.containsKey(entry.socketId) && entry.state == SocketState.OPEN) {
                        entry.state = SocketState.CLOSING
                    }
                }
            }

            override fun onClosed(code: Int, reason: String) {
                executor.execute { handleTransportClosed(owner, entry, code, reason) }
            }

            override fun onFailure(message: String?) {
                executor.execute { handleTransportFailure(owner, entry, message) }
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
            handleTransportFailure(owner, entry, e.message)
            return
        }
    }

    private fun handleTransportOpen(
        owner: OwnerState,
        entry: SocketEntry,
        headers: Map<String, String>,
        hints: TransportProfileHints,
    ) {
        if (!owner.sockets.containsKey(entry.socketId)) return

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

        val payload = JSONObject()
            .put("header", JSONObject(headers as Map<*, *>))
            .put("profile", profile)
        entry.openPayload = payload
        dispatchEvent(owner, entry, "open", payload)
    }

    private fun handleTransportMessageText(owner: OwnerState, entry: SocketEntry, text: String) {
        if (!owner.sockets.containsKey(entry.socketId)) return
        resetIdleTimerIfNeeded(owner, entry)
        dispatchEvent(owner, entry, "message", JSONObject().put("data", text))
    }

    private fun handleTransportMessageBinary(owner: OwnerState, entry: SocketEntry, bytes: ByteArray) {
        if (!owner.sockets.containsKey(entry.socketId)) return
        resetIdleTimerIfNeeded(owner, entry)
        val base64 = Base64.getEncoder().encodeToString(bytes)
        dispatchEvent(owner, entry, "message", JSONObject().put("data", base64).put("isBuffer", true))
    }

    private fun handleTransportClosed(owner: OwnerState, entry: SocketEntry, code: Int, reason: String) {
        if (!owner.sockets.containsKey(entry.socketId)) return
        if (!entry.opened) {
            // Defensive: an unopened connection must never surface `close`.
            // The reason here comes off the wire and is entirely the server's to choose, so it is
            // deliberately dropped rather than folded into the API-level error string - iOS and
            // HarmonyOS both report the generic connection-failed text on this path.
            terminateHandshakeWithError(owner, entry, normalizeConnectFailureErrMsg(null))
            return
        }
        val reportedCode = entry.requestedCloseCode ?: code
        val reportedReason = entry.requestedCloseReason ?: reason
        detachEntry(owner, entry)
        dispatchEvent(owner, entry, "close", closeEventPayload(reportedCode, reportedReason))
    }

    private fun handleTransportFailure(owner: OwnerState, entry: SocketEntry, message: String?) {
        if (!owner.sockets.containsKey(entry.socketId)) return
        if (!entry.opened) {
            terminateHandshakeWithError(owner, entry, normalizeConnectFailureErrMsg(message))
            return
        }
        // A transport failure while a client-initiated close is already in flight (requestedCloseCode
        // set) must report close only, never error — only a genuinely unsolicited failure on an
        // otherwise-untouched connection gets an error event.
        val clientCloseInFlight = entry.requestedCloseCode != null
        if (!clientCloseInFlight && !entry.errorEmitted) {
            entry.errorEmitted = true
            dispatchEvent(owner, entry, "error", JSONObject().put("errMsg", normalizeConnectFailureErrMsg(message)))
        }
        val code = entry.requestedCloseCode ?: 1006
        val reason = entry.requestedCloseReason ?: (message ?: "")
        detachEntry(owner, entry)
        dispatchEvent(owner, entry, "close", closeEventPayload(code, reason))
    }

    private fun handleConnectTimeout(owner: OwnerState, entry: SocketEntry) {
        if (!owner.sockets.containsKey(entry.socketId)) return
        if (entry.state == SocketState.OPEN) return
        terminateHandshakeWithError(owner, entry, "connectSocket:fail timed out")
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
        entry.idleTimerHandle?.cancel()
        entry.idleTimerHandle = scheduler.schedule(idleTimeoutMs) {
            executor.execute { handleIdleTimeout(owner, entry) }
        }
    }

    private fun resetIdleTimerIfNeeded(owner: OwnerState, entry: SocketEntry) {
        if (entry.state == SocketState.OPEN) startIdleTimerIfNeeded(owner, entry)
    }

    private fun handleIdleTimeout(owner: OwnerState, entry: SocketEntry) {
        if (!owner.sockets.containsKey(entry.socketId)) return
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
        entry.idleTimerHandle?.cancel()
        owner.sockets.remove(entry.socketId)
    }

    private fun closeEventPayload(code: Int, reason: String): JSONObject =
        JSONObject().put("code", code).put("reason", reason)

    private fun normalizeConnectFailureErrMsg(message: String?): String {
        val msg = message?.trim().orEmpty()
        if (msg.isEmpty()) return "connectSocket:fail WebSocket connection failed"
        if (Regex("(?i)time.?out").containsMatchIn(msg)) return "connectSocket:fail timeout"
        return "connectSocket:fail $msg"
    }

    /**
     * Dispatches [event] first to the connection's task-mode listeners (registration order), then,
     * if this connection is the legacy binding target, to the corresponding global slot.
     */
    private fun dispatchEvent(owner: OwnerState, entry: SocketEntry, event: String, payload: JSONObject) {
        if (event == "error" || event == "close") {
            recordTerminalEvent(owner, entry.socketId, event, payload)
        }
        val emitter = owner.emitter ?: return
        entry.listeners[event]?.forEach { callbackId ->
            emitter(ApiUtils.createCallbackResponse(callbackId, payload))
        }
        if (owner.legacyBoundSocketId == entry.socketId) {
            owner.legacySlots[event]?.forEach { callbackId ->
                emitter(ApiUtils.createCallbackResponse(callbackId, payload))
            }
        }
    }

    /** 记录一条终态事件，供 entry 从 [OwnerState.sockets] 删除之后才到达的迟到注册补发；见 [OwnerState.terminalReplay]。 */
    private fun recordTerminalEvent(owner: OwnerState, socketId: String, event: String, payload: JSONObject) {
        val key = "$socketId|$event"
        // 先 delete 再 set，保证这条记录被刷新到插入顺序的最末尾。
        owner.terminalReplay.remove(key)
        owner.terminalReplay[key] = payload
        while (owner.terminalReplay.size > TERMINAL_REPLAY_CAPACITY) {
            val iterator = owner.terminalReplay.keys.iterator()
            if (!iterator.hasNext()) break
            iterator.next()
            iterator.remove()
        }
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
                ApiUtils.invokeFail(params, JSONObject().put("errMsg", "sendSocketMessage:fail $msg"), responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
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
                ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "sendSocketMessage:ok"), responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
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
                ApiUtils.invokeFail(params, JSONObject().put("errMsg", "closeSocket:fail $msg"), responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
            }

            fun ok() {
                ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "closeSocket:ok"), responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
            }

            if (owner.backgrounded) {
                fail("interrupted")
                return@execute
            }

            if (!hasSocketId) {
                val boundEntry = owner.legacyBoundSocketId?.let { owner.sockets[it] }
                // Existence and "already closing" must be checked before code/reason, same as task
                // mode below — an invalid code/reason must never preempt the mandatory "not
                // connected" + sweep path for a dead/closing target.
                if (boundEntry == null || boundEntry.state == SocketState.CLOSING) {
                    fail("WebSocket is not connected")
                } else {
                    val codeResult = WebSocketValidation.validateCloseCode(params.optRawOrNull("code"))
                    val reasonResult = WebSocketValidation.validateReason(params.optRawOrNull("reason"))
                    when {
                        codeResult is WebSocketValidation.Result.Fail -> fail(codeResult.errMsg)
                        reasonResult is WebSocketValidation.Result.Fail -> fail(reasonResult.errMsg)
                        else -> {
                            val code = (codeResult as WebSocketValidation.Result.Ok).value
                            val reason = (reasonResult as WebSocketValidation.Result.Ok).value
                            closeEntryByClient(owner, boundEntry, code, reason)
                            ok()
                        }
                    }
                }
                // Sweep: regardless of the bound outcome, close every other live connection with defaults.
                val excludeId = boundEntry?.socketId
                owner.sockets.values.filter { it.socketId != excludeId }.toList().forEach { e ->
                    closeEntryByClient(owner, e, 1000, "")
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

            closeEntryByClient(owner, entry, code, reason)
            ok()
        }
    }

    private fun closeEntryByClient(owner: OwnerState, entry: SocketEntry, code: Int, reason: String) {
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
                    val entry = owner.sockets[socketId]
                    entry?.listeners?.getOrPut(event) { LinkedHashSet() }?.add(callbackId)
                    // 连接已经是 OPEN 且 open 已经派发过一次：说明这次注册输给了握手竞速，
                    // 直接把当时的载荷补发给这个刚注册的 callbackId（原样复用 dispatchEvent
                    // 内部的推送方式），只在 task 模式补发，legacy 全局槽位不需要这个兜底。
                    if (event == "open" && entry != null && entry.state == SocketState.OPEN) {
                        entry.openPayload?.let { payload ->
                            owner.emitter?.let { emit -> emit(ApiUtils.createCallbackResponse(callbackId, payload)) }
                        }
                    } else if (event == "error" || event == "close") {
                        // 终态事件同样可能输给竞速，但那时 entry 已经从 sockets 里删掉了，
                        // 补发只能靠 owner.terminalReplay；见 OwnerState.terminalReplay 注释。
                        owner.terminalReplay["$socketId|$event"]?.let { payload ->
                            owner.emitter?.let { emit -> emit(ApiUtils.createCallbackResponse(callbackId, payload)) }
                        }
                    }
                } else {
                    owner.legacySlots.getOrPut(event) { LinkedHashSet() }.add(callbackId)
                }
            }
            ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "$apiName:ok"), responseCallback)
            ApiUtils.invokeComplete(params, responseCallback)
        }
    }

    /**
     * Handles `offSocketOpen`/`offSocketMessage`/`offSocketError`/`offSocketClose`.
     * Both modes: if `params.callback` is a usable string id, remove exactly that id and leave the
     * other listeners of that event alone; otherwise clear every listener for that event.
     * fe exports the global `wx.offSocketOpen`/`offSocketMessage`/`offSocketError`/`offSocketClose`,
     * so the legacy path is reachable and must behave the same as the task-mode one.
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
                val set = owner.sockets[params.optString("socketId", "")]?.listeners?.get(event)
                if (set != null) {
                    if (callbackId.isNotEmpty()) set.remove(callbackId) else set.clear()
                }
            } else {
                val slot = owner.legacySlots[event]
                if (slot != null) {
                    if (callbackId.isNotEmpty()) slot.remove(callbackId) else slot.clear()
                }
            }
            ApiUtils.invokeSuccess(params, JSONObject().put("errMsg", "$apiName:ok"), responseCallback)
            ApiUtils.invokeComplete(params, responseCallback)
        }
    }
}

/** Production [SocketTransport] backed by a lazily-created singleton [okhttp3.OkHttpClient]. */
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
        // OkHttp 默认连接超时 10 秒，调用方要求更长时会被它先掐断。这里跟着请求值走，
        // 并留一点余量，让容器自己的连接定时器始终先到，OkHttp 的超时只当兜底——否则
        // 两个超时同时到点，最终报的是哪一条错误就不确定了。
        clientBuilder = clientBuilder.connectTimeout(spec.connectTimeoutMs.toLong() + 1000, TimeUnit.MILLISECONDS)
        val client = clientBuilder.build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val headers = mutableMapOf<String, String>()
                response.headers.forEach { (name, value) -> headers[name] = value }
                callbacks.onOpen(headers, timestamps.toHints())
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
                callbacks.onFailure(t.message)
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
