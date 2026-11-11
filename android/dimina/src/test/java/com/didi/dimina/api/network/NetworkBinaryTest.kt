package com.didi.dimina.api.network

import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.InetSocketAddress
import java.util.Base64

class NetworkBinaryTest {
    private val bytes = byteArrayOf(0, -1, -128, -61, 40, 13, 10)

    @Test
    fun binaryRequestAndResponseSurviveActualHttpAndJsonCallbackTransport() {
        var received = byteArrayOf()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/bytes") { exchange ->
            received = exchange.requestBody.readBytes()
            exchange.responseHeaders.add("Content-Type", "application/octet-stream")
            exchange.responseHeaders.add("Set-Cookie", "first=1")
            exchange.responseHeaders.add("Set-Cookie", "second=2")
            exchange.sendResponseHeaders(503, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val params = JSONObject().put("url", "http://127.0.0.1:${server.address.port}/bytes")
                .put("method", "POST").put("responseType", "arraybuffer")
                .put("data", JSONObject().put("__diminaArrayBufferBase64", Base64.getEncoder().encodeToString(bytes)))
                .put("success", "success").put("fail", "fail").put("complete", "complete")
            val messages = mutableListOf<JSONObject>()
            NetworkApi.performRequest(params) { messages.add(JSONObject(it).getJSONObject("body")) }
            assertArrayEquals(bytes, received)
            assertEquals(listOf("success", "complete"), messages.map { it.getString("id") })
            messages.forEach { message ->
                assertTrue(message.has("args"))
                val result = message.getJSONObject("args")
                assertEquals("request:ok", result.getString("errMsg"))
                assertEquals(503, result.getInt("statusCode"))
                assertEquals(2, result.getJSONArray("cookies").length())
                val encoded = result.getJSONObject("data").getString("__diminaArrayBufferBase64")
                assertArrayEquals(bytes, Base64.getDecoder().decode(encoded))
            }
        } finally { server.stop(0) }
    }

    @Test
    fun failedRequestPassesItsErrorObjectToComplete() {
        val params = JSONObject().put("url", "invalid url")
            .put("success", "success").put("fail", "fail").put("complete", "complete")
        val messages = mutableListOf<JSONObject>()
        NetworkApi.performRequest(params) { messages.add(JSONObject(it).getJSONObject("body")) }
        assertEquals(listOf("fail", "complete"), messages.map { it.getString("id") })
        assertTrue(messages.all { it.has("args") })
        assertEquals(messages[0].getJSONObject("args").toString(), messages[1].getJSONObject("args").toString())
        assertTrue(messages[0].getJSONObject("args").getString("errMsg").startsWith("request:fail"))
    }

    @Test
    fun emptyArraybufferRemainsAnEmptyBinaryRecord() {
        val result = NetworkApi.parseResponseData("", "json", "arraybuffer") as JSONObject
        assertEquals("", result.getString("__diminaArrayBufferBase64"))
    }
}
