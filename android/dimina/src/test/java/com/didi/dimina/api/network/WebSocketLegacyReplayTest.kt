package com.didi.dimina.api.network

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** File-scope SAM-constructor-style helper: [Cancellable] has no companion factory of its own. */
private fun Cancellable(onCancel: () -> Unit): Cancellable = object : Cancellable {
    override fun cancel() = onCancel()
}

/** Exact key set of [json] - event payload contracts are "these fields and no others". */
private fun keysOf(json: JSONObject): Set<String> {
    val keys = mutableSetOf<String>()
    val iterator = json.keys()
    while (iterator.hasNext()) keys.add(iterator.next())
    return keys
}

/**
 * Covers the legacy (no-socketId) global listener replay contract: `wx.connectSocket()` dials
 * immediately, so a same-tick or few-millisecond-later open/error/close on a loopback or
 * immediately-rejected connection can beat the caller's `wx.onSocketXxx` registration message
 * across the bridge. A global listener that registers after such an event fired must still get
 * it, exactly once, sourced from the connection currently bound as the owner's legacy target.
 *
 * Task-mode (`hasSocketId = true`) already replays via its per-socket last-dispatched-event cache;
 * this file is the same guarantee for the legacy (`hasSocketId = false`) global slot.
 */
class WebSocketLegacyReplayTest {

    // ---- test doubles (see WebSocketManagerTest for the same setup, documented there) ----

    private class ImmediateSerialExecutor : SerialExecutor {
        override fun execute(task: () -> Unit) = task()
    }

    private class FakeClock : Clock {
        var currentMs: Long = 0L
        override fun nowMs(): Long = currentMs
    }

    private class FakeTaskScheduler(private val clock: FakeClock) : TaskScheduler {
        private class ScheduledTask(val dueAtMs: Long, val seq: Long, var cancelled: Boolean, val task: () -> Unit)

        private val pending = mutableListOf<ScheduledTask>()
        private var seqCounter = 0L

        override fun schedule(delayMs: Long, task: () -> Unit): Cancellable {
            val entry = ScheduledTask(clock.currentMs + delayMs, seqCounter++, false, task)
            pending.add(entry)
            return Cancellable { entry.cancelled = true }
        }

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
        val closeCalls = mutableListOf<Pair<Int, String>>()

        val handle = object : TransportHandle {
            override fun sendText(text: String): Boolean = true
            override fun sendBytes(bytes: ByteArray): Boolean = true
            override fun close(code: Int, reason: String) {
                closeCalls.add(code to reason)
            }
            override fun cancel() {}
        }
    }

    private class FakeSocketTransport : SocketTransport {
        val connections = mutableListOf<FakeConnection>()

        override fun connect(spec: TransportConnectSpec, callbacks: TransportCallbacks): TransportHandle {
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

    // ---- helpers (mirrors WebSocketManagerTest) ----

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

    private fun onEvent(event: String, appId: String, hasSocketId: Boolean, params: JSONObject) {
        manager.onSocketEvent(event, appId, hasSocketId, params, "onSocket${event.replaceFirstChar(Char::uppercaseChar)}", responses::add)
    }

    private fun offEvent(event: String, appId: String, hasSocketId: Boolean, params: JSONObject) {
        manager.offSocketEvent(event, appId, hasSocketId, params, "offSocket${event.replaceFirstChar(Char::uppercaseChar)}", responses::add)
    }

    private fun argsFor(messages: List<String>, callbackId: String): List<JSONObject> =
        messages.map { JSONObject(it) }
            .filter { it.getJSONObject("body").getString("id") == callbackId }
            .mapNotNull { it.getJSONObject("body").optJSONObject("args") }

    private fun errMsgOf(messages: List<String>, callbackId: String): String =
        argsFor(messages, callbackId).single().getString("errMsg")

    // ---- replay on late global registration ----

    @Test
    fun openEventReplaysToAGlobalListenerThatRegistersAfterTheOpenAlreadyFired() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add) // binds the legacy target to s1
        scheduler.runDue()

        // Open fires before any global listener exists - with no fix, this event is lost forever.
        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())
        assertTrue(argsFor(events, "late-open-cb").isEmpty())

        onEvent("open", "app1", false, listenParams(null, "late-open-cb"))

