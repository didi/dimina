package com.didi.dimina.api.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers the pure [WebSocketValidation] functions. Error strings here have no `<api>:fail`
 * prefix - that's added by WebSocketManager.
 */
class WebSocketValidationTest {

    // ---- validateUrl ----

    @Test
    fun validateUrlAcceptsWsAndWss() {
        val ws = WebSocketValidation.validateUrl("ws://example.com/path") as WebSocketValidation.Result.Ok
        assertEquals("ws", ws.value.scheme)

        val wss = WebSocketValidation.validateUrl("wss://example.com/path") as WebSocketValidation.Result.Ok
        assertEquals("wss", wss.value.scheme)
    }

    @Test
    fun validateUrlRejectsMissingOrEmpty() {
        assertEquals(WebSocketValidation.Result.Fail("invalid url"), WebSocketValidation.validateUrl(null))
        assertEquals(WebSocketValidation.Result.Fail("invalid url"), WebSocketValidation.validateUrl(""))
    }

    @Test
    fun validateUrlRejectsWrongScheme() {
        assertEquals(
            WebSocketValidation.Result.Fail("invalid url"),
            WebSocketValidation.validateUrl("http://example.com"),
        )
    }

    @Test
    fun validateUrlRejectsFragment() {
        assertEquals(
            WebSocketValidation.Result.Fail("invalid url"),
            WebSocketValidation.validateUrl("ws://example.com/path#frag"),
        )
    }

    @Test
    fun validateUrlComputesOriginOmittingDefaultPort() {
        val result = WebSocketValidation.validateUrl("ws://example.com:80/path") as WebSocketValidation.Result.Ok
        assertEquals("http://example.com", result.value.origin)
    }

    @Test
    fun validateUrlComputesOriginWithNonDefaultPort() {
        val result = WebSocketValidation.validateUrl("wss://example.com:1234/path") as WebSocketValidation.Result.Ok
        assertEquals("https://example.com:1234", result.value.origin)
    }

    // ---- validateTimeout ----

    @Test
    fun validateTimeoutDefaultsWhenMissing() {
        assertEquals(WebSocketValidation.Result.Ok(60000), WebSocketValidation.validateTimeout(null))
    }

    @Test
    fun validateTimeoutFallsBackSilentlyWhenNonPositive() {
        assertEquals(WebSocketValidation.Result.Ok(60000), WebSocketValidation.validateTimeout(0))
        assertEquals(WebSocketValidation.Result.Ok(60000), WebSocketValidation.validateTimeout(-5))
    }

    @Test
    fun validateTimeoutFailsOnNonFiniteOrTooLarge() {
        assertEquals(
            WebSocketValidation.Result.Fail("invalid timeout"),
            WebSocketValidation.validateTimeout("not-a-number"),
        )
        assertEquals(
            WebSocketValidation.Result.Fail("invalid timeout"),
            WebSocketValidation.validateTimeout(3_000_000_000.0),
        )
    }

    @Test
    fun validateTimeoutAcceptsValidPositiveValue() {
        assertEquals(WebSocketValidation.Result.Ok(5000), WebSocketValidation.validateTimeout(5000))
    }

    @Test
    fun validateTimeoutFloorsFractionalValuesLikeTheReference() {
        // dimina-kit's normalize.ts uses Math.floor, not round - 1500.7 must become 1500, not 1501.
        assertEquals(WebSocketValidation.Result.Ok(1500), WebSocketValidation.validateTimeout(1500.7))
    }

    // ---- validateProtocols ----

    @Test
    fun validateProtocolsDefaultsToEmptyWhenMissing() {
        assertEquals(WebSocketValidation.Result.Ok(emptyList<String>()), WebSocketValidation.validateProtocols(null))
    }

    @Test
    fun validateProtocolsRejectsNonArray() {
        assertEquals(
            WebSocketValidation.Result.Fail("protocols must be an array"),
            WebSocketValidation.validateProtocols(JSONObject()),
        )
    }

    @Test
    fun validateProtocolsRejectsEmptyOrNonStringItem() {
        val withEmpty = JSONArray().put("a").put("")
        assertEquals(
            WebSocketValidation.Result.Fail("invalid protocol"),
            WebSocketValidation.validateProtocols(withEmpty),
        )

        val withNonString = JSONArray().put("a").put(5)
        assertEquals(
            WebSocketValidation.Result.Fail("invalid protocol"),
            WebSocketValidation.validateProtocols(withNonString),
        )
    }

    @Test
    fun validateProtocolsAcceptsValidArray() {
        val arr = JSONArray().put("chat").put("v2")
        assertEquals(
            WebSocketValidation.Result.Ok(listOf("chat", "v2")),
            WebSocketValidation.validateProtocols(arr),
        )
    }

    // ---- validateHeader ----

    @Test
    fun validateHeaderInjectsOriginWhenMissing() {
        val result = WebSocketValidation.validateHeader(null, "http://example.com") as WebSocketValidation.Result.Ok
        assertEquals("http://example.com", result.value["Origin"])
        assertEquals(1, result.value.size)
    }

