package com.didi.dimina.api.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.json.JSONObject
import java.io.File
import java.util.Base64
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull

class ImageApiCanvasValidationTest {
    private val api = ImageApi()

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun rejectsTraversalAndSeparatorsInCanvasAppId() {
        assertFalse(api.isValidCanvasAppId("../other-app"))
        assertFalse(api.isValidCanvasAppId("foo/bar"))
        assertFalse(api.isValidCanvasAppId("foo\\bar"))
        assertFalse(api.isValidCanvasAppId(".."))
        assertTrue(api.isValidCanvasAppId("wx92269e3b2f304afc"))
    }

    @Test
    fun canvasImageSignatureMustMatchFileType() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
        val fake = byteArrayOf(0, 0, 0)

        assertTrue(api.matchesImageType(png, "png"))
        assertFalse(api.matchesImageType(png, "jpg"))
        assertTrue(api.matchesImageType(jpeg, "jpg"))
        assertFalse(api.matchesImageType(jpeg, "png"))
        assertFalse(api.matchesImageType(fake, "png"))
    }

    @Test
    fun canvasTempFileResultsCarryTheSameErrMsgIntoComplete() {
        val success = canvasTempFileSuccess("difile://tmp/canvas.png")
        val failure = canvasTempFileFailure("write failed")

        assertTrue(success.completeCarriesResult)
        assertEquals("canvasToTempFilePath:ok", success.value.getString("errMsg"))
        assertEquals("difile://tmp/canvas.png", success.value.getString("tempFilePath"))
        assertTrue(failure.completeCarriesResult)
        assertEquals("canvasToTempFilePath:fail write failed", failure.value.getString("errMsg"))
    }


    @Test
    fun writesDecodedCanvasBytesAndLeavesNoStagingFileBehind() {
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        val root = tempFolder.newFolder("tmp")

        val result = api.writeCanvasTempFile(root, Base64.getEncoder().encodeToString(png), "png")

        assertEquals("canvasToTempFilePath:ok", result.getString("errMsg"))
        val written = root.listFiles().orEmpty()
        assertEquals(1, written.size)
        assertTrue(written[0].name.endsWith(".png"))
        assertTrue(png.contentEquals(written[0].readBytes()))
    }

    @Test
    fun rejectsPayloadWhoseSignatureDoesNotMatchTheRequestedTypeWithoutWriting() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
        val root = tempFolder.newFolder("tmp")

        val result = api.writeCanvasTempFile(root, Base64.getEncoder().encodeToString(jpeg), "png")

        assertEquals("canvasToTempFilePath:fail invalid image data", result.getString("errMsg"))
        assertEquals(0, root.listFiles().orEmpty().size)
    }

    // 写盘挪到后台后，success/fail/complete 由 canvas 自己派发，不再走 MiniApp.invokeAPI。
    // 该契约是：errMsg 决定走 success 还是 fail，complete 总是发且拿到同一个 result。
    @Test
    fun okResultGoesToSuccessThenCompleteWithTheSameResult() {
        val params = callbackParams()
        val result = canvasTempFileSuccess("dm:///tmp/canvas_x.png").value
        val calls = mutableListOf<Pair<String, String?>>()

        dispatchCanvasResult(params, result) { calls += parseCallback(it) }

        assertEquals(listOf("success-id", "complete-id"), calls.map { it.first })
        assertTrue(calls.all { it.second == "canvasToTempFilePath:ok" })
    }

    @Test
    fun failResultGoesToFailThenCompleteWithTheSameResult() {
        val params = callbackParams()
        val result = canvasTempFileFailure("write failed").value
        val calls = mutableListOf<Pair<String, String?>>()

        dispatchCanvasResult(params, result) { calls += parseCallback(it) }

        assertEquals(listOf("fail-id", "complete-id"), calls.map { it.first })
        assertTrue(calls.all { it.second == "canvasToTempFilePath:fail write failed" })
    }

    // 小程序在 complete 里读 res.errMsg，所以 success 派发抛错也不能把 complete 一起吞掉。
    @Test
    fun completeStillFiresWhenTheSuccessCallbackThrows() {
        val params = callbackParams()
        val result = canvasTempFileSuccess("dm:///tmp/canvas_x.png").value
        val calls = mutableListOf<String>()

        val thrown = runCatching {
            dispatchCanvasResult(params, result) { payload ->
                val id = parseCallback(payload).first
                calls += id
                if (id == "success-id") throw IllegalStateException("bridge is gone")
            }
        }

        assertEquals(listOf("success-id", "complete-id"), calls)
        assertTrue(thrown.isFailure)
    }

    // 单次上限只约束一次请求，导出改成后台执行之后并发几次就能把峰值叠起来；串行是那个上限之所以
    // 还成立的前提。
    @Test
    fun serializesConcurrentCanvasExportsOfOneApp() = runBlocking {
        val appId = "app-serial-${System.nanoTime()}"
        val active = AtomicInteger(0)
        val peak = AtomicInteger(0)
        val reservations = (1..MAX_IN_FLIGHT_CANVAS_EXPORTS).map {
            requireNotNull(CanvasExportQueue.reserve(appId, 4, "pay$it"))
        }

        reservations.map { reservation ->
            launch(Dispatchers.Default) {
                CanvasExportQueue.run(reservation) {
                    val now = active.incrementAndGet()
                    peak.updateAndGet { seen -> maxOf(seen, now) }
                    delay(5)
                    active.decrementAndGet()
                }
            }
        }.joinAll()
        reservations.forEach { CanvasExportQueue.finish(it) }

        assertEquals(1, peak.get())
    }

    @Test
    fun oneAppsExportDoesNotBlockAnother() = runBlocking {
        val parkedApp = "app-parked-${System.nanoTime()}"
        val otherApp = "app-other-${System.nanoTime()}"
        val parked = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        val held = requireNotNull(CanvasExportQueue.reserve(parkedApp, 4, "held"))
        val holder = launch(Dispatchers.Default) {
            CanvasExportQueue.run(held) {
                entered.complete(Unit)
                parked.await()
            }
        }
        entered.await()

        val other = requireNotNull(CanvasExportQueue.reserve(otherApp, 4, "other"))
        withTimeout(2_000) {
            CanvasExportQueue.run(other) { }
        }
        CanvasExportQueue.finish(other)

        parked.complete(Unit)
        holder.join()
        CanvasExportQueue.finish(held)
    }

    // 销毁只取消还没开始的任务，已经进入临界区的旧任务会继续解码和写盘。锁一旦按代次分片，新
    // runtime 的任务就会拿到另一把锁立刻开始，两份最多 32 MB 的位图同时留在内存里。
    @Test
    fun holdsANewGenerationExportUntilTheRunningOneReleases() = runBlocking {
        val appId = "app-restart-${System.nanoTime()}"
        val entered = CompletableDeferred<Unit>()
        val parked = CompletableDeferred<Unit>()
        val running = requireNotNull(CanvasExportQueue.reserve(appId, 4, "old"))
        val holder = launch(Dispatchers.Default) {
            CanvasExportQueue.run(running) {
                entered.complete(Unit)
                parked.await()
            }
        }
        entered.await()

        CanvasExportQueue.invalidate(appId)
        val restarted = requireNotNull(CanvasExportQueue.reserve(appId, 4, "new"))
        val attempting = CompletableDeferred<Unit>()
        val newStarted = CompletableDeferred<Unit>()
        val newcomer = launch(Dispatchers.Default) {
            attempting.complete(Unit)
            CanvasExportQueue.run(restarted) { newStarted.complete(Unit) }
        }
        attempting.await()

        assertNull(withTimeoutOrNull(200) { newStarted.await() })

        parked.complete(Unit)
        holder.join()
        withTimeout(2_000) { newStarted.await() }
        newcomer.join()
        CanvasExportQueue.finish(running)
        CanvasExportQueue.finish(restarted)
    }

    // 一次失败不能把后面排队的导出一起堵死。
    @Test
    fun aThrowingExportReleasesTheQueue() = runBlocking {
        val appId = "app-failing-${System.nanoTime()}"
        val failing = requireNotNull(CanvasExportQueue.reserve(appId, 4, "boom"))
        runCatching {
            CanvasExportQueue.run(failing) { throw IllegalStateException("boom") }
        }
        CanvasExportQueue.finish(failing)

        val next = requireNotNull(CanvasExportQueue.reserve(appId, 4, "next"))
        val ran = withTimeout(2_000) {
            CanvasExportQueue.run(next) { true }
        }
        CanvasExportQueue.finish(next)

        assertEquals(true, ran)
    }

    // 排队中的每个请求各自持有一份 base64 副本，单次上限只约束其中一份。连续入队时占用是累加的，
    // 所以预算必须在把字符串交给后台之前判：拒绝之后那份副本才可回收。
    @Test
    fun rejectsExportsThatWouldExceedThePendingBudget() {
        val appId = "app-budget-${System.nanoTime()}"
        val half = (MAX_PENDING_CANVAS_BASE64_CHARS / 2).toInt()

        val first = requireNotNull(CanvasExportQueue.reserve(appId, half, "first"))
        val second = requireNotNull(CanvasExportQueue.reserve(appId, half, "second"))
        assertNull(CanvasExportQueue.reserve(appId, half, "third"))

        CanvasExportQueue.finish(first)
        val third = requireNotNull(CanvasExportQueue.reserve(appId, half, "third"))
        CanvasExportQueue.finish(second)
        CanvasExportQueue.finish(third)
    }

    @Test
    fun rejectsTheThirdPendingExportEvenWhenPayloadsAreTiny() {
        val appId = "app-count-${System.nanoTime()}"
        val first = CanvasExportQueue.reserve(appId, 12, "first")
        val second = CanvasExportQueue.reserve(appId, 12, "second")
        val third = CanvasExportQueue.reserve(appId, 12, "third")

        try {
            assertTrue(first != null)
            assertTrue(second != null)
            assertNull(third)
        } finally {
            first?.let { CanvasExportQueue.finish(it) }
            second?.let { CanvasExportQueue.finish(it) }
            third?.let { CanvasExportQueue.finish(it) }
        }
    }

    @Test
    fun invalidationReleasesReservationsThatHaveNotStarted() {
        val appId = "app-reset-${System.nanoTime()}"
        val half = (MAX_PENDING_CANVAS_BASE64_CHARS / 2).toInt()

        assertTrue(CanvasExportQueue.reserve(appId, half, "old1") != null)
        assertTrue(CanvasExportQueue.reserve(appId, half, "old2") != null)
        CanvasExportGeneration.invalidate(appId)

        val first = requireNotNull(CanvasExportQueue.reserve(appId, half, "new1"))
        val second = requireNotNull(CanvasExportQueue.reserve(appId, half, "new2"))
        CanvasExportQueue.finish(first)
        CanvasExportQueue.finish(second)
    }

    // 请求进入容器时属于哪一代必须当场记下。调用线程与推进代次的主线程是并发的，等校验完
    // 最长 44 MB 的 base64 再去读，退出途中到达的请求会被记成新一代，写出的文件既不交付也不删。
    @Test
    fun rejectsAnExportWhoseRuntimeIsGoneBeforeItIsQueued() {
        val appId = "app-stale-gen-${System.nanoTime()}"
        val generation = CanvasExportGeneration.current(appId)

        CanvasExportGeneration.invalidate(appId)

        assertNull(CanvasExportQueue.reserve(appId, 8, "payload--", generation))
        assertEquals(0L, CanvasExportQueue.pendingChars(appId))
        val current = requireNotNull(
            CanvasExportQueue.reserve(appId, 8, "payload--", CanvasExportGeneration.current(appId)),
        )
        CanvasExportQueue.finish(current)
    }

    @Test
    fun invalidationCancelsOnlyQueuedJobsAndLetsTheNewRuntimeUseTheRemainingSlot() = runBlocking {
        val appId = "app-running-reset-${System.nanoTime()}"
        val running = requireNotNull(CanvasExportQueue.reserve(appId, 4, "old1"))
        val queued = requireNotNull(CanvasExportQueue.reserve(appId, 4, "old2"))
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val runningTask = launch(Dispatchers.Default) {
            CanvasExportQueue.run(running) {
                entered.complete(Unit)
                release.await()
            }
        }
        entered.await()

        CanvasExportGeneration.invalidate(appId)

        assertTrue(queued.cancelled)
        assertEquals(null, queued.payload)
        val current = CanvasExportQueue.reserve(appId, 4, "new1")
        assertTrue(current != null)
        assertEquals(null, CanvasExportQueue.reserve(appId, 4, "new2"))

        release.complete(Unit)
        runningTask.join()
        CanvasExportQueue.finish(running)
        assertTrue(CanvasExportQueue.reserve(appId, 4, "new2") != null)
    }

    // 锁的身份就是串行本身：同一个小程序拿到的必须始终是同一把，上一轮结束和 runtime 换代都不能换。
    @Test
    fun handsOutTheSameLockToEveryExportOfOneApp() {
        val appId = "app-stable-lock-${System.nanoTime()}"
        val first = requireNotNull(CanvasExportQueue.reserve(appId, 4, "first"))
        val firstMutex = first.mutex
        CanvasExportQueue.finish(first)

        val second = requireNotNull(CanvasExportQueue.reserve(appId, 4, "next"))
        assertTrue(firstMutex === second.mutex)

        CanvasExportQueue.invalidate(appId)
        val restarted = requireNotNull(CanvasExportQueue.reserve(appId, 4, "restarted"))
        assertTrue(firstMutex === restarted.mutex)

        CanvasExportQueue.finish(second)
        CanvasExportQueue.finish(restarted)
    }

    @Test
    fun oneAppsPendingExportsDoNotConsumeAnothersBudget() {
        val fullApp = "app-full-${System.nanoTime()}"
        val emptyApp = "app-empty-${System.nanoTime()}"
        val whole = MAX_PENDING_CANVAS_BASE64_CHARS.toInt()

        val full = requireNotNull(CanvasExportQueue.reserve(fullApp, whole, "full"))
        assertNull(CanvasExportQueue.reserve(fullApp, 1, "overflow"))
        val other = requireNotNull(CanvasExportQueue.reserve(emptyApp, whole, "other"))

        CanvasExportQueue.finish(full)
        CanvasExportQueue.finish(other)
    }

    // 一次导出属于发起它的那一代 runtime。小程序退出重开后 appId 照旧，所以"这个 appId 是不是
    // 还活着"判不出迟到的结果该不该交付。
    @Test
    fun refusesToDeliverAnExportIssuedByAPreviousRuntime() {
        val generation = CanvasExportGeneration.current("app-gen")
        assertTrue(shouldDeliverCanvasExport("app-gen", generation))

        CanvasExportGeneration.invalidate("app-gen")

        assertFalse(shouldDeliverCanvasExport("app-gen", generation))
        assertTrue(shouldDeliverCanvasExport("app-gen", CanvasExportGeneration.current("app-gen")))
    }

    @Test
    fun invalidationWhileMainDeliveryIsQueuedDropsTheCallbackAndPublishedFile() = runBlocking {
        val appId = "app-queued-delivery"
        val generation = CanvasExportGeneration.current(appId)
        val tempRoot = tempFolder.newFolder()
        val published = File(tempRoot, "canvas_orphan.png")
        published.writeBytes(byteArrayOf(1, 2, 3))
        val result = canvasTempFileSuccess("/dimina/app/tmp/${published.name}").value
        val mainDispatcher = QueuedDispatcher()
        var delivered = false

        val delivery = launch(start = CoroutineStart.UNDISPATCHED) {
            deliverCanvasExport(
                appId = appId,
                generation = generation,
                tempRoot = tempRoot,
                result = result,
                deliveryDispatcher = mainDispatcher,
            ) {
                delivered = true
            }
        }

        assertEquals(1, mainDispatcher.pendingCount)
        CanvasExportGeneration.invalidate(appId)
        mainDispatcher.runNext()
        delivery.join()

        assertFalse(delivered)
        assertFalse(published.exists())
    }

    // 没有接收方的导出已经把文件写出去了，留着就是谁也取不到的永久占用。
    @Test
    fun deletesThePublishedFileOfAnUndeliverableExport() {
        val tempRoot = tempFolder.newFolder()
        val published = File(tempRoot, "canvas_orphan.png")
        published.writeBytes(byteArrayOf(1, 2, 3))
        val result = canvasTempFileSuccess("/dimina/app/tmp/${published.name}").value

        discardPublishedCanvasFile(tempRoot, result)

        assertFalse(published.exists())
    }

    // 失败的导出没有文件可删，也不能因为路径缺失就抛错打断结算。
    @Test
    fun discardingAFailedExportIsANoOp() {
        val tempRoot = tempFolder.newFolder()

        discardPublishedCanvasFile(tempRoot, canvasTempFileFailure("write failed").value)
    }

    private fun callbackParams() = JSONObject().apply {
        put("success", "success-id")
        put("fail", "fail-id")
        put("complete", "complete-id")
    }

    private fun parseCallback(payload: String): Pair<String, String?> {
        val body = JSONObject(payload).getJSONObject("body")
        return body.getString("id") to body.optJSONObject("args")?.optString("errMsg")
    }

    private class QueuedDispatcher : CoroutineDispatcher() {
        private val tasks = ArrayDeque<Runnable>()
        val pendingCount: Int get() = tasks.size

        override fun dispatch(context: kotlin.coroutines.CoroutineContext, block: Runnable) {
            tasks.addLast(block)
        }

        fun runNext() {
            tasks.removeFirst().run()
        }
    }
}
