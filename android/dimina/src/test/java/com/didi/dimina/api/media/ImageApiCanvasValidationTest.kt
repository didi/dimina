package com.didi.dimina.api.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

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
        val active = AtomicInteger(0)
        val peak = AtomicInteger(0)

        (1..6).map {
            launch(Dispatchers.Default) {
                CanvasExportQueue.serialized("app-a") {
                    val now = active.incrementAndGet()
                    peak.updateAndGet { seen -> maxOf(seen, now) }
                    delay(5)
                    active.decrementAndGet()
                }
            }
        }.joinAll()

        assertEquals(1, peak.get())
    }

    @Test
    fun oneAppsExportDoesNotBlockAnother() = runBlocking {
        val parked = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        val holder = launch(Dispatchers.Default) {
            CanvasExportQueue.serialized("app-parked") {
                entered.complete(Unit)
                parked.await()
            }
        }
        entered.await()

        withTimeout(2_000) {
            CanvasExportQueue.serialized("app-other") { }
        }

        parked.complete(Unit)
        holder.join()
    }

    // 一次失败不能把后面排队的导出一起堵死。
    @Test
    fun aThrowingExportReleasesTheQueue() = runBlocking {
        runCatching {
            CanvasExportQueue.serialized("app-failing") { throw IllegalStateException("boom") }
        }

        val ran = withTimeout(2_000) {
            CanvasExportQueue.serialized("app-failing") { true }
        }

        assertTrue(ran)
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
}
