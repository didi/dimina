package com.didi.dimina.api.network

import com.didi.dimina.bean.AppConfig
import kotlinx.serialization.json.Json
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Base64

/** File-scope SAM-constructor-style helper: [Cancellable] has no companion factory of its own. */
private fun Cancellable(onCancel: () -> Unit): Cancellable = object : Cancellable {
    override fun cancel() = onCancel()
}

/** The eight `SocketProfile` fields the open event must carry, in the order the type declares them. */
private val SOCKET_PROFILE_KEYS = listOf(
    "fetchStart", "domainLookUpStart", "domainLookUpEnd",
    "connectStart", "connectEnd", "rtt", "handshakeCost", "cost",
)

/** Exact key set of [json] - event payload contracts are "these fields and no others". */
private fun keysOf(json: JSONObject): Set<String> {
    val keys = mutableSetOf<String>()
    val iterator = json.keys()
    while (iterator.hasNext()) keys.add(iterator.next())
    return keys
}

/**
 * Covers [WebSocketManager] behavior driven deterministically via a scripted fake [SocketTransport]
 * plus a manually-advanced fake clock/scheduler and an immediate [SerialExecutor].
 * (Pure validation logic is covered separately by WebSocketValidationTest.)
 */
class WebSocketManagerTest {

    // ---- test doubles ----

    private class ImmediateSerialExecutor : SerialExecutor {
        override fun execute(task: () -> Unit) = task()
    }

    /**
     * A [SerialExecutor] that queues tasks instead of running them while [deferring] is on, and
     * runs the queue FIFO on [drain] - lets a test force a specific interleaving between two tasks
     * that a plain [ImmediateSerialExecutor] would always run inline and in submission order.
     */
    private class DeferringSerialExecutor : SerialExecutor {
        var deferring = false
        private val queue = ArrayDeque<() -> Unit>()

        override fun execute(task: () -> Unit) {
            if (deferring) queue.add(task) else task()
        }

        fun drain() {
            while (queue.isNotEmpty()) queue.removeFirst()()
        }
    }

    private class FakeClock : Clock {
        var currentMs: Long = 0L
        override fun nowMs(): Long = currentMs
    }

    /** Delay-0 tasks are queued, not run inline - this is what makes the same-tick close race testable. */
    private class FakeTaskScheduler(private val clock: FakeClock) : TaskScheduler {
        private class ScheduledTask(val dueAtMs: Long, val seq: Long, var cancelled: Boolean, val task: () -> Unit)

        private val pending = mutableListOf<ScheduledTask>()
        private var seqCounter = 0L

        override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
            val entry = ScheduledTask(clock.currentMs + delayMs, seqCounter++, false, task)
            pending.add(entry)
            return Cancellable { entry.cancelled = true }
        }

        /** Advances the fake clock by [ms] and runs every task now due, in (due-time, insertion) order. */
        fun advanceBy(ms: Long) {
            clock.currentMs += ms
            runDue()
        }

        /** Tasks still scheduled and not cancelled - used to assert a timer was really cancelled. */
        fun pendingCount(): Int = pending.count { !it.cancelled }

