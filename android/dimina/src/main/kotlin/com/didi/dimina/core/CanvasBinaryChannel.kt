package com.didi.dimina.core

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import java.util.WeakHashMap

/** Main-thread FIFO for queries, byte publications and ordinary Render messages. */
internal class CanvasBinaryChannel(view: WebView, private val readiness: (Boolean) -> Unit) {
    private val view = WeakReference(view)
    private val main = Handler(Looper.getMainLooper())
    private var port: WebMessagePortCompat? = null
    private var token = UUID.randomUUID().toString()
    private var sequence = 0L
    private var probing = false
    private var ready = false
    @Volatile var error: String? = null
        private set
    private data class Pending(val bytes: Int, val complete: (String?, String?) -> Unit)
    private val pending = linkedMapOf<String, Pending>()
    private var pendingBytes = 0

    init { channels[view] = WeakReference(this) }

    fun probe() {
        if (ready || probing) return
        val features = listOf(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL, WebViewFeature.POST_WEB_MESSAGE,
            WebViewFeature.WEB_MESSAGE_PORT_POST_MESSAGE, WebViewFeature.WEB_MESSAGE_PORT_SET_MESSAGE_CALLBACK,
            WebViewFeature.WEB_MESSAGE_PORT_CLOSE, WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        if (!features.all(WebViewFeature::isFeatureSupported)) return
        val webview = view.get() ?: return
        probing = true
        val generation = token
        webview.evaluateJavascript("globalThis.__diminaCanvasBinaryAcknowledgements===1 && typeof __diminaCanvasBinaryConnect==='function' && __diminaCanvasBinaryConnect(${JSONObject.quote(token)})") { result ->
            if (token != generation || result != "true") return@evaluateJavascript
            try {
                val ports = WebViewCompat.createWebMessageChannel(webview)
                port = ports[0]
                ports[0].setWebMessageCallback(object : WebMessagePortCompat.WebMessageCallbackCompat() {
                    override fun onMessage(port: WebMessagePortCompat, message: WebMessageCompat?) {
                        if (token != generation || message?.type != WebMessageCompat.TYPE_STRING) return
                        val text = message.data ?: return
                        if (text == "ready\n$token") { ready = true; readiness(true); return }
                        if (text.startsWith("error\n$token\n")) { close(text.substringAfter("error\n$token\n")); return }
                        val split = text.indexOf('\n')
                        if (split < 0) { close("Invalid Canvas reply"); return }
                        val error = text.startsWith('!')
                        val id = text.substring(if (error) 1 else 0, split)
                        val request = pending.remove(id) ?: return
                        pendingBytes -= request.bytes
                        request.complete(if (error) null else text.substring(split + 1), if (error) text.substring(split + 1) else null)
                    }
                })
                val url = Uri.parse(webview.url ?: throw IllegalStateException("Canvas page is unavailable"))
                val origin = Uri.Builder().scheme(url.scheme).encodedAuthority(url.encodedAuthority).build()
                WebViewCompat.postWebMessage(webview, WebMessageCompat(token, arrayOf(ports[1])), origin)
            } catch (_: Exception) { close() }
        }
        main.postDelayed({ if (token == generation && !ready && port != null) close() }, 5000)
    }

    fun query(body: JSONObject, buffers: Array<ByteArray>, deadline: Long, complete: (String?, String?) -> Unit) {
        send("canvas", body, buffers, complete, deadline)
    }

    fun publish(message: JSONObject, buffers: Array<ByteArray>, deadline: Long, accepted: ((String?) -> Unit)?) {
        var admitted = false
        send("publish", message, buffers, { _, error ->
            if (!admitted) { admitted = true; accepted?.invoke(error) }
            if (error != null && ready) close(error)
        }, minOf(deadline, System.currentTimeMillis() + 4500))
        // Small publications remain pipelined. A full window holds only the
        // Service thread until real Render acknowledgements release capacity.
        if (!admitted && pending.size < 32 && pendingBytes < 8 * 1024 * 1024) {
            admitted = true; accepted?.invoke(null)
        }
    }

    private fun send(type: String, body: JSONObject, buffers: Array<ByteArray>, complete: (String?, String?) -> Unit, deadline: Long = System.currentTimeMillis() + 4500) {
        if (!ready) { complete(null, "Canvas binary page is unavailable"); return }
        try {
            val id = "$token:${++sequence}"
            val header = JSONObject().put("type", type).put("requestId", id).put("ack", true)
                .put("deadline", deadline).put("body", body)
                .put("byteLengths", JSONArray(buffers.map { it.size })).toString().toByteArray(Charsets.UTF_8)
            val size = 4L + header.size + buffers.sumOf { it.size.toLong() }
            require(size <= MAX_BYTES && buffers.size <= 4096) { "Canvas packet exceeds budget" }
            val packet = ByteBuffer.allocate(size.toInt()).order(ByteOrder.LITTLE_ENDIAN).putInt(header.size).put(header)
            buffers.forEach { packet.put(it) }
            post(id, WebMessageCompat(packet.array()), size.toInt(), complete)
        } catch (error: Exception) { complete(null, error.message); close(error.message ?: "Canvas delivery failed") }
    }

    private fun script(script: String, callback: ((String?) -> Unit)?): Boolean {
        if (!ready) return false
        val id = "$token:${++sequence}"
        val json = if (callback == null) JSONObject().put("type", "script").put("script", script)
            else JSONObject().put("type", "legacy").put("script", "JSON.stringify(eval(${JSONObject.quote(script)})) ?? 'null'")
        json.put("requestId", id).put("ack", true)
        val message = json.toString()
        post(id, WebMessageCompat(message), message.toByteArray(Charsets.UTF_8).size) { value, error ->
            callback?.invoke(if (error == null) value else null)
        }
        return true
    }

    private fun post(id: String, message: WebMessageCompat, bytes: Int, complete: (String?, String?) -> Unit) {
        if (pending.size >= 256 || pendingBytes.toLong() + bytes > MAX_BYTES) {
            val reason = "Canvas channel exceeds budget (${pending.size} requests, ${pendingBytes.toLong() + bytes} bytes)"
            complete(null, reason); close(reason); return
        }
        pending[id] = Pending(bytes, complete); pendingBytes += bytes
        try { port!!.postMessage(message) }
        catch (error: Exception) { close(error.message ?: "Canvas delivery failed"); return }
        main.postDelayed({ if (pending.containsKey(id)) close("Canvas delivery timed out") }, 5000)
    }

    fun close(failure: String? = null) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            readiness(false)
            main.post { close(failure) }
            return
        }
        error = failure
        ready = false; probing = false; readiness(false)
        token = UUID.randomUUID().toString(); sequence = 0
        try { port?.close() } catch (_: Exception) { }
        port = null
        val failed = pending.values.toList(); pending.clear(); pendingBytes = 0
        failed.forEach { it.complete(null, "Canvas channel closed or timed out") }
    }

    companion object {
        private const val MAX_BYTES = 64L * 1024 * 1024
        private val channels = WeakHashMap<WebView, WeakReference<CanvasBinaryChannel>>()
        fun postMessage(view: WebView, script: String, callback: ((String?) -> Unit)?): Boolean =
            channels[view]?.get()?.script(script, callback) == true
    }
}
