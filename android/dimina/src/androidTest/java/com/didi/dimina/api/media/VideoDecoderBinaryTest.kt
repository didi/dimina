package com.didi.dimina.api.media

import android.content.Context
import android.content.ContextWrapper
import android.os.SystemClock
import android.os.Bundle
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.api.SyncResult
import com.didi.dimina.common.PathUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.engine.qjs.QuickJSEngine
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class VideoDecoderBinaryTest {
    @Test fun decodedFramesCrossTheRealBridgeAsOwnedArrayBuffers() = withDecoder { decoder ->
        decoder.control("start", "source" to decoder.source("video-portrait.mp4"), "mode" to 1)
        decoder.nextFrame()
        assertTrue(decoder.engine.evaluate("""
            globalThis.firstFrame = frame;
            frame.data instanceof ArrayBuffer && frame.width === 720 && frame.height === 1080 &&
                frame.data.byteLength === 3110400 && new Uint8Array(frame.data)[0] > 200 &&
                new Uint8Array(frame.data)[1] < 40 && new Uint8Array(frame.data)[2] < 40 &&
                new Uint8Array(frame.data)[3] === 255;
        """.trimIndent()).booleanValue)
        decoder.engine.evaluate("new Uint8Array(firstFrame.data)[0] = 17")
        decoder.control("seek", "position" to 500)
        decoder.nextFrame()
        assertTrue(decoder.engine.evaluate("frame.pts >= 500000 && new Uint8Array(frame.data)[1] > 200").booleanValue)
        decoder.control("stop")
        assertFalse(decoder.readFrame())
        decoder.control("start", "source" to decoder.source("video-portrait.mp4"), "mode" to 1)
        decoder.nextFrame()
        assertTrue(decoder.engine.evaluate("new Uint8Array(frame.data)[0] > 200").booleanValue)
        decoder.control("remove")
        assertFalse(decoder.readFrame())
        assertTrue(decoder.engine.evaluate("new Uint8Array(firstFrame.data)[0] === 17").booleanValue)
    }

    @Test fun measures720pPortraitFramesThroughTheRealDecoderAndBridge() = withDecoder { decoder ->
        decoder.control("start", "source" to decoder.source("video-portrait.mp4"), "mode" to 1)
        var measured = 0
        var started = 0L
        var binary = true
        val deadline = SystemClock.elapsedRealtime() + 60_000
        while (measured < 120 && SystemClock.elapsedRealtime() < deadline) {
            if (!decoder.readFrame()) { Thread.sleep(2); continue }
            if (measured == 8) started = SystemClock.elapsedRealtimeNanos()
            binary = binary && decoder.engine.evaluate("frame.data instanceof ArrayBuffer").booleanValue
            // Match the existing Service adapter's legacy decoding, so before
            // and after measurements include the same public ArrayBuffer result.
            assertTrue(decoder.engine.evaluate("""
                if (!(frame.data instanceof ArrayBuffer)) {
                    frame.data = DiminaServiceBridge.decodeArrayBuffer(frame.data.__diminaArrayBufferBase64);
                }
                frame.width === 720 && frame.height === 1080 && frame.data.byteLength === 3110400;
            """.trimIndent()).booleanValue)
            measured++
        }
        val elapsed = (SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0
        val report = JSONObject().put("frames", measured).put("warmup", 8)
            .put("elapsedMs", elapsed).put("fps", (measured - 8) * 1000 / elapsed).put("binary", binary).toString()
        Log.i("DiminaVideoBenchmark", report)
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply { putString("stream", "\nDiminaVideoBenchmark: $report\n") })
        assertEquals(120, measured)
        assertTrue("decoded pixels must bypass Base64", binary)
    }

    private fun withDecoder(test: (DecoderHarness) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var activity: DiminaActivity
        instrumentation.runOnMainSync {
            activity = DiminaActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                .apply { isAccessible = true }.invoke(activity, instrumentation.targetContext)
        }
        val appId = "video-binary-${UUID.randomUUID()}"
        val api = VideoDecoderApi()
        val engine = QuickJSEngine()
        try {
            assertTrue(engine.initialize())
            val harness = DecoderHarness(activity, appId, api, engine)
            engine.setInvokeCallback("video") { message ->
                val body = message.getJSONObject("body")
                (api.handleAction(activity, appId, body.getString("name"), body.getJSONObject("params")) {} as SyncResult).value
            }
            test(harness)
        } finally {
            api.clearAll()
            engine.destroy()
            PathUtils.appTempRoot(activity, appId).deleteRecursively()
        }
    }

    private class DecoderHarness(val activity: DiminaActivity, val appId: String, val api: VideoDecoderApi, val engine: QuickJSEngine) {
        fun source(name: String): String {
            val file = File(PathUtils.appTempRoot(activity, appId), name)
            InstrumentationRegistry.getInstrumentation().context.assets.open(name).use { input ->
                file.outputStream().use { input.copyTo(it) }
            }
            return PathUtils.pathToVirtual(file)
        }

        fun control(name: String, vararg values: Pair<String, Any>) {
            val done = CountDownLatch(1)
            var success = false
            var error = "no control reply"
            val params = JSONObject().put("decoderId", "decoder").put("success", "ok").put("fail", "error").put("complete", "done")
            values.forEach { params.put(it.first, it.second) }
            api.handleAction(activity, appId, "VideoDecoder.$name", params) { text ->
                val body = JSONObject(text).getJSONObject("body")
                when (body.getString("id")) {
                    "ok" -> success = true
                    "error" -> error = body.getJSONObject("args").optString("errMsg")
                    "done" -> done.countDown()
                }
            }
            assertTrue("$name did not settle", done.await(10, TimeUnit.SECONDS))
            assertTrue(error, success)
        }

        fun readFrame(): Boolean {
            val value = engine.evaluate("""
                globalThis.frame = DiminaServiceBridge.invoke({type:'invokeAPI', target:'container', body:{
                    bridgeId:'video', name:'VideoDecoder.getFrameData', params:{decoderId:'decoder'}
                }});
                if (frame.error) throw Error(frame.error);
                !!frame.data;
            """.trimIndent())
            assertEquals(value.toString(), JSValue.Type.BOOLEAN, value.type)
            return value.booleanValue
        }

        fun nextFrame() {
            val deadline = SystemClock.elapsedRealtime() + 5_000
            while (SystemClock.elapsedRealtime() < deadline) {
                if (readFrame()) return
                Thread.sleep(2)
            }
            fail("No decoded frame")
        }
    }
}