        /** Runs whatever is already due (e.g. delay=0 "queued dial" tasks) without moving time. */
        fun runDue() {
            while (true) {
                val next = pending
                    .filter { !it.cancelled && it.dueAtMs <= clock.currentMs }
                    .minWithOrNull(compareBy({ it.dueAtMs }, { it.seq }))
                    ?: break
                pending.remove(next)
                next.task()
            }
        }
    }

    private class FakeConnection(val callbacks: TransportCallbacks) {
        var cancelCalled = false
        val closeCalls = mutableListOf<Pair<Int, String>>()
        val sentTexts = mutableListOf<String>()
        val sentBytes = mutableListOf<ByteArray>()
        var nextSendResult = true

        val handle = object : TransportHandle {
            override fun sendText(text: String): Boolean {
                sentTexts.add(text)
                return nextSendResult
            }

            override fun sendBytes(bytes: ByteArray): Boolean {
                sentBytes.add(bytes)
                return nextSendResult
            }

            override fun close(code: Int, reason: String) {
                closeCalls.add(code to reason)
            }

            override fun cancel() {
                cancelCalled = true
            }
        }
    }

    private class FakeSocketTransport : SocketTransport {
        val connections = mutableListOf<FakeConnection>()
        val specs = mutableListOf<TransportConnectSpec>()

        /** Set to make the next dial blow up synchronously, the way OkHttp does on a bad header. */
        var connectThrows: Exception? = null

        override fun connect(spec: TransportConnectSpec, callbacks: TransportCallbacks): TransportHandle {
            connectThrows?.let { connectThrows = null; throw it }
            specs.add(spec)
            val conn = FakeConnection(callbacks)
            connections.add(conn)
            return conn.handle
        }
    }

    private lateinit var clock: FakeClock
    private lateinit var scheduler: FakeTaskScheduler
    private lateinit var transport: FakeSocketTransport
    private lateinit var manager: WebSocketManager
    private lateinit var responses: MutableList<String>
    private lateinit var events: MutableList<String>

    @Before
    fun setUp() {
        clock = FakeClock()
        scheduler = FakeTaskScheduler(clock)
        transport = FakeSocketTransport()
        manager = WebSocketManager(transport, scheduler, clock, ImmediateSerialExecutor())
        responses = mutableListOf()
        events = mutableListOf()
    }

    // ---- helpers ----

    private fun connectParams(
        socketId: String,
        url: String = "wss://example.com/socket",
        success: String = "success_$socketId",
        fail: String = "fail_$socketId",
    ): JSONObject = JSONObject().apply {
        put("socketId", socketId)
        put("url", url)
        put("success", success)
        put("fail", fail)
    }

    private fun listenParams(socketId: String? = null, callback: String): JSONObject = JSONObject().apply {
        socketId?.let { put("socketId", it) }
        put("callback", callback)
    }

    /** [WebSocketManager.onSocketEvent] with the bridge API name derived from [event], routed to [responses]. */
    private fun onEvent(event: String, appId: String, hasSocketId: Boolean, params: JSONObject) {
        manager.onSocketEvent(event, appId, hasSocketId, params, "onSocket${event.replaceFirstChar(Char::uppercaseChar)}", responses::add)
    }

    /** [WebSocketManager.offSocketEvent] with the bridge API name derived from [event], routed to [responses]. */
    private fun offEvent(event: String, appId: String, hasSocketId: Boolean, params: JSONObject) {
        manager.offSocketEvent(event, appId, hasSocketId, params, "offSocket${event.replaceFirstChar(Char::uppercaseChar)}", responses::add)
    }

    /** Parses every captured wire message matching [callbackId] and returns its `args` payload, in order. */
    private fun argsFor(messages: List<String>, callbackId: String): List<JSONObject> =
        messages.map { JSONObject(it) }
            .filter { it.getJSONObject("body").getString("id") == callbackId }
            .mapNotNull { it.getJSONObject("body").optJSONObject("args") }

    private fun errMsgOf(messages: List<String>, callbackId: String): String =
        argsFor(messages, callbackId).single().getString("errMsg")

    /**
     * Dials one connection on its own [appId], fails it at the transport with [transportMessage]
     * before it ever opens, and returns the errMsg the error event carried.
     */
    private fun connectFailureErrMsg(
        appId: String,
        transportMessage: String?,
        kind: TransportFailureKind = TransportFailureKind.UNKNOWN,
    ): String {
        val ownerEvents = mutableListOf<String>()
        manager.updateEmitter(appId) { ownerEvents.add(it) }
        manager.connectSocket(appId, "0", connectParams("s1"), responses::add)
        onEvent("error", appId, true, listenParams("s1", "err-cb"))
        scheduler.runDue()

        transport.connections.last().callbacks.onFailure(transportMessage, kind)

        return errMsgOf(ownerEvents, "err-cb")
    }

    /**
     * The connect timeout the one and only dial was given. Reports what went wrong instead of
     * throwing when no dial happened at all - a connect that died before reaching the transport
     * (a 0ms deadline that fires first, say) would otherwise surface as an empty-list exception.
     */
    private fun dialledConnectTimeoutMs(): Int {
        assertEquals(
            "exactly one dial must have been attempted, but specs=${transport.specs} and the caller " +
                "was told ${argsFor(responses, "fail_s1")}",
            1,
            transport.specs.size,
        )
        return transport.specs.single().connectTimeoutMs
    }

    /** Dials [socketIds] on [appId], drives each to OPEN, and returns their connections in order. */
    private fun openConnections(appId: String, socketIds: List<String>): List<FakeConnection> {
        val firstIndex = transport.connections.size
        socketIds.forEach { manager.connectSocket(appId, "0", connectParams(it), responses::add) }
        scheduler.runDue()
        val opened = transport.connections.drop(firstIndex)
        opened.forEach { it.callbacks.onOpen(emptyMap(), TransportProfileHints()) }
        return opened
    }

    // ---- container-injected header ----

    @Test
    fun dialCarriesContainerRefererAndNoOrigin() {
        manager.connectSocket("app1", "37", connectParams("s1"), responses::add)
        scheduler.runDue()

        val spec = transport.specs.single()
        assertEquals("https://servicedimina.com/app1/37/page-frame.html", spec.headers["Referer"])
        // 微信文档对 header 只规定「不能设置 Referer」，没说容器会补 Origin，所以不补。
        assertNull(spec.headers.keys.firstOrNull { it.equals("origin", ignoreCase = true) })
    }

    @Test
    fun callerSuppliedRefererIsReplacedByTheContainerOne() {
        val params = connectParams("s1").put("header", JSONObject().put("Referer", "https://evil.example/"))
        manager.connectSocket("app1", "37", params, responses::add)
        scheduler.runDue()

        assertEquals(
            "https://servicedimina.com/app1/37/page-frame.html",
            transport.specs.single().headers["Referer"],
        )
    }

    @Test
    fun unknownAppVersionFallsBackToZero() {
        manager.connectSocket("app1", "", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(
            "https://servicedimina.com/app1/0/page-frame.html",
            transport.specs.single().headers["Referer"],
        )
    }

    // ---- connect timeout wiring ----

    @Test
    fun dialWithoutTimeoutParamUsesDefaultConnectTimeoutMs() {
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(60000, transport.specs.single().connectTimeoutMs)
    }

    @Test
    fun dialWithExplicitTimeoutParamUsesThatValue() {
        val params = connectParams("s1").put("timeout", 120000)
        manager.connectSocket("app1", "0", params, responses::add)
        scheduler.runDue()

        assertEquals(120000, transport.specs.single().connectTimeoutMs)
    }

    @Test
    fun dialWithNumericStringTimeoutParamIsRejected() {
        val params = connectParams("s1").put("timeout", "3000")
        manager.connectSocket("app1", "0", params, responses::add)
        scheduler.runDue()

        assertTrue(transport.specs.isEmpty())
        assertEquals("connectSocket:fail invalid timeout", errMsgOf(responses, "fail_s1"))
    }

    // ---- app.json networkTimeout.connectSocket ----

    /*
     * The 60000 ms default is the *last* fallback, not the only source: `app.json`'s
     * `networkTimeout.connectSocket` sits between it and the caller. The precedence is
     * call-site `timeout` > `app.json` > 60000, and the configuration is per mini program.
     *
     * The manager therefore needs a per-owner entry point for the parsed `app.json` value, mirroring
     * `updateEmitter`: `updateNetworkTimeout(appId, connectSocketMs)`, where `null` means the
     * mini program declared no `networkTimeout.connectSocket`.
     */

    @Test
    fun connectTimeoutDefaultsToAppJsonNetworkTimeoutWhenTheCallerOmitsIt() {
        manager.updateNetworkTimeout("app1", 8000)

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(8000, transport.specs.single().connectTimeoutMs)
    }

    @Test
    fun callerSuppliedTimeoutOutranksAppJsonNetworkTimeout() {
        manager.updateNetworkTimeout("app1", 8000)

        manager.connectSocket("app1", "0", connectParams("s1").put("timeout", 3000), responses::add)
        scheduler.runDue()

        assertEquals(3000, transport.specs.single().connectTimeoutMs)
    }

    @Test
    fun connectTimeoutFallsBackTo60000OnlyWhenAppJsonDeclaresNoNetworkTimeout() {
        manager.updateNetworkTimeout("app1", null)

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(60000, transport.specs.single().connectTimeoutMs)
    }

    @Test
    fun appJsonNetworkTimeoutIsPerMiniProgramAndDoesNotLeakToAnother() {
        manager.updateNetworkTimeout("appA", 8000)

        manager.connectSocket("appB", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(60000, transport.specs.single().connectTimeoutMs)
    }

    /**
     * End to end over the shape of `app.json` a mini program actually ships: `networkTimeout`
     * carrying `connectSocket` alone, decoded exactly the way `DiminaActivity.readAppConfig` does
     * it, then handed to the manager. Configuring one entry and leaving the other three out must
     * both decode and reach the dial - the partially-configured block is the common case, not an
     * edge case.
     */
    @Test
    fun anAppJsonConfiguringOnlyConnectSocketDrivesTheDialTimeoutEndToEnd() {
        val appConfig = Json { ignoreUnknownKeys = true }.decodeFromString<AppConfig>(
            """{"app":{"pages":["pages/index/index"],"networkTimeout":{"connectSocket":8000}},"modules":{}}""",
        )

        manager.updateNetworkTimeout("app1", appConfig.app.networkTimeout?.connectSocket)
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        assertEquals(8000, transport.specs.single().connectTimeoutMs)
    }

    /** The app.json value drives the container's own connect timer, not just what the transport is told. */
    @Test
    fun theContainerConnectTimerAlsoRunsOnTheAppJsonTimeout() {
        manager.updateNetworkTimeout("app1", 8000)
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "err-cb"))
        scheduler.runDue()

        scheduler.advanceBy(7999)
        assertTrue("the connect timer must not fire before the app.json timeout", argsFor(events, "err-cb").isEmpty())

        scheduler.advanceBy(1)
        assertEquals(1, argsFor(events, "err-cb").size)
    }

    // ---- url scheme ----

    /** WSS scheme matching is case-insensitive and the original URL reaches the transport unchanged. */
    @Test
    fun everyCaseVariantOfWssDialsWithTheUrlUnchanged() {
        val urls = listOf(
            "wss://example.com/socket",
            "WSS://example.com/socket",
            "wSs://example.com/socket",
        )
        urls.forEachIndexed { i, url ->
            val appId = "app$i"
            manager.updateEmitter(appId) { }
            manager.connectSocket(
                appId, "0",
                connectParams("s$i", url = url, success = "ok-$i", fail = "fail-$i"),
                responses::add,
            )
            scheduler.runDue()

            assertEquals("connectSocket:ok for $url", "connectSocket:ok", errMsgOf(responses, "ok-$i"))
            assertEquals("url for $url must reach the transport unchanged", url, transport.specs[i].url)
        }
    }

    @Test
    fun aUrlWithABareSpaceIsRejectedBeforeAnyDial() {
        manager.connectSocket("app1", "0", connectParams("s1", url = "wss://example.com/a b"), responses::add)
        scheduler.runDue()

        assertEquals("connectSocket:fail invalid url", errMsgOf(responses, "fail_s1"))
        assertTrue(transport.specs.isEmpty())
    }

    /**
     * A non-ASCII header value is settled during validation, so the caller gets a plain `fail` and
     * nothing ever reaches the network. Letting it through means reporting `connectSocket:ok` first
     * and only then surfacing an error once the request builder refuses the header - a success the
     * caller has to un-believe.
     */
    @Test
    fun aNonAsciiHeaderValueIsRejectedBeforeAnyDial() {
        val params = connectParams("s1").put("header", JSONObject().put("X-A", "中文"))
        manager.connectSocket("app1", "0", params, responses::add)
        scheduler.runDue()

        val failArgs = argsFor(responses, "fail_s1")
        assertTrue(
            "the connect must be refused while validating; instead it was accepted " +
                "(${argsFor(responses, "success_s1")}) and dialled ${transport.specs}",
            failArgs.isNotEmpty(),
        )
        assertEquals("connectSocket:fail invalid header", failArgs.single().getString("errMsg"))
        assertTrue("no connection may be attempted", transport.specs.isEmpty())
        assertTrue(
            "the caller must never be told the connect succeeded",
            argsFor(responses, "success_s1").isEmpty(),
        )
    }

    @Test
    fun aNonWebSocketSchemeIsRejectedBeforeAnyDial() {
        manager.connectSocket("app1", "0", connectParams("s1", url = "https://example.com/socket"), responses::add)
        scheduler.runDue()

        assertEquals("connectSocket:fail invalid url", errMsgOf(responses, "fail_s1"))
        assertTrue(transport.specs.isEmpty())
    }

    // ---- concurrency ----

    /**
     * The limit message carries two `fail` words. WeChat's `FE` helper builds the string as
     * `"${name}:fail ${errMsg}"` while the errMsg it is handed already starts with `"fail "`, so
     * the doubled word is the literal output every mini program sees. Collapsing it to a single
     * `fail` would be a silent, caller-visible divergence.
     */
    @Test
    fun theSixthConnectAgainstFiveOpenConnectionsFailsWithTheDoubledFailMessage() {
        manager.updateEmitter("app1") { events.add(it) }
        openConnections("app1", (0 until 5).map { "s$it" })

        manager.connectSocket("app1", "0", connectParams("s5", success = "s5-ok", fail = "s5-fail"), responses::add)
        scheduler.runDue()

        assertEquals(
            "connectSocket:fail fail reach max websocket connect count 5",
            errMsgOf(responses, "s5-fail"),
        )
        // A rejected connect must not reach the wire at all - no sixth dial is ever started.
        assertEquals(5, transport.connections.size)
    }

    /** Handshaking connections already exist and therefore consume the five-connection allowance. */
    @Test
    fun sixthSimultaneousHandshakeIsRejected() {
        manager.updateEmitter("app1") { }
        repeat(6) { i ->
            manager.connectSocket(
                "app1", "0",
                connectParams("s$i", success = "ok-s$i", fail = "fail-s$i"),
                responses::add,
            )
        }
        scheduler.runDue()

        repeat(5) { i -> assertEquals("connectSocket:ok", errMsgOf(responses, "ok-s$i")) }
        assertEquals(
            "connectSocket:fail fail reach max websocket connect count 5",
            errMsgOf(responses, "fail-s5"),
        )
        assertEquals(5, transport.connections.size)
    }

    @Test
    fun fourOpenConnectionsPlusOnePendingHandshakeRejectAnotherConnect() {
        manager.updateEmitter("app1") { }
        openConnections("app1", (0 until 4).map { "open$it" })
        manager.connectSocket("app1", "0", connectParams("pending"), responses::add)
        scheduler.runDue()

        manager.connectSocket("app1", "0", connectParams("extra", success = "extra-ok", fail = "extra-fail"), responses::add)

        assertEquals(
            "connectSocket:fail fail reach max websocket connect count 5",
            errMsgOf(responses, "extra-fail"),
        )
        assertEquals(5, transport.connections.size)
    }

    @Test
    fun differentOwnersDoNotShareConcurrencyLimit() {
        manager.updateEmitter("appA") { }
        manager.updateEmitter("appB") { }
        openConnections("appA", (0 until 5).map { "a$it" })

        manager.connectSocket("appB", "0", connectParams("b0", success = "b0-ok", fail = "b0-fail"), responses::add)

        assertEquals("connectSocket:ok", errMsgOf(responses, "b0-ok"))
    }

    @Test
    fun closingAConnectionFreesASlotForANewConnect() {
        manager.updateEmitter("app1") { }
        val conns = openConnections("app1", (0 until 5).map { "s$it" })

        // The close event, not the close *request*, is what gives the slot back.
        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s0"); put("success", "close-ok") },
            responses::add,
        )
        conns[0].callbacks.onClosed(1000, "")

        manager.connectSocket("app1", "0", connectParams("s5", success = "s5-ok", fail = "s5-fail"), responses::add)

        assertEquals("connectSocket:ok", errMsgOf(responses, "s5-ok"))
    }

    /** An OPEN connection that errors out releases its slot too. */
    @Test
    fun anErroringConnectionFreesASlotForANewConnect() {
        manager.updateEmitter("app1") { }
        val conns = openConnections("app1", (0 until 5).map { "s$it" })

        conns[2].callbacks.onFailure("boom")

        manager.connectSocket("app1", "0", connectParams("s5", success = "s5-ok", fail = "s5-fail"), responses::add)

        assertEquals("connectSocket:ok", errMsgOf(responses, "s5-ok"))
    }

    // ---- lifecycle ----

    @Test
    fun synchronousDialFailureSurfacesErrorAtOnceAndReleasesTheSlot() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "err-cb"))
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        transport.connectThrows = IllegalArgumentException("Unexpected char 0x3a at 3 in header name")

        scheduler.runDue()

        // `success` went out as soon as validation passed, so a dial that blows up synchronously has
        // to be reported right away - otherwise the caller waits out the whole connect timeout.
        assertEquals("connectSocket:ok", errMsgOf(responses, "success_s1"))
        assertEquals(1, argsFor(events, "err-cb").size)
        assertEquals(0, argsFor(events, "close-cb").size)
        // The connect timer must be cancelled, not left to fire on a connection that is already gone.
        assertEquals(0, scheduler.pendingCount())

        // And the slot is back: five more connections still fit under the per-owner limit.
        repeat(5) { i -> manager.connectSocket("app1", "0", connectParams("n$i"), responses::add) }
        assertEquals("connectSocket:ok", errMsgOf(responses, "success_n4"))
    }

    @Test
    fun closeBeforeOpenReportsGenericErrorAndNeverLeaksTheWireReason() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "err-cb"))
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        scheduler.runDue()

        // The server picks this reason. It must not become part of the API-level error string -
        // iOS and HarmonyOS both report the generic text on this path.
        transport.connections.single().callbacks.onClosed(1002, "policy denied")

        assertEquals("connectSocket:fail WebSocket connection failed", errMsgOf(events, "err-cb"))
        assertEquals(0, argsFor(events, "close-cb").size)
    }

    // ---- event payload field sets ----

    /** The task-mode open result is exactly `{ header, profile }`; nothing internal may ride along. */
    @Test
    fun taskOpenEventPayloadCarriesExactlyHeaderAndProfile() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("open", "app1", true, listenParams("s1", "open-cb"))
        scheduler.runDue()

        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())

        val payload = argsFor(events, "open-cb").single()
        assertEquals(setOf("header", "profile"), keysOf(payload))
        assertEquals("bar", payload.getJSONObject("header").getString("X-Foo"))
    }

    /**
     * The global `onSocketOpen` result type is `{ header }` only - the timing profile belongs to the
     * task-mode result type alone, and a mini program listening globally must not receive it.
     */
    @Test
    fun globalOpenEventPayloadCarriesHeaderOnlyWhileTheTaskOneAlsoCarriesProfile() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("open", "app1", true, listenParams("s1", "task-open"))
        onEvent("open", "app1", false, listenParams(null, "global-open"))
        scheduler.runDue()

        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())

        assertEquals(setOf("header", "profile"), keysOf(argsFor(events, "task-open").single()))
        val globalPayload = argsFor(events, "global-open").single()
        assertEquals(setOf("header"), keysOf(globalPayload))
        assertEquals("bar", globalPayload.getJSONObject("header").getString("X-Foo"))
    }

    /** All eight `SocketProfile` fields are mandatory, and every one of them is a number. */
    @Test
    fun openEventProfileCarriesAllEightSocketProfileFieldsAsNumbers() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("open", "app1", true, listenParams("s1", "open-cb"))
        scheduler.runDue()
        clock.currentMs = 120

        transport.connections.single().callbacks.onOpen(
            emptyMap(),
            TransportProfileHints(domainLookUpStart = 10, domainLookUpEnd = 20, connectStart = 30, connectEnd = 90),
        )

        val profile = argsFor(events, "open-cb").single().getJSONObject("profile")
        assertEquals(SOCKET_PROFILE_KEYS.toSet(), keysOf(profile))
        SOCKET_PROFILE_KEYS.forEach { key ->
            assertTrue("profile.$key must be a number, got ${profile.get(key)}", profile.get(key) is Number)
        }
    }

    /** The close result is exactly `{ code, reason }` - `wasClean` is a W3C field WeChat never emits. */
    @Test
    fun closeEventPayloadCarriesExactlyCodeAndReasonWithNoWasClean() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("close", "app1", false, listenParams(null, "global-close-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        conn.callbacks.onClosed(4001, "server bye")

        assertEquals(setOf("code", "reason"), keysOf(argsFor(events, "close-cb").single()))
        assertEquals(setOf("code", "reason"), keysOf(argsFor(events, "global-close-cb").single()))
    }

    /** The error result is exactly `{ errMsg }` - no `errCode` alongside it. */
    @Test
    fun errorEventPayloadCarriesExactlyErrMsgWithNoErrCode() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))
        onEvent("error", "app1", false, listenParams(null, "global-error-cb"))
        scheduler.runDue()

        transport.connections.single().callbacks.onFailure("connection refused")

        assertEquals(setOf("errMsg"), keysOf(argsFor(events, "error-cb").single()))
        assertEquals(setOf("errMsg"), keysOf(argsFor(events, "global-error-cb").single()))
    }

    /** The message result is exactly `{ data }`; no socketId/state bookkeeping leaks with it. */
    @Test
    fun textMessageEventPayloadCarriesExactlyData() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("message", "app1", true, listenParams("s1", "msg-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        conn.callbacks.onMessageText("hello")

        assertEquals(setOf("data"), keysOf(argsFor(events, "msg-cb").single()))
    }

    /**
     * A binary message carries `data` plus the transport-private `isBuffer` marker the script layer
     * strips before the mini program sees it - and nothing else.
     */
    @Test
    fun binaryMessageEventPayloadCarriesOnlyDataAndTheIsBufferMarker() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("message", "app1", true, listenParams("s1", "msg-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        conn.callbacks.onMessageBinary(byteArrayOf(1, 2, 3))

        assertEquals(setOf("data", "isBuffer"), keysOf(argsFor(events, "msg-cb").single()))
    }

    @Test
    fun textMessageEventIsPlainDataNoIsBufferFlag() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("message", "app1", true, listenParams("s1", "msg-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        conn.callbacks.onMessageText("hello")

        val payload = argsFor(events, "msg-cb").single()
        assertEquals("hello", payload.getString("data"))
        assertTrue(!payload.has("isBuffer"))
    }

    @Test
    fun binaryMessageEventIsBase64WithIsBufferTrue() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("message", "app1", true, listenParams("s1", "msg-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        val bytes = byteArrayOf(1, 2, 3, 4, 5)
        conn.callbacks.onMessageBinary(bytes)

        val payload = argsFor(events, "msg-cb").single()
        assertEquals(Base64.getEncoder().encodeToString(bytes), payload.getString("data"))
        assertTrue(payload.getBoolean("isBuffer"))
    }

    @Test
    fun serverInitiatedCloseReportsWireValuesAndNeverAnError() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        conn.callbacks.onClosed(4001, "server bye")

        val closeArgs = argsFor(events, "close-cb").single()
        assertEquals(4001, closeArgs.getInt("code"))
        assertEquals("server bye", closeArgs.getString("reason"))
        assertTrue(argsFor(events, "error-cb").isEmpty())
    }

    @Test
    fun failedHandshakeEmitsOnlyErrorNeverClose() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))
        scheduler.runDue()

        transport.connections.single().callbacks.onFailure("connection refused")

        assertEquals("a failed handshake reports exactly one error", 1, argsFor(events, "error-cb").size)
        assertTrue("a connection that never opened must never report close", argsFor(events, "close-cb").isEmpty())
    }

    @Test
    fun clientCloseInFlightThenTransportFailureEmitsCloseOnlyWithRequestedCode() {
        // A transport failure while a client-initiated close is already in flight must report
        // close only (never error), with the caller's originally-requested code/reason - not the
        // synthesized 1006 fallback used for a genuinely unsolicited failure.
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("code", 4001); put("reason", "bye") },
            responses::add,
        )
        conn.callbacks.onFailure("boom")

        val closeArgs = argsFor(events, "close-cb").single()
        assertEquals(4001, closeArgs.getInt("code"))
        assertEquals("bye", closeArgs.getString("reason"))
        assertTrue("a close-in-flight transport failure must never also emit error", argsFor(events, "error-cb").isEmpty())
    }

    // ---- close then immediately reconnect ----

    /*
     * The journey these three cover is close-then-reconnect-then-send: a mini program calls
     * `wx.closeSocket()` and, without waiting for the close event to come back off the wire, opens a
     * replacement connection and sends on it globally. The close event can take a full round trip,
     * so "the old connection is still closing" is the normal state at the moment the new one opens,
     * not a rare race. From that moment on the global no-socketId APIs have to be talking to the
     * replacement.
     */

    @Test
    fun aGlobalSendAfterCloseAndReconnectReachesTheReplacementConnection() {
        manager.updateEmitter("app1") { events.add(it) }
        val connA = openConnections("app1", listOf("sA")).single()

        // Close the current connection, then build the replacement before the close event arrives -
        // the fake transport deliberately never calls back, so sA stays mid-close throughout.
        manager.closeSocket("app1", false, JSONObject().put("success", "close-ok"), responses::add)
        val connB = openConnections("app1", listOf("sB")).single()

        manager.sendSocketMessage(
            "app1", false,
            JSONObject().apply { put("data", "hello"); put("success", "send-ok"); put("fail", "send-fail") },
            responses::add,
        )

        assertTrue(
            "the global send must not be refused; it went to ${argsFor(responses, "send-fail")}",
            argsFor(responses, "send-fail").isEmpty(),
        )
        assertEquals("the replacement connection must receive the global send", listOf("hello"), connB.sentTexts)
        assertTrue("the connection being closed must not receive anything", connA.sentTexts.isEmpty())
        assertEquals("sendSocketMessage:ok", errMsgOf(responses, "send-ok"))
    }

    @Test
    fun theLateCloseOfTheReplacedConnectionNeitherStealsTheGlobalBindingNorDisturbsTheNewOne() {
        manager.updateEmitter("app1") { events.add(it) }
        val connA = openConnections("app1", listOf("sA")).single()
        onEvent("close", "app1", false, listenParams(null, "global-close"))
        onEvent("close", "app1", true, listenParams("sA", "task-close-a"))

        manager.closeSocket("app1", false, JSONObject().put("success", "close-ok"), responses::add)
        val connB = openConnections("app1", listOf("sB")).single()

        // The old connection's close finally lands, long after the replacement took over.
        connA.callbacks.onClosed(1000, "")

        assertTrue(
            "sA's own SocketTask.onClose must still fire - it is the task that was closed",
            argsFor(events, "task-close-a").isNotEmpty(),
        )
        assertTrue(
            "the global close listener follows the currently bound connection, which is sB by now; " +
                "firing it for sA means the binding never moved",
            argsFor(events, "global-close").isEmpty(),
        )

        // And the replacement is untouched: it is still the global target and still open.
        manager.sendSocketMessage(
            "app1", false,
            JSONObject().apply { put("data", "after"); put("success", "send-ok2"); put("fail", "send-fail2") },
            responses::add,
        )
        assertTrue(
            "the late close of sA must not knock sB off the global binding; send went to ${argsFor(responses, "send-fail2")}",
            argsFor(responses, "send-fail2").isEmpty(),
        )
        assertEquals(listOf("after"), connB.sentTexts)
    }

    /**
     * A connection whose close handshake is in flight is not a free slot: it still holds the wire
     * open, and its slot comes back only when the close event actually arrives. This is what
     * separates "move the global binding off a closing connection" from "drop a closing connection
     * on the floor" - the binding must move, the slot must not come back early.
     */
    @Test
    fun aConnectionWhoseCloseIsStillInFlightKeepsHoldingItsConcurrencySlot() {
        manager.updateEmitter("app1") { }
        val conns = openConnections("app1", (0 until 5).map { "s$it" })

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s0"); put("success", "close-ok") },
            responses::add,
        )

        manager.connectSocket("app1", "0", connectParams("s5", success = "early-ok", fail = "early-fail"), responses::add)
        val earlyFail = argsFor(responses, "early-fail")
        assertTrue(
            "s0's close is still in flight, so it must still hold its slot and this connect must be refused - " +
                "instead it was accepted (${argsFor(responses, "early-ok")}). Moving the global binding off a " +
                "closing connection must not also hand its slot back before the close event arrives.",
            earlyFail.isNotEmpty(),
        )
        assertEquals(
            "connectSocket:fail fail reach max websocket connect count 5",
            earlyFail.single().getString("errMsg"),
        )

        // Only once the close event lands does the slot come back.
        conns[0].callbacks.onClosed(1000, "")
        manager.connectSocket("app1", "0", connectParams("s6", success = "late-ok", fail = "late-fail"), responses::add)
        assertTrue(
            "the slot must be free once the close event has arrived; got ${argsFor(responses, "late-fail")}",
            argsFor(responses, "late-fail").isEmpty(),
        )
        assertEquals("connectSocket:ok", errMsgOf(responses, "late-ok"))
    }

    // ---- complete receives the same result as success/fail ----

    /*
     * `complete` is documented to receive the same result object as whichever of success/fail ran,
     * and mini programs read `res.errMsg` from it. Invoking it with no result at all hands the
     * caller `undefined`, so `complete: res => res.errMsg` throws instead of running.
     */

    /** Asserts [completeId] received exactly the result [settlerId] received. */
    private fun assertCompleteMirrors(settlerId: String, completeId: String) {
        val settler = argsFor(responses, settlerId).single()
        val complete = argsFor(responses, completeId)
        assertEquals(
            "complete must receive the same result object as success/fail, but it received " +
                if (complete.isEmpty()) "no result at all" else complete.toString(),
            1,
            complete.size,
        )
        assertEquals(keysOf(settler), keysOf(complete.single()))
        assertEquals(settler.getString("errMsg"), complete.single().getString("errMsg"))
    }

    @Test
    fun connectSocketCompleteMirrorsTheSuccessResult() {
        manager.connectSocket("app1", "0", connectParams("s1").put("complete", "c1"), responses::add)

        assertCompleteMirrors("success_s1", "c1")
    }

    @Test
    fun connectSocketCompleteMirrorsTheFailResult() {
        val params = connectParams("s1", url = "https://example.com/socket").put("complete", "c1")
        manager.connectSocket("app1", "0", params, responses::add)

        assertCompleteMirrors("fail_s1", "c1")
    }

    @Test
    fun sendSocketMessageCompleteMirrorsTheSuccessResult() {
        manager.updateEmitter("app1") { }
        openConnections("app1", listOf("s1"))

        manager.sendSocketMessage(
            "app1", true,
            JSONObject().apply {
                put("socketId", "s1"); put("data", "hi"); put("success", "ok"); put("complete", "c1")
            },
            responses::add,
        )

        assertCompleteMirrors("ok", "c1")
    }

    @Test
    fun sendSocketMessageCompleteMirrorsTheFailResult() {
        manager.updateEmitter("app1") { }

        manager.sendSocketMessage(
            "app1", true,
            JSONObject().apply {
                put("socketId", "nope"); put("data", "hi"); put("fail", "bad"); put("complete", "c1")
            },
            responses::add,
        )

        assertCompleteMirrors("bad", "c1")
    }

    @Test
    fun closeSocketCompleteMirrorsTheSuccessResult() {
        manager.updateEmitter("app1") { }
        openConnections("app1", listOf("s1"))

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("success", "ok"); put("complete", "c1") },
            responses::add,
        )

        assertCompleteMirrors("ok", "c1")
    }

    @Test
    fun closeSocketCompleteMirrorsTheFailResult() {
        manager.updateEmitter("app1") { }

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "nope"); put("fail", "bad"); put("complete", "c1") },
            responses::add,
        )

        assertCompleteMirrors("bad", "c1")
    }

    // ---- sub-millisecond timeout ----

    /*
     * A `timeout` below 1ms names no usable deadline - rounded down it becomes 0, and a 0ms connect
     * deadline fires before the dial can even start. Such a value counts as "not specified" and
     * falls through the normal chain (app.json, then the 60s default) instead of pinning the
     * connection to an instant failure.
     */

    @Test
    fun aSubMillisecondTimeoutFallsThroughToTheAppJsonValue() {
        manager.updateNetworkTimeout("app1", 8000)

        manager.connectSocket("app1", "0", connectParams("s1").put("timeout", 0.5), responses::add)
        scheduler.runDue()

        assertEquals(8000, dialledConnectTimeoutMs())
    }

    @Test
    fun aSubMillisecondTimeoutFallsThroughToTheDefaultWhenAppJsonHasNone() {
        manager.connectSocket("app1", "0", connectParams("s1").put("timeout", 0.5), responses::add)
        scheduler.runDue()

        assertEquals(60000, dialledConnectTimeoutMs())
    }

    @Test
    fun aSubMillisecondTimeoutDoesNotMakeTheConnectionFailImmediately() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1").put("timeout", 0.9), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "err-cb"))
        scheduler.runDue()

        assertTrue(
            "a sub-millisecond timeout must not become a 0ms deadline; got ${argsFor(events, "err-cb")}",
            argsFor(events, "err-cb").isEmpty(),
        )
    }

    /** 1ms is the smallest value that still names a real deadline, so it is honoured as given. */
    @Test
    fun aOneMillisecondTimeoutIsHonouredAsSpecified() {
        manager.updateNetworkTimeout("app1", 8000)

        manager.connectSocket("app1", "0", connectParams("s1").put("timeout", 1), responses::add)
        scheduler.runDue()

        assertEquals(1, dialledConnectTimeoutMs())
    }

    // ---- errMsg uses the container's own vocabulary, never the platform's ----

    /*
     * errMsg is contract text a mini program branches on, so it may only ever be built from the
     * container's own fixed English strings. Whatever OkHttp, the JDK or the OS produced belongs in
     * the log, not in errMsg: those strings are localized, differ between API levels and vendors,
     * and reproducing them verbatim means the same failure reads differently on two phones - which
     * is the same as having no contract at all.
     *
     * The assertions below deliberately check that the platform's text is *absent* rather than
     * pinning the canonical replacement, so the container stays free to word its own strings.
     */

    @Test
    fun theSameTransportFailureProducesTheSameErrMsgInEveryDeviceLanguage() {
        // One refused connection, as the platform renders it in three device languages.
        val english = connectFailureErrMsg("app-en", "Failed to connect to /192.0.2.1:443: Connection refused")
        val french = connectFailureErrMsg("app-fr", "Impossible de se connecter à /192.0.2.1:443 : Connexion refusée")
        val japanese = connectFailureErrMsg("app-ja", "/192.0.2.1:443 に接続できませんでした: 接続が拒否されました")

        assertEquals("errMsg must not change with the device language", english, french)
        assertEquals("errMsg must not change with the device language", english, japanese)
    }

    @Test
    fun noTransportSuppliedTextEverReachesAHandshakeErrMsg() {
        val transportMessages = listOf(
            "Failed to connect to /192.0.2.1:443",
            "Connection refused",
            "unexpected end of stream on http://example.com/",
            "Unable to resolve host \"example.com\": No address associated with hostname",
            "Chain validation failed",
            "接続が拒否されました",
        )
        transportMessages.forEachIndexed { i, raw ->
            val errMsg = connectFailureErrMsg("app-$i", raw)
            assertFalse(
                "errMsg must be built from the container's own fixed strings, but it reproduces the " +
                    "transport's text verbatim: \"$errMsg\"",
                errMsg.contains(raw),
            )
        }
    }

    @Test
    fun noTransportSuppliedTextEverReachesTheErrMsgOfAnOpenConnection() {
        manager.updateEmitter("app1") { events.add(it) }
        val conn = openConnections("app1", listOf("s1")).single()
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))

        // An already-open connection dropping is a second, independent path into the error event;
        // cleaning up only the handshake path would leave this one still leaking platform text.
        val raw = "unexpected end of stream on http://example.com/"
        conn.callbacks.onFailure(raw)

        val errMsg = argsFor(events, "error-cb").single().getString("errMsg")
        assertFalse("errMsg reproduces the transport's text verbatim: \"$errMsg\"", errMsg.contains(raw))
    }

    @Test
    fun noSdkTextFromASynchronouslyFailedDialReachesTheErrMsg() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("error", "app1", true, listenParams("s1", "err-cb"))

        // A third source of foreign text: the dial can throw straight out of the request builder.
        val sdkMessage = "Unexpected char 0x3a at 3 in header name"
        transport.connectThrows = IllegalArgumentException(sdkMessage)
        scheduler.runDue()

        val errMsg = errMsgOf(events, "err-cb")
        assertFalse("errMsg reproduces the SDK's text verbatim: \"$errMsg\"", errMsg.contains(sdkMessage))
    }

    // ---- which close entry point releases the global binding ----

    /*
     * A connection can end up closing through either of two doors, and they mean different things
     * to the global no-socketId APIs:
     *
     *   wx.closeSocket()     - the global door; once accepted, Dimina allows the route to hand over.
     *   SocketTask.close()   - the task's own door; it says nothing about the global route.
     *
     * Both produce the same transport-level closing handshake, so "is it closing?" cannot tell them
     * apart - the entry point has to be remembered. The concurrency slot is a third, independent
     * question: the wire is still open either way, so the slot is held either way.
     */

    @Test
    fun aTaskModeCloseDoesNotHandTheGlobalBindingToTheNextConnection() {
        manager.updateEmitter("app1") { events.add(it) }
        val connA = openConnections("app1", listOf("sA")).single()

        // SocketTask.close() - it carries the socketId of the task it belongs to.
        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "sA"); put("success", "close-ok") },
            responses::add,
        )
        val connB = openConnections("app1", listOf("sB")).single()

        manager.sendSocketMessage(
            "app1", false,
            JSONObject().apply { put("data", "hello"); put("success", "send-ok"); put("fail", "send-fail") },
            responses::add,
        )

        assertTrue(
            "closing one task must not move the global binding onto the next connection, but sB received ${connB.sentTexts}",
            connB.sentTexts.isEmpty(),
        )
        // The binding is still sA, and sA is mid-close, so the global send has nowhere to go.
        assertTrue("a closing connection cannot carry a send either", connA.sentTexts.isEmpty())
        assertEquals("sendSocketMessage:fail WebSocket is not connected", errMsgOf(responses, "send-fail"))
    }

    @Test
    fun aTaskModeCloseLeavesTheGlobalListenersAttachedToTheClosingConnection() {
        manager.updateEmitter("app1") { events.add(it) }
        val connA = openConnections("app1", listOf("sA")).single()
        onEvent("close", "app1", false, listenParams(null, "global-close"))

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "sA"); put("success", "close-ok") },
            responses::add,
        )
        openConnections("app1", listOf("sB"))

        // sA's close finally lands. sA is still the globally bound connection, so this is the one
        // event the global listener is entitled to.
        connA.callbacks.onClosed(1000, "")

        assertEquals(
            "sA is still the globally bound connection, so its close must reach the global listener",
            1,
            argsFor(events, "global-close").size,
        )
    }

    /**
     * The contrast in one place: identical timing on two owners, the close entry point the only
     * difference. Whichever way this pair breaks - a task close leaking the binding, or a global
     * close failing to release it - it breaks here.
     */
    @Test
    fun onlyAGlobalCloseReleasesTheBindingATaskCloseDoesNot() {
        for (viaGlobalClose in listOf(true, false)) {
            val appId = if (viaGlobalClose) "app-global" else "app-task"
            manager.updateEmitter(appId) { }
            openConnections(appId, listOf("sA"))

            val closeParams = JSONObject().put("success", "close-ok")
            if (!viaGlobalClose) closeParams.put("socketId", "sA")
            manager.closeSocket(appId, !viaGlobalClose, closeParams, responses::add)

            val connB = openConnections(appId, listOf("sB")).single()
            manager.sendSocketMessage(
                appId, false,
                JSONObject().apply { put("data", "hello"); put("success", "send-$appId"); put("fail", "fail-$appId") },
                responses::add,
            )

            if (viaGlobalClose) {
                assertEquals(
                    "wx.closeSocket() releases the binding, so the replacement takes it over",
                    listOf("hello"),
                    connB.sentTexts,
                )
            } else {
                assertTrue(
                    "SocketTask.close() says nothing about the global binding, but sB received ${connB.sentTexts}",
                    connB.sentTexts.isEmpty(),
                )
            }
        }
    }

    /**
     * The slot is about the wire, not about who asked for the close, so it is held until the close
     * event arrives no matter which door was used. (The task-mode half of this is covered by
     * `aConnectionWhoseCloseIsStillInFlightKeepsHoldingItsConcurrencySlot`.)
     */
    @Test
    fun aGloballyClosedConnectionAlsoKeepsItsSlotUntilTheCloseEventArrives() {
        manager.updateEmitter("app1") { }
        val conns = openConnections("app1", (0 until 5).map { "s$it" })

        manager.closeSocket("app1", false, JSONObject().put("success", "close-ok"), responses::add)

        manager.connectSocket("app1", "0", connectParams("s5", success = "early-ok", fail = "early-fail"), responses::add)
        val earlyFail = argsFor(responses, "early-fail")
        assertTrue(
            "every connection is still mid-close, so all five slots are still held - instead the " +
                "connect was accepted (${argsFor(responses, "early-ok")})",
            earlyFail.isNotEmpty(),
        )
        assertEquals(
            "connectSocket:fail fail reach max websocket connect count 5",
            earlyFail.single().getString("errMsg"),
        )

        conns.forEach { it.callbacks.onClosed(1000, "") }

        manager.connectSocket("app1", "0", connectParams("s6", success = "late-ok", fail = "late-fail"), responses::add)
        assertTrue(
            "once every close event has arrived the slots are free; got ${argsFor(responses, "late-fail")}",
            argsFor(responses, "late-fail").isEmpty(),
        )
        assertEquals("connectSocket:ok", errMsgOf(responses, "late-ok"))
    }

    // ---- transport failure message normalization ----

    /**
     * Which errMsg a failure gets is decided by the structured kind alone. The wording the platform
     * supplied must have no influence whatsoever - including when that wording happens to read like
     * a timeout. Feeding the *same* text under two different kinds, and the same kind under
     * different texts, is what keeps this honest: an implementation that went back to matching on
     * the message would make the two halves collapse into each other.
     */
    @Test
    fun theErrMsgIsChosenByTheStructuredKindAndNeverByTheTransportsWording() {
        val classifiedTimeout = connectFailureErrMsg("app-kind-timeout", "timeout", TransportFailureKind.TIMEOUT)
        assertEquals("connectSocket:fail timeout", classifiedTimeout)

        // Identical wording, no structured classification: this is NOT a timeout as far as the
        // caller is concerned, and must fall to the generic string.
        val unclassified = connectFailureErrMsg("app-kind-unknown", "timeout")
        assertEquals("connectSocket:fail WebSocket connection failed", unclassified)

        // A timeout classified as such keeps its errMsg no matter how the platform worded it -
        // including a localized wording that no English pattern would ever match.
        for ((i, wording) in listOf("Read timed out", "接続がタイムアウトしました", null).withIndex()) {
            assertEquals(
                "a TIMEOUT-classified failure worded \"$wording\" must still report the timeout errMsg",
                classifiedTimeout,
                connectFailureErrMsg("app-timeout-$i", wording, TransportFailureKind.TIMEOUT),
            )
        }

        // And an unclassified failure keeps the generic string no matter how it was worded.
        for ((i, wording) in listOf("timed out", "connect timed out", "Connection refused").withIndex()) {
            assertEquals(
                "an unclassified failure worded \"$wording\" must not be promoted to a timeout",
                unclassified,
                connectFailureErrMsg("app-unknown-$i", wording),
            )
        }
    }

    /**
     * The classifier reads the exception type and nothing else. The third case is the one that
     * matters: an ordinary IOException whose message says "timeout" must not be promoted, because
     * that message is platform text and may arrive in any language.
     */
    @Test
    fun theTransportClassifierReadsTheExceptionTypeAndNeverItsMessage() {
        assertEquals(
            TransportFailureKind.TIMEOUT,
            classifyTransportFailure(java.net.SocketTimeoutException("whatever the platform says")),
        )
        assertEquals(
            TransportFailureKind.TIMEOUT,
            classifyTransportFailure(java.io.InterruptedIOException("接続がタイムアウトしました")),
        )
        assertEquals(TransportFailureKind.UNKNOWN, classifyTransportFailure(java.io.IOException("timeout")))
        assertEquals(TransportFailureKind.UNKNOWN, classifyTransportFailure(java.io.IOException("Read timed out")))
        assertEquals(
            TransportFailureKind.UNKNOWN,
            classifyTransportFailure(java.net.ConnectException("Connection refused")),
        )
        assertEquals(TransportFailureKind.UNKNOWN, classifyTransportFailure(null))
    }

    /**
     * One condition, one errMsg. The container's own connect timer and a timeout reported by the
     * transport describe the same thing to the caller, so they must not force a mini program to
     * branch on two spellings.
     */
    @Test
    fun theContainerConnectTimerReportsTheSameTimeoutErrMsgAsTheTransport() {
        manager.updateEmitter("app-timer") { events.add(it) }
        manager.connectSocket("app-timer", "0", connectParams("s1"), responses::add)
        onEvent("error", "app-timer", true, listenParams("s1", "timer-err"))
        scheduler.runDue()

        scheduler.advanceBy(60_000)

        val fromTimer = errMsgOf(events, "timer-err")
        assertEquals("connectSocket:fail timeout", fromTimer)
        assertEquals(
            "the container's own connect timer and a transport-reported timeout describe the same " +
                "condition and must use the same errMsg",
            connectFailureErrMsg("app-transport", null, TransportFailureKind.TIMEOUT),
            fromTimer,
        )
    }

    /**
     * A connection that dropped without a close frame has no reason to quote: the 1006 close is
     * synthesized locally, so its `reason` is empty rather than a rendering of the local exception.
     * A server-sent close is the other case and keeps carrying whatever the server chose.
     */
    @Test
    fun theLocallySynthesizedCloseOfADroppedConnectionCarriesAnEmptyReason() {
        manager.updateEmitter("app1") { events.add(it) }
        val conn = openConnections("app1", listOf("s1")).single()
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))

        conn.callbacks.onFailure("Software caused connection abort")

        val closeArgs = argsFor(events, "close-cb").single()
        assertEquals(1006, closeArgs.getInt("code"))
        assertEquals("", closeArgs.getString("reason"))
    }

    // ---- close code range ----

    /**
     * The RFC 6455 close-code range check lives at the transport layer, not the API layer: OkHttp's
     * `WebSocket.close()` itself only accepts 1000 or 3000-4999 and throws on anything else, so the
     * manager screens the code before handing it over. This check must survive any realignment of
     * the script-layer close semantics.
     */
    @Test
    fun closeSocketAcceptsOnlyTheRfc6455CodesOkHttpItselfWillTransmit() {
        val cases = listOf(
            999 to "closeSocket:fail invalid code",
            1000 to "closeSocket:ok",
            1001 to "closeSocket:fail invalid code",
            1006 to "closeSocket:fail invalid code",
            2999 to "closeSocket:fail invalid code",
            3000 to "closeSocket:ok",
            4999 to "closeSocket:ok",
            5000 to "closeSocket:fail invalid code",
        )
        for ((code, expected) in cases) {
            // One owner per case so the per-owner open-connection limit is never in play.
            val appId = "app-$code"
            manager.updateEmitter(appId) { }
            openConnections(appId, listOf("s1"))

            val caseResponses = mutableListOf<String>()
            manager.closeSocket(
                appId, true,
                JSONObject().apply {
                    put("socketId", "s1")
                    put("code", code)
                    put("success", "case-ok")
                    put("fail", "case-fail")
                },
                caseResponses::add,
            )

            val callbackId = if (expected.endsWith(":ok")) "case-ok" else "case-fail"
            assertEquals("code=$code", expected, errMsgOf(caseResponses, callbackId))
        }
    }

    // ---- background ----

    @Test
    fun backgroundGraceExpiryOnOpenConnectionClosesWithCode1006Interrupted() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        manager.setBackgrounded("app1", true)
        scheduler.advanceBy(5000)

        val closeArgs = argsFor(events, "close-cb").single()
        assertEquals(1006, closeArgs.getInt("code"))
        assertEquals("interrupted", closeArgs.getString("reason"))
        assertTrue(argsFor(events, "error-cb").isEmpty())
    }

    @Test
    fun backgroundGraceExpiryOnHandshakingConnectionEmitsOnlyError() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        onEvent("error", "app1", true, listenParams("s1", "error-cb"))

        manager.setBackgrounded("app1", true)
        // Covers both the queued (delay=0) dial and the 5s grace timer; onOpen is never fired,
        // so the connection is still "handshaking" when grace expires.
        scheduler.advanceBy(5000)

        assertEquals("connectSocket:fail interrupted", argsFor(events, "error-cb").single().getString("errMsg"))
        assertTrue(argsFor(events, "close-cb").isEmpty())
    }

    @Test
    fun foregroundingBeforeGraceExpiryCancelsTheTimer() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        manager.setBackgrounded("app1", true)
        scheduler.advanceBy(2000)
        manager.setBackgrounded("app1", false)
        scheduler.advanceBy(4000) // would be past the original 5s mark if the timer had survived

        assertTrue(argsFor(events, "close-cb").isEmpty())
    }

    @Test
    fun backgroundedOwnerImmediatelyFailsAllThreeApis() {
        manager.updateEmitter("app1") { }
        manager.setBackgrounded("app1", true)

        manager.connectSocket("app1", "0", connectParams("s1", fail = "connect-fail"), responses::add)
        manager.sendSocketMessage(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("data", "x"); put("fail", "send-fail") },
            responses::add,
        )
        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("fail", "close-fail") },
            responses::add,
        )

        assertEquals("connectSocket:fail interrupted", errMsgOf(responses, "connect-fail"))
        assertEquals("sendSocketMessage:fail interrupted", errMsgOf(responses, "send-fail"))
        assertEquals("closeSocket:fail interrupted", errMsgOf(responses, "close-fail"))
    }

    // ---- legacy global slot + binding ----

    // New contract: the legacy (no-socketId) global slot is no longer a single last-writer-wins
    // slot - it is an ordered, de-duplicated set per event, just like task-mode's `listeners`.

    @Test
    fun legacyListenersAreOrderedAndAllReceiveTheEvent() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("open", "app1", false, listenParams(null, "cb1"))
        onEvent("open", "app1", false, listenParams(null, "cb2"))
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        assertEquals(1, argsFor(events, "cb1").size)
        assertEquals(1, argsFor(events, "cb2").size)
        val cb1Index = events.indexOfFirst { JSONObject(it).getJSONObject("body").getString("id") == "cb1" }
        val cb2Index = events.indexOfFirst { JSONObject(it).getJSONObject("body").getString("id") == "cb2" }
        assertTrue("cb1 must be dispatched before cb2 (registration order)", cb1Index < cb2Index)
    }

    @Test
    fun legacyListenerRegisteredTwiceReceivesTheEventOnlyOnce() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("open", "app1", false, listenParams(null, "cb1"))
        onEvent("open", "app1", false, listenParams(null, "cb1")) // duplicate registration, same id

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        assertEquals(1, argsFor(events, "cb1").size)
    }

    @Test
    fun legacyOffWithExplicitIdRemovesOnlyThatListenerLeavingTheOtherIntact() {
        // Off-ing the *second*-registered id (rather than the first) is the discriminating case:
        // a last-writer-wins slot would already have dropped the first id at registration time,
        // masking the bug this test exists to catch.
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("open", "app1", false, listenParams(null, "cb1"))
        onEvent("open", "app1", false, listenParams(null, "cb2"))

        offEvent("open", "app1", false, listenParams(null, "cb2"))

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        assertEquals(1, argsFor(events, "cb1").size)
        assertTrue(argsFor(events, "cb2").isEmpty())
    }

    @Test
    fun legacyOffWithEmptyCallbackIdClearsEveryListenerForThatEvent() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("open", "app1", false, listenParams(null, "cb1"))
        onEvent("open", "app1", false, listenParams(null, "cb2"))

        offEvent("open", "app1", false, listenParams(null, "")) // no callback id -> clear all

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        assertTrue(argsFor(events, "cb1").isEmpty())
        assertTrue(argsFor(events, "cb2").isEmpty())
    }

    @Test
    fun legacyOffOnOneEventDoesNotAffectListenersRegisteredOnAnotherEvent() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("open", "app1", false, listenParams(null, "open-cb"))
        onEvent("message", "app1", false, listenParams(null, "msg-cb"))

        offEvent("message", "app1", false, listenParams(null, "msg-cb"))

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        conn.callbacks.onMessageText("hello")

        assertEquals(1, argsFor(events, "open-cb").size)
        assertTrue(argsFor(events, "msg-cb").isEmpty())
    }

    @Test
    fun bindingStaysOnFirstConnectionAndOnlyRebindsAfterItDies() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("close", "app1", false, listenParams(null, "legacy-close"))

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add) // binds s1
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add) // s1 still alive -> stays bound to s1

        // Kill s1 (still CREATED, not yet dialed) so the binding becomes dead. s1 is still the bound
        // target *at the moment of its own close* (rebinding only happens on the next connectSocket
        // call), so this legitimately fires the legacy slot once.
        manager.closeSocket("app1", true, JSONObject().put("socketId", "s1"), responses::add)
        assertEquals(1, argsFor(events, "legacy-close").size)

        // Next connect rebinds (old binding is dead).
        manager.connectSocket("app1", "0", connectParams("s3"), responses::add)
        scheduler.runDue()

        // s1's queued dial task must have been a no-op (cancelled before it could run) - only s2 and
        // s3 actually reach the transport.
        assertEquals(2, transport.connections.size)
        val s3Conn = transport.connections.last()
        s3Conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        s3Conn.callbacks.onClosed(1000, "")

        // s3 is now bound, so its close fires the slot too: two total, one per (former/current) binding.
        assertEquals(2, argsFor(events, "legacy-close").size)
    }

    @Test
    fun legacyCloseWithDeadBindingFailsWithoutTouchingOtherTasks() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add)
        scheduler.runDue()
        val conns = transport.connections
        conns[0].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[1].callbacks.onOpen(emptyMap(), TransportProfileHints())

        // s1 (the bound one) fails -> binding is now dead, but still counts as "closed" bookkeeping-wise.
        conns[0].callbacks.onFailure("boom")

        manager.closeSocket("app1", false, JSONObject().apply { put("fail", "legacy-fail") }, responses::add)

        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail"))
        assertTrue(conns[1].closeCalls.isEmpty())
    }

    @Test
    fun legacyCloseWithAnInvalidCodeFailsThatCallOnlyAndLeavesTheBoundConnectionOpen() {
        // Invalid parameters fail this call without touching the bound connection or other tasks.
        val (a, b) = openConnections("app1", listOf("s1", "s2")) // s1 binds as the legacy target

        manager.closeSocket(
            "app1", false,
            JSONObject().apply { put("code", 500); put("fail", "legacy-fail") },
            responses::add,
        )

        assertEquals("closeSocket:fail invalid code", errMsgOf(responses, "legacy-fail"))
        assertTrue("bound connection s1 must not receive a close call", a.closeCalls.isEmpty())
        assertTrue("other SocketTask s2 must remain untouched", b.closeCalls.isEmpty())
    }

    @Test
    fun legacyCloseHittingAnAlreadyClosingBoundConnectionFailsWithoutSweeping() {
        // A repeated global close on an already-CLOSING target reports not connected and leaves
        // every other SocketTask untouched.
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add) // binds s1
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add)
        manager.connectSocket("app1", "0", connectParams("s3"), responses::add)
        scheduler.runDue()
        val conns = transport.connections
        conns[0].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[1].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[2].callbacks.onOpen(emptyMap(), TransportProfileHints())

        // First global close moves only the bound target (s1) to CLOSING.
        manager.closeSocket("app1", false, JSONObject().apply { put("fail", "legacy-fail-1") }, responses::add)
        assertTrue(conns[1].closeCalls.isEmpty())
        assertTrue(conns[2].closeCalls.isEmpty())

        // Second global close with a valid code fails not-connected.
        manager.closeSocket(
            "app1", false,
            JSONObject().apply { put("code", 1000); put("fail", "legacy-fail-2") },
            responses::add,
        )
        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail-2"))
        assertTrue(conns[1].closeCalls.isEmpty())
        assertTrue(conns[2].closeCalls.isEmpty())

        // Third global close, INVALID code this time: existence
        // check wins before code validation), not "invalid code".
        manager.closeSocket(
            "app1", false,
            JSONObject().apply { put("code", 5000); put("fail", "legacy-fail-3") },
            responses::add,
        )
        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail-3"))
    }

    @Test
    fun legacyCloseDoesNotTakeOverATaskModeClosingBinding() {
        // The global API does not close or reroute a target already closing through SocketTask.close().
        val a = openConnections("app1", listOf("s1")).single() // binds s1

        // Task-mode close leaves `a` CLOSING without marking it closed-by-global-door.
        manager.closeSocket("app1", true, JSONObject().put("socketId", "s1"), responses::add)

        // Global close reports not-connected against the CLOSING binding.
        manager.closeSocket("app1", false, JSONObject().apply { put("fail", "legacy-fail") }, responses::add)
        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail"))

        // A fresh task can connect, but the unspecified global route stays on the original target.
        val b = openConnections("app1", listOf("s2")).single()

        manager.sendSocketMessage(
            "app1", false,
            JSONObject().apply { put("data", "hi"); put("success", "send-ok"); put("fail", "send-fail") },
            responses::add,
        )

        val sendResult = (argsFor(responses, "send-ok") + argsFor(responses, "send-fail")).single()
        assertEquals("sendSocketMessage:fail WebSocket is not connected", sendResult.getString("errMsg"))
        assertTrue(b.sentTexts.isEmpty())
        assertTrue(a.sentTexts.isEmpty())
    }

    @Test
    fun legacySendOnlyReachesTheBoundConnection() {
        manager.updateEmitter("app1") { }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add) // binds s1
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add)
        scheduler.runDue()
        val conns = transport.connections
        conns[0].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[1].callbacks.onOpen(emptyMap(), TransportProfileHints())

        manager.sendSocketMessage(
            "app1", false,
            JSONObject().apply { put("data", "hello"); put("success", "send-ok") },
            responses::add,
        )

        assertEquals(listOf("hello"), conns[0].sentTexts)
        assertTrue(conns[1].sentTexts.isEmpty())
        assertEquals("sendSocketMessage:ok", errMsgOf(responses, "send-ok"))
    }

    // ---- disposal ----

    @Test
    fun disposeOwnerIsSilentAndResetsAccountingForAFreshOwner() {
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("close", "app1", false, listenParams(null, "legacy-close"))
        repeat(5) { i -> manager.connectSocket("app1", "0", connectParams("d$i"), responses::add) }
        scheduler.runDue()
        transport.connections.forEach { it.callbacks.onOpen(emptyMap(), TransportProfileHints()) }

        manager.disposeOwner("app1")

        assertTrue("disposeOwner must not emit any event", events.none { JSONObject(it).getJSONObject("body").optString("id") == "legacy-close" })

        val freshResponses = mutableListOf<String>()
        manager.updateEmitter("app1") { }
        manager.connectSocket("app1", "0", connectParams("fresh1", success = "fresh-ok", fail = "fresh-fail"), freshResponses::add)

        assertEquals("connectSocket:ok", errMsgOf(freshResponses, "fresh-ok"))
    }

    @Test
    fun disposeOwnerSilentlyDropsEveryLegacyListenerNotJustOne() {
        // Same as disposeOwnerIsSilentAndResetsAccountingForAFreshOwner, but with two ids
        // simultaneously registered on the same event - the ordered-set contract must not leak
        // any of them across a reset, not merely whichever one happened to occupy a single slot.
        manager.updateEmitter("app1") { events.add(it) }
        onEvent("close", "app1", false, listenParams(null, "legacy-close-1"))
        onEvent("close", "app1", false, listenParams(null, "legacy-close-2"))
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        manager.disposeOwner("app1")

        assertTrue(
            "disposeOwner must not emit any event",
            events.none {
                val id = JSONObject(it).getJSONObject("body").optString("id")
                id == "legacy-close-1" || id == "legacy-close-2"
            },
        )

        // A fresh owner must start with a genuinely empty legacy set: registering neither old id
        // again, only a brand-new one, and firing close must reach exactly that new id.
        val freshEvents = mutableListOf<String>()
        manager.updateEmitter("app1") { freshEvents.add(it) }
        onEvent("close", "app1", false, listenParams(null, "fresh-close"))
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add)
        scheduler.runDue()
        val freshConn = transport.connections.last()
        freshConn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        freshConn.callbacks.onClosed(1000, "")

        assertEquals(1, argsFor(freshEvents, "fresh-close").size)
        assertTrue(argsFor(freshEvents, "legacy-close-1").isEmpty())
        assertTrue(argsFor(freshEvents, "legacy-close-2").isEmpty())
    }

    // ---- idle timeout ----

    @Test
    fun idleTimeoutIsResetByTrafficAndFiresOnlyAfterTrueIdlePeriod() {
        manager.idleTimeoutMs = 10_000
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        scheduler.advanceBy(6000)
        conn.callbacks.onMessageText("ping") // resets the idle timer
        scheduler.advanceBy(6000) // 12s since open, but only 6s since last traffic -> must not fire yet
        assertTrue(argsFor(events, "close-cb").isEmpty())

        scheduler.advanceBy(4000) // now 10s since the last traffic -> fires
        val closeArgs = argsFor(events, "close-cb").single()
        assertEquals(1006, closeArgs.getInt("code"))
        assertEquals("idle timeout", closeArgs.getString("reason"))
    }

    @Test
    fun successfulOutboundSendAlsoResetsTheIdleTimer() {
        manager.idleTimeoutMs = 10_000
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        scheduler.advanceBy(6000)
        manager.sendSocketMessage(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("data", "ping"); put("success", "send-ok") },
            responses::add,
        ) // outbound traffic must reset the idle timer too, not just inbound messages
        scheduler.advanceBy(6000) // 12s since open, but only 6s since the send -> must not fire yet
        assertTrue(argsFor(events, "close-cb").isEmpty())

        scheduler.advanceBy(4000) // now 10s since the send -> fires
        assertEquals(1, argsFor(events, "close-cb").size)
    }

    @Test
    fun idleTimeoutQueuedBehindFreshTrafficOnTheSerialExecutorDoesNotCloseTheConnection() {
        // Cancelling the idle timer only stops the scheduler task itself; it cannot pull back a
        // callback the scheduler already handed to the serial executor's queue. This reproduces
        // that queue ordering directly: traffic resets the timer while the *old* timer's callback
        // is still sitting behind it in the queue, and the stale callback must find itself
        // superseded once it finally runs, not close a connection that is actively alive.
        val deferringExecutor = DeferringSerialExecutor()
        manager = WebSocketManager(transport, scheduler, clock, deferringExecutor)
        manager.idleTimeoutMs = 5000
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        onEvent("close", "app1", true, listenParams("s1", "close-cb"))

        deferringExecutor.deferring = true
        conn.callbacks.onMessageText("ping") // queued 1st: resets the idle timer once drained
        scheduler.advanceBy(5000) // old idle timer fires now, synchronously queuing its callback 2nd
        deferringExecutor.drain() // runs the reset first, then the stale timeout behind it

        assertTrue(
            "a connection that just received traffic must not be closed by the timer callback it raced",
            argsFor(events, "close-cb").isEmpty(),
        )
        deferringExecutor.deferring = false
        val sendResponses = mutableListOf<String>()
        manager.sendSocketMessage(
            "app1", true,
            JSONObject().apply { put("socketId", "s1"); put("data", "still open"); put("success", "send-ok") },
            sendResponses::add,
        )
        assertEquals("sendSocketMessage:ok", errMsgOf(sendResponses, "send-ok"))
    }

    // ---- on*/off* must answer a caller that attached its own success/fail ids ----

    @Test
    fun onSocketEventCompletesTheCallerSuccessSoFeStorePromiseDoesNotLeak() {
        // The current script layer sends on*/off* with `keep: true` and only a listener id, so it
        // never attaches temp settler ids and this exact wire shape does not come from it. Direct
        // bridge callers (and older script builds, which routed on*/off* through invokePromiseAPI)
        // do attach them and wait for one to fire; leaving them unanswered leaks two callback ids
        // and hangs the caller's Promise forever, so the handler must still answer.
        manager.updateEmitter("app1") { }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)

        val params = JSONObject().apply {
            put("socketId", "s1")
            put("callback", "listener-1")
            put("success", "wrap-success")
            put("fail", "wrap-fail")
        }
        manager.onSocketEvent("message", "app1", true, params, "onSocketMessage", responses::add)

        assertEquals("onSocketMessage:ok", errMsgOf(responses, "wrap-success"))
    }

    @Test
    fun offSocketEventCompletesTheCallerSuccessSoFeStorePromiseDoesNotLeak() {
        manager.updateEmitter("app1") { }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)

        val params = JSONObject().apply {
            put("socketId", "s1")
            put("callback", "listener-1")
            put("success", "wrap-success")
            put("fail", "wrap-fail")
        }
        manager.offSocketEvent("message", "app1", true, params, "offSocketMessage", responses::add)

        assertEquals("offSocketMessage:ok", errMsgOf(responses, "wrap-success"))
    }

    // ---- disposeOwner/disposeAll must actually block for the teardown ----

    @Test
    fun disposeOwnerBlocksTheCallerUntilTeardownActuallyRunsOnTheExecutor() {
        val slowExecutor = object : SerialExecutor {
            override fun execute(task: () -> Unit) {
                Thread {
                    Thread.sleep(200)
                    task()
                }.apply { isDaemon = true }.start()
            }
        }
        val slowManager = WebSocketManager(FakeSocketTransport(), FakeTaskScheduler(FakeClock()), FakeClock(), slowExecutor)

        val startNs = System.nanoTime()
        slowManager.disposeOwner("app1")
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000

        // MiniApp.clear() destroys JsCore immediately after this call returns, so disposeOwner must
        // not return before its own teardown task has actually executed on the serial executor.
        assertTrue("disposeOwner returned before its teardown task ran (elapsed=${elapsedMs}ms)", elapsedMs >= 150)
    }

    @Test
    fun disposeAllBlocksTheCallerUntilTeardownActuallyRunsOnTheExecutor() {
        val slowExecutor = object : SerialExecutor {
            override fun execute(task: () -> Unit) {
                Thread {
                    Thread.sleep(200)
                    task()
                }.apply { isDaemon = true }.start()
            }
        }
        val slowManager = WebSocketManager(FakeSocketTransport(), FakeTaskScheduler(FakeClock()), FakeClock(), slowExecutor)

        val startNs = System.nanoTime()
        slowManager.disposeAll()
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000

        assertTrue("disposeAll returned before its teardown task ran (elapsed=${elapsedMs}ms)", elapsedMs >= 150)
    }
}
