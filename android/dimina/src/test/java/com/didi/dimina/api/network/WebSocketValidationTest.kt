package com.didi.dimina.api.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One row of the cross-platform `validateCloseCode` boundary table shared with the iOS and
 * HarmonyOS test suites - [label] identifies the input at a glance in a failure message.
 */
private data class CloseCodeCase(val label: String, val input: Any?, val expected: WebSocketValidation.Result<Int>)

/**
 * Covers the pure [WebSocketValidation] functions. Error strings here have no `<api>:fail`
 * prefix - that's added by WebSocketManager.
 */
class WebSocketValidationTest {

    // ---- validateUrl ----

    @Test
    fun validateUrlAcceptsWssAndRejectsWs() {
        val wss = WebSocketValidation.validateUrl("wss://example.com/path") as WebSocketValidation.Result.Ok
        assertEquals("wss", wss.value.scheme)
        assertEquals(
            WebSocketValidation.Result.Fail("invalid url"),
            WebSocketValidation.validateUrl("ws://example.com/path"),
        )
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

    /** URI schemes are case-insensitive, but the public network policy only permits WSS. */
    @Test
    fun validateUrlAcceptsEveryCaseVariantOfWss() {
        val cases = listOf(
            "wss://example.com/socket" to "wss",
            "WSS://example.com/socket" to "wss",
            "Wss://example.com/socket" to "wss",
            "wSs://example.com/socket" to "wss",
        )
        for ((url, expectedScheme) in cases) {
            val result = WebSocketValidation.validateUrl(url)
            assertTrue("expected $url to be accepted, got $result", result is WebSocketValidation.Result.Ok)
            val ok = result as WebSocketValidation.Result.Ok
            assertEquals("scheme for $url", expectedScheme, ok.value.scheme)
            assertEquals("url for $url must be passed through unchanged", url, ok.value.url)
        }
    }

    @Test
    fun validateUrlRejectsEverySchemeOtherThanWss() {
        val urls = listOf(
            "ws://example.com/socket",
            "WS://example.com/socket",
            "http://example.com/socket",
            "https://example.com/socket",
            "HTTPS://example.com/socket",
            "ftp://example.com/socket",
            "wsx://example.com/socket",
            "wsss://example.com/socket",
            "//example.com/socket",
            "example.com/socket",
        )
        for (url in urls) {
            assertEquals(
                "expected $url to be rejected",
                WebSocketValidation.Result.Fail("invalid url"),
                WebSocketValidation.validateUrl(url),
            )
        }
    }

    @Test
    fun validateUrlRejectsFragment() {
        assertEquals(
            WebSocketValidation.Result.Fail("invalid url"),
            WebSocketValidation.validateUrl("wss://example.com/path#frag"),
        )
    }

    /**
     * A bare space anywhere in the url is rejected rather than passed on. An unescaped space cannot
     * survive the request line, so letting it through only moves the failure to a later, less
     * legible place - and lets the same url be accepted on one platform and refused on another.
     * This is the strict reading the three platforms converge on; loosening it here would put them
     * back out of step.
     */
    @Test
    fun validateUrlRejectsBareSpacesAnywhereInTheUrl() {
        val urls = listOf(
            "wss://example.com/a b",
            "wss://example.com/path?q=a b",
            "wss://example.com/ leading",
            "wss://example.com/trailing ",
        )
        for (url in urls) {
            assertEquals(
                "expected \"$url\" to be rejected for its bare space",
                WebSocketValidation.Result.Fail("invalid url"),
                WebSocketValidation.validateUrl(url),
            )
        }
    }

    /** The rule is about *bare* spaces: a properly percent-encoded one is a normal url. */
    @Test
    fun validateUrlAcceptsAPercentEncodedSpace() {
        val result = WebSocketValidation.validateUrl("wss://example.com/a%20b")
        assertTrue("percent-encoded spaces must stay legal, got $result", result is WebSocketValidation.Result.Ok)
        assertEquals("wss://example.com/a%20b", (result as WebSocketValidation.Result.Ok).value.url)
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
    fun validateTimeoutRejectsNonNumberTypes() {
        for (value in listOf<Any>("5000", true, JSONArray().put(5000), JSONObject())) {
            assertEquals(WebSocketValidation.Result.Fail("invalid timeout"), WebSocketValidation.validateTimeout(value))
        }
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
    fun validateHeaderStoresTrimmedNameNotRawKey() {
        val header = JSONObject().apply { put("  X-Custom  ", "v") }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertEquals("v", result.value["X-Custom"])
        assertTrue(!result.value.containsKey("  X-Custom  "))
    }

    @Test
    fun validateHeaderRejectsNonObject() {
        assertEquals(
            WebSocketValidation.Result.Fail("header must be an object"),
            WebSocketValidation.validateHeader(JSONArray()),
        )
    }

    @Test
    fun validateHeaderDropsDisallowedNamesSilentlyCaseInsensitive() {
        val header = JSONObject().apply {
            put("Host", "evil.com")
            put("Sec-WebSocket-Key", "abc")
            put("X-Custom", "ok")
        }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertNull(result.value["Host"])
        assertNull(result.value["Sec-WebSocket-Key"])
        assertEquals("ok", result.value["X-Custom"])
    }

    @Test
    fun validateHeaderRejectsCrlfInjectionInValue() {
        val header = JSONObject().apply { put("X-Custom", "a\r\nEvil: 1") }
        assertEquals(
            WebSocketValidation.Result.Fail("invalid header"),
            WebSocketValidation.validateHeader(header),
        )
    }

    @Test
    fun validateHeaderRejectsCrlfInjectionInName() {
        val header = JSONObject().apply { put("X-Custom\r\nEvil", "1") }
        assertEquals(
            WebSocketValidation.Result.Fail("invalid header"),
            WebSocketValidation.validateHeader(header),
        )
    }

    @Test
    fun validateHeaderRejectsNamesThatAreNotRfcTokens() {
        // A CRLF-only check would let all of these through, and the request builder would then
        // throw synchronously long after `success` had already been reported to the caller.
        for (name in listOf("Bad:Name", "Bad Name", "Bad\tName", "Bad\"Name", "Bad(Name)", "Bad/Name")) {
            val header = JSONObject().apply { put(name, "v") }
            assertEquals(
                "expected $name to be rejected",
                WebSocketValidation.Result.Fail("invalid header"),
                WebSocketValidation.validateHeader(header),
            )
        }
    }

    @Test
    fun validateHeaderAcceptsEveryRfcTokenCharacterInAName() {
        val name = "!#\$%&'*+-.^_`|~0Az"
        val header = JSONObject().apply { put(name, "v") }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertEquals("v", result.value[name])
    }

    @Test
    fun validateHeaderRejectsControlCharactersInValue() {
        // NUL, SOH, vertical tab, unit separator, DEL - none may travel in a field value.
        for (value in listOf("a\u0000b", "a\u0001b", "a\u000Bb", "a\u001Fb", "a\u007Fb")) {
            val header = JSONObject().apply { put("X-Custom", value) }
            assertEquals(
                WebSocketValidation.Result.Fail("invalid header"),
                WebSocketValidation.validateHeader(header),
            )
        }
    }

    /**
     * A header value must be ASCII. RFC 7230 deprecated obs-text (0x80-0xFF) in field values, and
     * the platforms disagree about what to do with it - one request builder refuses the header
     * outright while another sends it - so the same mini program would connect on one device and
     * fail on another. The script layer passes string values through untouched, which makes a
     * non-ASCII value a perfectly reachable input, so it has to be settled here, before the dial.
     */
    @Test
    fun validateHeaderRejectsNonAsciiValues() {
        // Escapes rather than literal bytes so each case says what it is: CJK, Latin-1
        // accents, a non-breaking space that reads like the space which stays legal, an
        // astral-plane emoji, and the very first obs-text byte.
        for (value in listOf("\u4E2D\u6587", "caf\u00E9", "a\u00A0b", "hi \uD83D\uDE00", "x\u0080")) {
            val header = JSONObject().apply { put("X-Custom", value) }
            assertEquals(
                "expected the non-ASCII value \"$value\" to be rejected",
                WebSocketValidation.Result.Fail("invalid header"),
                WebSocketValidation.validateHeader(header),
            )
        }
    }

    /** The boundary: 0x7E is the last printable ASCII character and stays legal. */
    @Test
    fun validateHeaderKeepsPrintableAsciiValuesUpToTheBoundary() {
        val value = "plain-ASCII_value~"
        val header = JSONObject().apply { put("X-Custom", value) }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertEquals(value, result.value["X-Custom"])
    }

    @Test
    fun validateHeaderKeepsTabAndSpaceInValue() {
        val header = JSONObject().apply { put("X-Custom", "a\tb c") }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertEquals("a\tb c", result.value["X-Custom"])
    }

    @Test
    fun validateHeaderDropsNullValue() {
        val header = JSONObject().apply { put("X-Custom", JSONObject.NULL) }
        val result = WebSocketValidation.validateHeader(header) as WebSocketValidation.Result.Ok
        assertNull(result.value["X-Custom"])
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

    /** Cross-platform table: only finite integer host numbers are accepted. */
    @Test
    fun validateCloseCodeCrossPlatformBoundaryTable() {
        val ok1000 = WebSocketValidation.Result.Ok(1000)
        val ok3000 = WebSocketValidation.Result.Ok(3000)
        val ok4999 = WebSocketValidation.Result.Ok(4999)
        val fail = WebSocketValidation.Result.Fail("invalid code")

        val cases = listOf(
            CloseCodeCase("missing (null)", null, ok1000),
            CloseCodeCase("int 1000 (lower boundary, exact)", 1000, ok1000),
            CloseCodeCase("int 999 (just below 1000)", 999, fail),
            CloseCodeCase("int 1001 (just above 1000)", 1001, fail),
            CloseCodeCase("int 2999 (just below the 3000-4999 band)", 2999, fail),
            CloseCodeCase("int 3000 (band lower boundary)", 3000, ok3000),
            CloseCodeCase("int 4999 (band upper boundary)", 4999, ok4999),
            CloseCodeCase("int 5000 (just above the band)", 5000, fail),
            CloseCodeCase("double 3000.0 (integer-valued, finite)", 3000.0, ok3000),
            CloseCodeCase("double 3000.5 (fractional)", 3000.5, fail),
            CloseCodeCase("double NaN", Double.NaN, fail),
            CloseCodeCase("double +Infinity", Double.POSITIVE_INFINITY, fail),
            CloseCodeCase("string \"3000\"", "3000", fail),
            CloseCodeCase("string \" 3000 \"", " 3000 ", fail),
            CloseCodeCase("string \"3000.0\"", "3000.0", fail),
            CloseCodeCase("string \"3000.5\" (fractional string)", "3000.5", fail),
            CloseCodeCase("string \"abc\" (non-numeric -> NaN)", "abc", fail),
            CloseCodeCase("string \"\" (empty after trim)", "", fail),
            CloseCodeCase("string \"  \" (whitespace-only, empty after trim)", "  ", fail),
            CloseCodeCase("boolean true", true, fail),
            CloseCodeCase("boolean false", false, fail),
            CloseCodeCase("JSONArray (wrong type)", JSONArray().put(3000), fail),
            CloseCodeCase("JSONObject (wrong type)", JSONObject().put("code", 3000), fail),
        )

        cases.forEach { case ->
            assertEquals(case.label, case.expected, WebSocketValidation.validateCloseCode(case.input))
        }
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
