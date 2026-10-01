package com.didi.dimina.api.media

import android.graphics.ImageFormat
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Handler
import android.os.HandlerThread
import android.util.Base64
import com.didi.dimina.api.*
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.MediaFileUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

internal class VideoDecoderStartGate {
    private val generation = AtomicLong()
    fun capture(): Long = generation.get()
    fun cancel() { generation.incrementAndGet() }
    fun checkCurrent(token: Long) { check(token == generation.get()) { "start cancelled by stop" } }
}

internal fun <T> postVideoDecoderControl(
    isRemoved: () -> Boolean,
    post: (Runnable) -> Boolean,
    settle: (Result<T>) -> Unit,
    action: () -> T,
) {
    if (isRemoved()) {
        settle(Result.failure(IllegalStateException("decoder removed")))
        return
    }
    // remove() may quit the looper between the check above and posting from the
    // source-loading coroutine. A rejected post must settle that pending control.
    if (!post(Runnable { settle(runCatching { check(!isRemoved()) { "decoder removed" }; action() }) })) {
        settle(Result.failure(IllegalStateException("decoder removed or decoder thread stopped")))
    }
}

/** A decoder owns its codec thread, compressed source and at most two RGBA frames. */
class VideoDecoderApi : BaseApiHandler() {
    override val apiNames = setOf("VideoDecoder.start", "VideoDecoder.seek", "VideoDecoder.stop",
        "VideoDecoder.remove", "VideoDecoder.getFrameData")
    private val sessions = ConcurrentHashMap<Pair<String, String>, Decoder>()

    fun clearApp(appId: String) {
        sessions.keys.filter { it.first == appId }.forEach { sessions.remove(it)?.remove() }
    }

    fun clearAll() { sessions.keys.toList().forEach { sessions.remove(it)?.remove() } }

