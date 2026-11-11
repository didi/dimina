package com.didi.dimina.api.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.api.network.NetworkApi
import com.tencent.mmkv.MMKV
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** Runs entirely in the instrumentation APK's private sandbox, with fresh MMKV IDs. */
@RunWith(AndroidJUnit4::class)
class StorageNetworkParityDeviceTest {
    @Test
    fun mmkvPersistsWireAndRejectsQuotaOverwriteWithoutChangingTheOriginal() {
        val context = InstrumentationRegistry.getInstrumentation().context
        MMKV.initialize(context, context.cacheDir.resolve("storage-parity").absolutePath)
        val id = "parity-${UUID.randomUUID()}"
        val db = MMKV.mmkvWithID(id)
        fun space() = StorageSpace(Any(), {
            (db.allKeys() ?: emptyArray()).mapNotNull { key ->
                db.decodeString(key)?.let(StorageRecordCodec::decode)?.let { key to it }
            }.toMap()
        }) { key, encoded -> db.encode(key, encoded) }
        fun wire(data: String, type: String = "String") =
            JSONObject().put("data", data).put("dataType", type).put("entrySize", 0)
        try {
            val data = "1730000000000"
            assertTrue(space().set("date", "legacy-compatible", wire(data, "Date")))
            val read = space().get("date", true) as JSONObject
            assertEquals(data, read.getJSONObject("record").getString("data"))
            assertEquals("Date", read.getJSONObject("record").getString("dataType"))
            assertEquals("legacy-compatible", space().get("date", false))
            val special = "😀\uD800</x>\n\u0000"
            assertTrue(space().set("unicode", special, wire(special)))
            assertEquals(special, space().get("unicode", false))
            db.clearAll()
            val exact = "x".repeat(10 * 1024 * 1024 - 43)
            assertTrue(space().set("x", exact, wire(exact)))
            assertEquals(10240L, space().info().getLong("currentSize"))
            val error = runCatching { space().set("x", exact + "!", wire(exact + "!")) }.exceptionOrNull()
            assertEquals(StorageWire.QUOTA_ERROR, error?.message)
            assertEquals(exact, space().get("x", false))
            assertTrue(space().set("x", "small", wire("small")))
            assertEquals(1L, space().info().getLong("currentSize"))
        } finally {
            db.close()
            MMKV.removeStorage(id)
        }
    }

    @Test
    fun actualHttpPreservesBinaryBytesAnd503SuccessCompletePayloads() {
        val bytes = byteArrayOf(0, -1, -128, -61, 40, 13, 10)
        val received = AtomicReference<ByteArray>()
        val failure = AtomicReference<Throwable>()
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val worker = thread(name = "parity-http") {
            try {
                server.accept().use { socket ->
                    socket.soTimeout = 5000
                    val input = socket.getInputStream()
                    val headerBytes = mutableListOf<Byte>()
                    while (true) {
                        val byte = input.read()
                        check(byte >= 0) { "HTTP request ended before headers" }
                        headerBytes.add(byte.toByte())
                        if (headerBytes.takeLast(4) == listOf<Byte>(13, 10, 13, 10)) break
                    }
                    val headers = headerBytes.toByteArray().toString(Charsets.ISO_8859_1)
                    val length = Regex("(?im)^Content-Length: (\\d+)").find(headers)!!.groupValues[1].toInt()
                    val body = ByteArray(length)
                    var read = 0
                    while (read < length) {
                        val count = input.read(body, read, length - read)
                        check(count > 0)
                        read += count
                    }
                    received.set(body)
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 503 Unavailable\r\nContent-Length: ${bytes.size}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n".toByteArray())
                        write(bytes)
                        flush()
                    }
                }
            } catch (error: Throwable) { failure.set(error) }
        }
        try {
            val params = JSONObject().put("url", "http://127.0.0.1:${server.localPort}/bytes")
                .put("method", "POST").put("responseType", "arraybuffer").put("timeout", 5000)
                .put("data", JSONObject().put("__diminaArrayBufferBase64", Base64.getEncoder().encodeToString(bytes)))
                .put("success", "success").put("fail", "fail").put("complete", "complete")
            val messages = mutableListOf<JSONObject>()
            NetworkApi.performRequest(params) { messages.add(JSONObject(it).getJSONObject("body")) }
            worker.join(6000)
            failure.get()?.let { throw AssertionError("HTTP fixture failed", it) }
            assertFalse(worker.isAlive)
            assertArrayEquals(bytes, received.get())
            assertEquals(listOf("success", "complete"), messages.map { it.getString("id") })
            messages.forEach { message ->
                assertTrue(message.has("args"))
                val result = message.getJSONObject("args")
                assertEquals("request:ok", result.getString("errMsg"))
                assertEquals(503, result.getInt("statusCode"))
                assertArrayEquals(bytes, Base64.getDecoder().decode(result.getJSONObject("data").getString("__diminaArrayBufferBase64")))
            }
        } finally { server.close(); worker.join(6000) }
    }
}