        val payload = argsFor(events, "late-open-cb").single()
        assertEquals("bar", payload.getJSONObject("header").getString("X-Foo"))
    }

    @Test
    fun errorEventReplaysToAGlobalListenerThatRegistersAfterTheErrorAlreadyFired() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        transport.connections.single().callbacks.onFailure("boom")
        assertTrue(argsFor(events, "late-err-cb").isEmpty())

        onEvent("error", "app1", false, listenParams(null, "late-err-cb"))

        // The invariant is that the missed event is replayed, exactly once. Its identity is carried
        // by the delivery itself, not by any text: errMsg is one of the container's fixed strings
        // and says nothing about which failure produced it.
        val replayed = argsFor(events, "late-err-cb")
        assertEquals("the missed error must be replayed exactly once", 1, replayed.size)
        assertEquals(setOf("errMsg"), keysOf(replayed.single()))
    }

    @Test
    fun closeEventReplaysToAGlobalListenerThatRegistersAfterTheCloseAlreadyFired() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        transport.connections.single().callbacks.onClosed(4001, "server bye")
        assertTrue(argsFor(events, "late-close-cb").isEmpty())

        onEvent("close", "app1", false, listenParams(null, "late-close-cb"))

        val payload = argsFor(events, "late-close-cb").single()
        assertEquals(4001, payload.getInt("code"))
        assertEquals("server bye", payload.getString("reason"))
    }

    @Test
    fun messageEventIsNeverReplayedEvenWhenOneAlreadyFiredOnTheBoundConnection() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        conn.callbacks.onMessageText("stale hello")

        onEvent("message", "app1", false, listenParams(null, "late-msg-cb"))

        // No replay of the message that already happened...
        assertTrue(argsFor(events, "late-msg-cb").isEmpty())

        // ...but the listener is genuinely subscribed now, so the next message reaches it normally.
        conn.callbacks.onMessageText("fresh hello")
        val payload = argsFor(events, "late-msg-cb").single()
        assertEquals("fresh hello", payload.getString("data"))
    }

    @Test
    fun noLegacyBindingMeansNothingIsReplayedToAFreshGlobalListener() {
        manager.updateEmitter("app1") { events.add(it) }
        // No connectSocket call at all - there is no legacy-bound target and nothing was ever dispatched.

        onEvent("open", "app1", false, listenParams(null, "open-cb"))
        onEvent("error", "app1", false, listenParams(null, "error-cb"))
        onEvent("close", "app1", false, listenParams(null, "close-cb"))

        assertTrue(argsFor(events, "open-cb").isEmpty())
        assertTrue(argsFor(events, "error-cb").isEmpty())
        assertTrue(argsFor(events, "close-cb").isEmpty())
    }

    @Test
    fun replayOnANewRegistrationIsNotAlsoResentToAListenerThatAlreadyGotItsOwnReplay() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        onEvent("open", "app1", false, listenParams(null, "cb1"))
        assertEquals(1, argsFor(events, "cb1").size)

        // Registering a second, later listener must replay only to that new listener id - it must
        // not cause a second copy to land on cb1, which already consumed its own replay.
        onEvent("open", "app1", false, listenParams(null, "cb2"))
        assertEquals(1, argsFor(events, "cb2").size)
        assertEquals(1, argsFor(events, "cb1").size)
    }

    @Test
    fun aReplayedOpenListenerStillReceivesTheSubsequentRealCloseNormally() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())

        // Registers late enough to get the open replay...
        onEvent("open", "app1", false, listenParams(null, "cb-open"))
        assertEquals(1, argsFor(events, "cb-open").size)
        // ...and registers before any close happened, so this is a normal subscription, not a replay.
        onEvent("close", "app1", false, listenParams(null, "cb-close"))
        assertTrue(argsFor(events, "cb-close").isEmpty())

        conn.callbacks.onClosed(1000, "")

        val closePayload = argsFor(events, "cb-close").single()
        assertEquals(1000, closePayload.getInt("code"))
        // Replay must not have interfered with, or duplicated, the listener's normal subscription.
        assertEquals(1, argsFor(events, "cb-open").size)
    }

    // ---- replay must be deduped together with listener registration ----
    //
    // The listener set already dedupes by callback id: registering the same id twice must leave
    // the set holding exactly one entry. Replay-on-late-registration has to ride that same
    // dedup, not fire independently of it - re-registering an id that already received its
    // replay adds nothing new to the set, so it must not send a second copy of the event. This
    // holds for both task mode (registration carries a socketId) and global mode (it does not).

    @Test
    fun openReplayIsNotResentWhenTheSameTaskCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())

        onEvent("open", "app1", true, listenParams("s1", "dup-open-cb"))
        assertEquals(1, argsFor(events, "dup-open-cb").size)

        onEvent("open", "app1", true, listenParams("s1", "dup-open-cb"))
        assertEquals(1, argsFor(events, "dup-open-cb").size)
    }

    @Test
    fun errorReplayIsNotResentWhenTheSameTaskCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onFailure("boom")

        onEvent("error", "app1", true, listenParams("s1", "dup-err-cb"))
        assertEquals(1, argsFor(events, "dup-err-cb").size)

        onEvent("error", "app1", true, listenParams("s1", "dup-err-cb"))
        assertEquals(1, argsFor(events, "dup-err-cb").size)
    }

    @Test
    fun closeReplayIsNotResentWhenTheSameTaskCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        conn.callbacks.onClosed(4001, "server bye")

        onEvent("close", "app1", true, listenParams("s1", "dup-close-cb"))
        assertEquals(1, argsFor(events, "dup-close-cb").size)

        onEvent("close", "app1", true, listenParams("s1", "dup-close-cb"))
        assertEquals(1, argsFor(events, "dup-close-cb").size)
    }

    @Test
    fun openReplayIsNotResentWhenTheSameGlobalCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(mapOf("X-Foo" to "bar"), TransportProfileHints())

        onEvent("open", "app1", false, listenParams(null, "dup-global-open-cb"))
        assertEquals(1, argsFor(events, "dup-global-open-cb").size)

        onEvent("open", "app1", false, listenParams(null, "dup-global-open-cb"))
        assertEquals(1, argsFor(events, "dup-global-open-cb").size)
    }

    @Test
    fun errorReplayIsNotResentWhenTheSameGlobalCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onFailure("boom")

        onEvent("error", "app1", false, listenParams(null, "dup-global-err-cb"))
        assertEquals(1, argsFor(events, "dup-global-err-cb").size)

        onEvent("error", "app1", false, listenParams(null, "dup-global-err-cb"))
        assertEquals(1, argsFor(events, "dup-global-err-cb").size)
    }

    @Test
    fun closeReplayIsNotResentWhenTheSameGlobalCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val conn = transport.connections.single()
        conn.callbacks.onOpen(emptyMap(), TransportProfileHints())
        conn.callbacks.onClosed(4001, "server bye")

        onEvent("close", "app1", false, listenParams(null, "dup-global-close-cb"))
        assertEquals(1, argsFor(events, "dup-global-close-cb").size)

        onEvent("close", "app1", false, listenParams(null, "dup-global-close-cb"))
        assertEquals(1, argsFor(events, "dup-global-close-cb").size)
    }

    @Test
    fun normalOpenDeliveryPreventsAStaleReplayWhenTheSameCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        val params = listenParams("s1", "normal-open-cb")
        onEvent("open", "app1", true, params)
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())
        assertEquals(1, argsFor(events, "normal-open-cb").size)

        // The first copy was a normal dispatch, not a replay. Re-registering the same bridge id
        // must still be deduped against it instead of replaying the cached open payload.
        onEvent("open", "app1", true, params)
        assertEquals(1, argsFor(events, "normal-open-cb").size)
    }

    @Test
    fun normalTerminalDeliveryPreventsAStaleReplayWhenTheSameCallbackIdRegistersAgain() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()

        val params = listenParams(null, "normal-close-cb")
        onEvent("close", "app1", false, params)
        val connection = transport.connections.single()
        connection.callbacks.onOpen(emptyMap(), TransportProfileHints())
        connection.callbacks.onClosed(1000, "")
        assertEquals(1, argsFor(events, "normal-close-cb").size)

        onEvent("close", "app1", false, params)
        assertEquals(1, argsFor(events, "normal-close-cb").size)
    }

    @Test
    fun reusedSocketIdDoesNotReplayThePreviousConnectionsTerminalEvents() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val oldConnection = transport.connections.single()
        oldConnection.callbacks.onOpen(emptyMap(), TransportProfileHints())
        oldConnection.callbacks.onFailure("old generation")

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val newConnection = transport.connections[1]

        onEvent("error", "app1", true, listenParams("s1", "new-task-error"))
        onEvent("close", "app1", false, listenParams(null, "new-global-close"))
        assertTrue(argsFor(events, "new-task-error").isEmpty())
        assertTrue(argsFor(events, "new-global-close").isEmpty())

        newConnection.callbacks.onOpen(emptyMap(), TransportProfileHints())
        newConnection.callbacks.onFailure("new generation")

        // Which generation an event belongs to is established by *when* it arrives, not by any text
        // it carries: the two assertions above proved nothing was delivered while only the old
        // generation had ended, so a delivery appearing now can only be the new one. Counting each
        // listener's deliveries is what keeps a replayed old event from passing unnoticed.
        assertEquals("the new generation's error reaches the task listener once", 1, argsFor(events, "new-task-error").size)
        val closeArgs = argsFor(events, "new-global-close")
        assertEquals("the new generation's close reaches the global listener once", 1, closeArgs.size)
        // 1006 is the locally synthesized close of a connection that dropped without a close frame.
        assertEquals(1006, closeArgs.single().getInt("code"))
    }

    @Test
    fun lateCallbacksFromAnOldTransportCannotMutateAReusedSocketIdEntry() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val oldConnection = transport.connections.single()
        oldConnection.callbacks.onOpen(emptyMap(), TransportProfileHints())
        oldConnection.callbacks.onClosed(1000, "old closed")

        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        val newConnection = transport.connections[1]
        onEvent("open", "app1", true, listenParams("s1", "new-open"))
        onEvent("message", "app1", true, listenParams("s1", "new-message"))
        onEvent("error", "app1", true, listenParams("s1", "new-error"))
        onEvent("close", "app1", true, listenParams("s1", "new-close"))

        // OkHttp can still deliver callbacks already queued by the old transport. All of them carry
        // the same socketId but a different SocketEntry generation and must be ignored.
        oldConnection.callbacks.onOpen(mapOf("X-Old" to "1"), TransportProfileHints())
        oldConnection.callbacks.onMessageText("stale")
        oldConnection.callbacks.onFailure("stale failure")
        oldConnection.callbacks.onClosed(4001, "stale close")
        assertTrue(argsFor(events, "new-open").isEmpty())
        assertTrue(argsFor(events, "new-message").isEmpty())
        assertTrue(argsFor(events, "new-error").isEmpty())
        assertTrue(argsFor(events, "new-close").isEmpty())

        // The replacement entry is still present and fully functional.
        newConnection.callbacks.onOpen(emptyMap(), TransportProfileHints())
        newConnection.callbacks.onMessageText("fresh")
        assertEquals(1, argsFor(events, "new-open").size)
        assertEquals("fresh", argsFor(events, "new-message").single().getString("data"))
    }

    @Test
    fun taskTerminalReplayCanBeDeliveredAgainAfterOffWithTheSameCallbackId() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onFailure("boom")

        val params = listenParams("s1", "task-error-lifecycle")
        onEvent("error", "app1", true, params)
        assertEquals(1, argsFor(events, "task-error-lifecycle").size)

        offEvent("error", "app1", true, params)
        onEvent("error", "app1", true, params)
        assertEquals(2, argsFor(events, "task-error-lifecycle").size)
    }

    @Test
    fun globalOpenReplayCanBeDeliveredAgainAfterOffWithTheSameCallbackId() {
        manager.updateEmitter("app1") { events.add(it) }
        manager.connectSocket("app1", "0", connectParams("s1"), responses::add)
        scheduler.runDue()
        transport.connections.single().callbacks.onOpen(emptyMap(), TransportProfileHints())

        val params = listenParams(null, "global-open-lifecycle")
        onEvent("open", "app1", false, params)
        assertEquals(1, argsFor(events, "global-open-lifecycle").size)

        offEvent("open", "app1", false, params)
        onEvent("open", "app1", false, params)
        assertEquals(2, argsFor(events, "global-open-lifecycle").size)
    }
}
