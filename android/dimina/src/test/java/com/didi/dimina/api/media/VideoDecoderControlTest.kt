package com.didi.dimina.api.media

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class VideoDecoderControlTest {
    @Test fun removalBetweenCheckAndPostRejectsThePendingControl() {
        val removed = AtomicBoolean(false)
        val posting = CountDownLatch(1)
        val closed = CountDownLatch(1)
        val outcomes = mutableListOf<Result<Int>>()
        var ran = false
        val sourceThread = Thread {
            postVideoDecoderControl(removed::get, {
                posting.countDown()
                check(closed.await(2, TimeUnit.SECONDS))
                false // Handler.post after remove() quits the looper.
            }, outcomes::add) { ran = true; 42 }
        }
        sourceThread.start()
        try {
            assertTrue(posting.await(2, TimeUnit.SECONDS))
            removed.set(true)
        } finally { closed.countDown() }
        sourceThread.join(2_000)
        assertFalse(sourceThread.isAlive)
        assertFalse(ran)
        assertEquals(1, outcomes.size)
        assertTrue(outcomes.single().isFailure)
        assertTrue(outcomes.single().exceptionOrNull()!!.message!!.contains("removed"))
    }

    @Test fun acceptedControlChecksRemovalBeforeExecuting() {
        var removed = false
        lateinit var queued: Runnable
        var result: Result<Int>? = null
        var ran = false
        postVideoDecoderControl({ removed }, { queued = it; true }, { result = it }) { ran = true; 42 }
        removed = true
        queued.run()
        assertFalse(ran)
        assertTrue(result!!.isFailure)
    }

    @Test fun removedControlNeverPostsAndLiveControlsSettleSuccessOrFailure() {
        var posts = 0
        val outcomes = mutableListOf<Result<Int>>()
        val post: (Runnable) -> Boolean = { posts++; it.run(); true }
        postVideoDecoderControl({ true }, post, outcomes::add) { 42 }
        assertEquals(0, posts)
        postVideoDecoderControl({ false }, post, outcomes::add) { 42 }
        postVideoDecoderControl({ false }, post, outcomes::add) { error("bad media") }
        assertEquals(2, posts)
        assertEquals(3, outcomes.size)
        assertTrue(outcomes[0].isFailure)
        assertEquals(42, outcomes[1].getOrThrow())
        assertEquals("bad media", outcomes[2].exceptionOrNull()!!.message)
    }

    @Test fun stopInvalidatesAnIOStartWithoutInvalidatingLaterStarts() {
        val gate = VideoDecoderStartGate()
        val resolving = CountDownLatch(1)
        val resolved = CountDownLatch(1)
        val generation = gate.capture()
        var result: Result<Unit>? = null
        var activated = false
        val sourceThread = Thread {
            resolving.countDown()
            check(resolved.await(2, TimeUnit.SECONDS))
            result = runCatching { gate.checkCurrent(generation); activated = true }
        }
        sourceThread.start()
        try {
            assertTrue(resolving.await(2, TimeUnit.SECONDS))
            gate.cancel()
        } finally { resolved.countDown() }
        sourceThread.join(2_000)
        assertFalse(sourceThread.isAlive)
        assertFalse(activated)
        assertTrue(result!!.isFailure)
        gate.checkCurrent(gate.capture()) // A new start after stop is allowed.
    }

    @Test fun stopDuringCodecConfigurationRejectsItsLateStartReply() {
        val gate = VideoDecoderStartGate()
        val generation = gate.capture()
        gate.checkCurrent(generation)
        gate.cancel()
        val result = runCatching { gate.checkCurrent(generation) }
        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()!!.message!!.contains("cancelled"))
    }
}