    override fun handleAction(activity: DiminaActivity, appId: String, apiName: String,
        params: JSONObject, responseCallback: (String) -> Unit): APIResult {
        val id = params.optString("decoderId")
        if (id.isEmpty()) return SyncResult(JSValue.createError("VideoDecoder: missing decoderId"))
        val key = appId to id
        if (apiName == "VideoDecoder.getFrameData") {
            val result = sessions[key]?.frame() ?: JSONObject()
            return SyncResult(JSValue.createObject(result.toString()))
        }
        if (apiName == "VideoDecoder.remove") {
            val complete = {
                val result = JSONObject().put("errMsg", "$apiName:ok")
                ApiUtils.invokeSuccess(params, result, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback, result)
            }
            sessions.remove(key)?.remove(complete) ?: complete()
            return NoneResult()
        }
        val session = if (apiName == "VideoDecoder.start") {
            sessions[key] ?: synchronized(sessions) {
                if (sessions.keys.count { it.first == appId } >= 4) {
                    return AsyncResult(JSONObject().put("errMsg", "$apiName:fail too many VideoDecoders"))
                }
                sessions.getOrPut(key) { Decoder() }
            }
        } else sessions[key]
        if (session == null) return AsyncResult(JSONObject().put("errMsg", "$apiName:fail decoder is not started"))
        val settle: (Result<JSONObject>) -> Unit = { result ->
            val payload = result.getOrElse { JSONObject().put("errMsg", "$apiName:fail ${it.message}") }
            if (result.isSuccess) {
                payload.put("errMsg", "$apiName:ok")
                ApiUtils.invokeSuccess(params, payload, responseCallback)
            } else ApiUtils.invokeFail(params, payload, responseCallback)
            ApiUtils.invokeComplete(params, responseCallback, payload)
        }
        when (apiName) {
            "VideoDecoder.start" -> {
                val source = params.optString("source")
                val mode = params.optInt("mode", 1)
                val generation = session.startGeneration()
                CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
                    val resolved = runCatching { MediaFileUtils.resolve(activity, appId, source) }
                    resolved.fold({ file -> session.control(settle) { start(file.file.path, mode, generation) } },
                        { error -> settle(Result.failure(error)) })
                }
            }
            "VideoDecoder.seek" -> session.control(settle) { seek(params.optDouble("position")) }
            "VideoDecoder.stop" -> {
                session.cancelPendingStarts()
                session.control(settle) { stop(); JSONObject() }
            }
        }
        return NoneResult()
    }

    private class Decoder {
        private val thread = HandlerThread("DiminaVideoDecoder").apply { start() }
        private val handler = Handler(thread.looper)
        private val startGate = VideoDecoderStartGate()
        private val frames = ArrayDeque<JSONObject>()
        private val outputs = ArrayDeque<Pair<Int, MediaCodec.BufferInfo>>()
        @Volatile private var removed = false
        private var codec: MediaCodec? = null
        private var extractor: MediaExtractor? = null
        private var format: MediaFormat? = null
        private var outputFormat: MediaFormat? = null
        private var mode = 1
        private var ended = false
        private var inputEnded = false
        private var error: String? = null
        private var targetUs = 0L
        private var clockNs = 0L
        private var clockPtsUs = 0L

        fun control(settle: (Result<JSONObject>) -> Unit, action: Decoder.() -> JSONObject) {
            postVideoDecoderControl({ removed }, { handler.post(it) }, settle) { action() }
        }

        fun startGeneration(): Long = startGate.capture()
        fun cancelPendingStarts() { startGate.cancel() }

        fun start(source: String, requestedMode: Int, generation: Long): JSONObject {
            startGate.checkCurrent(generation)
            require(requestedMode in 0..1) { "invalid mode" }
            stop()
            mode = requestedMode
            val reader = MediaExtractor()
            extractor = reader
            try {
                reader.setDataSource(source)
                val track = (0 until reader.trackCount).firstOrNull {
                    reader.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
                } ?: error("no video track")
                reader.selectTrack(track)
                format = reader.getTrackFormat(track)
                val width = format!!.getInteger(MediaFormat.KEY_WIDTH)
                val height = format!!.getInteger(MediaFormat.KEY_HEIGHT)
                require(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width.toLong() * height <= 2_097_152) { "video frame exceeds pixel budget" }
                targetUs = 0
                configure()
                startGate.checkCurrent(generation)
                return JSONObject().put("width", width).put("height", height)
            } catch (failure: Throwable) { stop(); throw failure }
        }

        private fun configure() {
            synchronized(frames) { frames.clear(); ended = false; error = null; clockNs = 0 }
            outputs.clear()
            inputEnded = false
            val config = requireNotNull(format)
            outputFormat = null
            config.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            val decoder = MediaCodec.createDecoderByType(requireNotNull(config.getString(MediaFormat.KEY_MIME)))
            codec = decoder
            decoder.setCallback(object : MediaCodec.Callback() {
                override fun onInputBufferAvailable(current: MediaCodec, index: Int) {
                    if (current !== codec || removed || inputEnded) return
                    runCatching {
                        val reader = requireNotNull(extractor)
                        val buffer = requireNotNull(current.getInputBuffer(index))
                        val size = reader.readSampleData(buffer, 0)
                        if (size < 0) {
                            inputEnded = true
                            current.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        }
                        else {
                            current.queueInputBuffer(index, 0, size, reader.sampleTime, 0)
                            reader.advance()
                        }
                    }.onFailure { fail(it) }
                }
                override fun onOutputBufferAvailable(current: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                    if (current !== codec || removed) return
                    val copy = MediaCodec.BufferInfo().apply { set(info.offset, info.size, info.presentationTimeUs, info.flags) }
                    outputs.add(index to copy)
                    drain()
                }
                override fun onOutputFormatChanged(current: MediaCodec, value: MediaFormat) {
                    if (current === codec) outputFormat = value
                }
                override fun onError(current: MediaCodec, failure: MediaCodec.CodecException) {
                    if (current === codec) fail(failure)
                }
            }, handler)
            try { decoder.configure(config, null, null, 0); decoder.start() }
            catch (failure: Throwable) { codec = null; decoder.release(); throw failure }
        }

        private fun drain() {
            val decoder = codec ?: return
            while (outputs.isNotEmpty() && !removed && synchronized(frames) { frames.size < 2 }) {
                val (index, info) = outputs.removeFirst()
                try {
                    if (info.size > 0 && info.presentationTimeUs >= targetUs &&
                        info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                        val image = requireNotNull(decoder.getOutputImage(index)) { "codec does not expose YUV frames" }
                        val frame = image.use { rgba(it, info.presentationTimeUs) }
                        synchronized(frames) { if (!removed) frames.add(frame) }
                    }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) synchronized(frames) { ended = true }
                } catch (failure: Throwable) { fail(failure) }
                finally { runCatching { decoder.releaseOutputBuffer(index, false) } }
            }
        }

        private fun fail(failure: Throwable) { synchronized(frames) { error = failure.message ?: "decode failed" } }

        fun frame(): JSONObject = synchronized(frames) {
            if (removed) return@synchronized JSONObject()
            error?.let { return@synchronized JSONObject().put("error", it) }
            val frame = frames.peekFirst()
            if (frame != null) {
                if (clockNs == 0L) { clockNs = System.nanoTime(); clockPtsUs = frame.getLong("pts") }
                if (mode == 0 && frame.getLong("pts") - clockPtsUs > (System.nanoTime() - clockNs) / 1000) return@synchronized JSONObject()
                frames.removeFirst()
                handler.post { drain() }
                return@synchronized frame
            }
            JSONObject().put("ended", ended)
        }

        fun seek(position: Double): JSONObject {
            require(position.isFinite() && position >= 0 && position <= Long.MAX_VALUE / 1000.0) { "invalid position" }
            val reader = requireNotNull(extractor) { "decoder is stopped" }
            // A new codec isolates queued callbacks from the old decoding generation.
            val previous = codec; codec = null; previous?.release()
            targetUs = (position * 1000).toLong()
            reader.seekTo(targetUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            configure()
            return JSONObject()
        }

        fun stop() {
            val previous = codec; codec = null
            runCatching { previous?.release() }
            extractor?.release(); extractor = null
            outputs.clear()
            synchronized(frames) { frames.clear(); ended = false; error = null }
        }

        fun remove(complete: () -> Unit = {}) {
            removed = true
            startGate.cancel()
            synchronized(frames) { frames.clear() }
            handler.post { stop(); thread.quitSafely(); complete() }
        }

        private fun rgba(image: Image, pts: Long): JSONObject {
            require(image.format == ImageFormat.YUV_420_888) { "unsupported decoded pixel format" }
            val crop = image.cropRect
            val width = crop.width(); val height = crop.height()
            require(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width.toLong() * height <= 2_097_152) { "video frame exceeds pixel budget" }
            val pixels = ByteArray(width * height * 4)
            val planes = image.planes
            fun component(plane: Int, x: Int, y: Int): Int {
                val p = planes[plane]
                return p.buffer.get(p.buffer.position() + y * p.rowStride + x * p.pixelStride).toInt() and 255
            }
            val fullRange = outputFormat?.let { it.containsKey(MediaFormat.KEY_COLOR_RANGE) &&
                it.getInteger(MediaFormat.KEY_COLOR_RANGE) == MediaFormat.COLOR_RANGE_FULL } == true
            val bt709 = outputFormat?.let { it.containsKey(MediaFormat.KEY_COLOR_STANDARD) &&
                it.getInteger(MediaFormat.KEY_COLOR_STANDARD) == MediaFormat.COLOR_STANDARD_BT709 } == true
            var offset = 0
            for (y in 0 until height) for (x in 0 until width) {
                val sx = x + crop.left; val sy = y + crop.top
                val luma = component(0, sx, sy)
                val u = component(1, sx / 2, sy / 2) - 128.0
                val v = component(2, sx / 2, sy / 2) - 128.0
                val yy = if (fullRange) luma.toDouble() else (luma - 16) * 255.0 / 219
                val chromaScale = if (fullRange) 1.0 else 255.0 / 224
                val r = yy + (if (bt709) 1.5748 else 1.402) * v * chromaScale
                val g = yy - (if (bt709) 0.1873 else 0.3441) * u * chromaScale -
                    (if (bt709) 0.4681 else 0.7141) * v * chromaScale
                val b = yy + (if (bt709) 1.8556 else 1.772) * u * chromaScale
                pixels[offset++] = r.toInt().coerceIn(0, 255).toByte()
                pixels[offset++] = g.toInt().coerceIn(0, 255).toByte()
                pixels[offset++] = b.toInt().coerceIn(0, 255).toByte()
                pixels[offset++] = 255.toByte()
            }
            return JSONObject().put("width", width).put("height", height).put("pts", pts)
                .put("pkPts", pts)
                .put("data", JSONObject().put("__diminaArrayBufferBase64", Base64.encodeToString(pixels, Base64.NO_WRAP)))
        }
    }
}