    @Test
    fun validateHeaderStoresTrimmedNameNotRawKey() {
        val header = JSONObject().apply { put("  X-Custom  ", "v") }
        val result = WebSocketValidation.validateHeader(header, "http://example.com") as WebSocketValidation.Result.Ok
        assertEquals("v", result.value["X-Custom"])
        assertTrue(!result.value.containsKey("  X-Custom  "))
    }

    @Test
    fun validateHeaderRejectsNonObject() {
        assertEquals(
            WebSocketValidation.Result.Fail("header must be an object"),
            WebSocketValidation.validateHeader(JSONArray(), "http://example.com"),
        )
    }

    @Test
    fun validateHeaderDropsDisallowedNamesSilentlyCaseInsensitive() {
        val header = JSONObject().apply {
            put("Host", "evil.com")
            put("Sec-WebSocket-Key", "abc")
            put("X-Custom", "ok")
        }
        val result = WebSocketValidation.validateHeader(header, "http://example.com") as WebSocketValidation.Result.Ok
        assertNull(result.value["Host"])
        assertNull(result.value["Sec-WebSocket-Key"])
        assertEquals("ok", result.value["X-Custom"])
    }

    @Test
    fun validateHeaderRejectsCrlfInjectionInValue() {
        val header = JSONObject().apply { put("X-Custom", "a\r\nEvil: 1") }
        assertEquals(
            WebSocketValidation.Result.Fail("invalid header"),
            WebSocketValidation.validateHeader(header, "http://example.com"),
        )
    }

    @Test
    fun validateHeaderRejectsCrlfInjectionInName() {
        val header = JSONObject().apply { put("X-Custom\r\nEvil", "1") }
        assertEquals(
            WebSocketValidation.Result.Fail("invalid header"),
            WebSocketValidation.validateHeader(header, "http://example.com"),
        )
    }

    @Test
    fun validateHeaderDropsNullValue() {
        val header = JSONObject().apply { put("X-Custom", JSONObject.NULL) }
        val result = WebSocketValidation.validateHeader(header, "http://example.com") as WebSocketValidation.Result.Ok
        assertNull(result.value["X-Custom"])
    }

    @Test
    fun validateHeaderDoesNotOverwriteCallerOriginRegardlessOfCase() {
        val header = JSONObject().apply { put("origin", "http://caller.example") }
        val result = WebSocketValidation.validateHeader(header, "http://example.com") as WebSocketValidation.Result.Ok
        assertEquals("http://caller.example", result.value["origin"])
        assertEquals(1, result.value.size)
    }

    // ---- validateCloseCode ----

    @Test
    fun validateCloseCodeDefaultsTo1000() {
        assertEquals(WebSocketValidation.Result.Ok(1000), WebSocketValidation.validateCloseCode(null))
    }

    @Test
    fun validateCloseCodeAcceptsBoundaryValues() {
        assertEquals(WebSocketValidation.Result.Ok(1000), WebSocketValidation.validateCloseCode(1000))
        assertEquals(WebSocketValidation.Result.Ok(3000), WebSocketValidation.validateCloseCode(3000))
        assertEquals(WebSocketValidation.Result.Ok(4999), WebSocketValidation.validateCloseCode(4999))
    }

    @Test
    fun validateCloseCodeRejectsOutOfRangeValues() {
        for (code in listOf(999, 1001, 2999, 5000)) {
            assertEquals(
                "code=$code",
                WebSocketValidation.Result.Fail("invalid code"),
                WebSocketValidation.validateCloseCode(code),
            )
        }
    }

    @Test
    fun validateCloseCodeRejectsNonInteger() {
        assertEquals(WebSocketValidation.Result.Fail("invalid code"), WebSocketValidation.validateCloseCode(1000.5))
    }

    // ---- validateReason ----

    @Test
    fun validateReasonDefaultsToEmpty() {
        assertEquals(WebSocketValidation.Result.Ok(""), WebSocketValidation.validateReason(null))
    }

    @Test
    fun validateReasonRejectsNonString() {
        assertEquals(WebSocketValidation.Result.Fail("reason must be a string"), WebSocketValidation.validateReason(42))
    }

    @Test
    fun validateReasonAcceptsExactly123Utf8Bytes() {
        // "中" is 3 bytes in UTF-8; 41 * 3 = 123 exactly.
        val reason = "中".repeat(41)
        assertEquals(123, reason.toByteArray(Charsets.UTF_8).size)
        assertEquals(WebSocketValidation.Result.Ok(reason), WebSocketValidation.validateReason(reason))
    }

    @Test
    fun validateReasonRejects124Utf8Bytes() {
        val reason = "中".repeat(41) + "A"
        assertEquals(124, reason.toByteArray(Charsets.UTF_8).size)
        assertEquals(
            WebSocketValidation.Result.Fail("reason must not exceed 123 UTF-8 bytes"),
            WebSocketValidation.validateReason(reason),
        )
    }

    @Test
    fun containsCrlfDetectsBareCrOrLf() {
        assertTrue(WebSocketValidation.containsCrlf("a\r"))
        assertTrue(WebSocketValidation.containsCrlf("a\n"))
        assertTrue(!WebSocketValidation.containsCrlf("plain"))
    }
}
