package com.didi.dimina.api.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Base64

/** File-scope SAM-constructor-style helper: [Cancellable] has no companion factory of its own. */
private fun Cancellable(onCancel: () -> Unit): Cancellable = object : Cancellable {
    override fun cancel() = onCancel()
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
        url: String = "ws://example.com/socket",
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
    fun dialWithNumericStringTimeoutParamCoercesToNumber() {
        // WebSocketValidation.validateTimeout coerces decimal-literal strings the way the fe-side
        // Number() coercion does - "3000" here mirrors the wider "any Number()-coercible string"
        // contract without relying on hex-literal parsing, which Kotlin's String.toDoubleOrNull
        // (unlike JS Number()) does not support.
        val params = connectParams("s1").put("timeout", "3000")
        manager.connectSocket("app1", "0", params, responses::add)
        scheduler.runDue()

        assertEquals(3000, transport.specs.single().connectTimeoutMs)
    }

    // ---- concurrency ----

    @Test
    fun sixthConnectOnSameOwnerFailsWithExactMessage() {
        manager.updateEmitter("app1") { events.add(it) }
        repeat(5) { i -> manager.connectSocket("app1", "0", connectParams("s$i"), responses::add) }

        manager.connectSocket("app1", "0", connectParams("s5", success = "s5-ok", fail = "s5-fail"), responses::add)

        assertEquals("connectSocket:fail reach max websocket connect count 5", errMsgOf(responses, "s5-fail"))
    }

    @Test
    fun differentOwnersDoNotShareConcurrencyLimit() {
        manager.updateEmitter("appA") { }
        manager.updateEmitter("appB") { }
        repeat(5) { i -> manager.connectSocket("appA", "0", connectParams("a$i"), responses::add) }

        manager.connectSocket("appB", "0", connectParams("b0", success = "b0-ok", fail = "b0-fail"), responses::add)

        assertEquals("connectSocket:ok", errMsgOf(responses, "b0-ok"))
    }

    @Test
    fun closingAConnectionFreesASlotForANewConnect() {
        manager.updateEmitter("app1") { }
        repeat(5) { i -> manager.connectSocket("app1", "0", connectParams("s$i"), responses::add) }

        manager.closeSocket(
            "app1", true,
            JSONObject().apply { put("socketId", "s0"); put("success", "close-ok") },
            responses::add,
        )
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

    @Test
    fun openEventCarriesHeaderAndAllProfileKeys() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        onEvent("open", "app1", true, listenParams("s1", "open-cb"))
        scheduler.runDue()

        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())

        val payload = argsFor(events, "open-cb").single()
        assertEquals("bar", payload.getJSONObject("header").getString("X-Foo"))
        val profile = payload.getJSONObject("profile")
        listOf(
            "fetchStart", "domainLookUpStart", "domainLookUpEnd",
            "connectStart", "connectEnd", "rtt", "handshakeCost", "cost",
        ).forEach { key -> assertTrue("missing profile key $key", profile.has(key)) }
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

        assertEquals("connectSocket:fail connection refused", argsFor(events, "error-cb").single().getString("errMsg"))
        assertTrue(argsFor(events, "close-cb").isEmpty())
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
    fun legacyCloseWithDeadBindingFailsAndStillSweepsOtherLiveConnections() {
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
        assertEquals(listOf(1000 to ""), conns[1].closeCalls)
    }

    @Test
    fun legacyCloseHittingAnAlreadyClosingBoundConnectionFailsNotConnectedAndStillSweeps() {
        // A repeated legacy close on a target that's already CLOSING must collapse to "not
        // connected", matching task-mode's existing behavior — not silently no-op-and-report-ok.
        // Must hold for both a valid and an invalid code/reason on the second call (existence/CLOSING
        // must be checked before code/reason validation), and the mandatory sweep of every other
        // live socket must still fire either way.
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add) // binds s1
        manager.connectSocket("app1", "0", connectParams("s2"), responses::add)
        manager.connectSocket("app1", "0", connectParams("s3"), responses::add)
        scheduler.runDue()
        val conns = transport.connections
        conns[0].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[1].callbacks.onOpen(emptyMap(), TransportProfileHints())
        conns[2].callbacks.onOpen(emptyMap(), TransportProfileHints())

        // First legacy close moves the bound target (s1) to CLOSING (fake transport never fires
        // the actual close callback, so it stays CLOSING for the rest of this test).
        manager.closeSocket("app1", false, JSONObject().apply { put("fail", "legacy-fail-1") }, responses::add)
        assertTrue(conns[1].closeCalls.isNotEmpty()) // s2 already swept by the first call

        // Second legacy close, valid code: must fail not-connected (not "ok"), and must still
        // attempt to sweep remaining live sockets (s3).
        manager.closeSocket(
            "app1", false,
            JSONObject().apply { put("code", 1000); put("fail", "legacy-fail-2") },
            responses::add,
        )
        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail-2"))
        assertTrue(conns[2].closeCalls.isNotEmpty()) // s3 swept by the second call too

        // Third legacy close, INVALID code this time: must still fail not-connected (existence
        // check wins before code validation), not "invalid code".
        manager.closeSocket(
            "app1", false,
            JSONObject().apply { put("code", 5000); put("fail", "legacy-fail-3") },
            responses::add,
        )
        assertEquals("closeSocket:fail WebSocket is not connected", errMsgOf(responses, "legacy-fail-3"))
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
