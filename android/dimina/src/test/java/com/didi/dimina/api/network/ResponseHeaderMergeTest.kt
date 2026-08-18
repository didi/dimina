package com.didi.dimina.api.network

import okhttp3.Headers
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The open event carries the response headers as a single-valued map, but a response may legally
 * repeat a field name. Folding that list down by letting the last value win silently discards
 * everything that came before it, and the three platforms then disagree about what a mini program
 * sees: one platform's HTTP stack already folds repeats - including spelling variants - into one
 * comma-joined entry, so the others have to do the same or the same server response reads
 * differently per device.
 *
 * The rule is RFC 7230 §3.2.2: repeated field names are equivalent to one field whose value is the
 * values joined with a comma, and field names compare case-insensitively - so `X-A` and `x-a` are
 * repeats of one field, not two fields. The spelling kept is the one that arrived first.
 *
 * This is deliberately NOT the rule for *request* headers, which are passed through without any
 * case folding (matching wechat, which does not fold or dedupe them in the script layer). Requests
 * carry what the caller wrote; responses carry what the wire said.
 */
class ResponseHeaderMergeTest {

    /** Folds [pairs] the way a response delivers them - order preserved, repeats allowed. */
    private fun merged(vararg pairs: Pair<String, String>): Map<String, String> {
        val builder = Headers.Builder()
        pairs.forEach { (name, value) -> builder.add(name, value) }
        return mergeResponseHeaders(builder.build())
    }

    /**
     * The premise every other test here rests on: the HTTP client really does hand us each value of
     * a repeated field, spellings and order intact. Were it to fold them itself, the merge tests
     * would keep passing while no longer testing anything.
     */
    @Test
    fun theHttpClientDeliversEveryValueOfARepeatedHeader() {
        val headers = Headers.Builder().add("X-A", "1").add("X-A", "2").add("x-a", "3").build()

        assertEquals("all three entries must survive to us", 3, headers.size)
        assertEquals(
            "iteration must preserve arrival order and the spelling of each entry",
            listOf("X-A" to "1", "X-A" to "2", "x-a" to "3"),
            headers.map { it },
        )
    }

    @Test
    fun aRepeatedHeaderIsJoinedInArrivalOrderInsteadOfOverwriting() {
        assertEquals(mapOf("X-A" to "1, 2"), merged("X-A" to "1", "X-A" to "2"))
    }

    @Test
    fun repeatedHeadersAreMatchedCaseInsensitivelyAndCollapseToASingleEntry() {
        val result = merged("X-A" to "1", "x-a" to "2", "X-a" to "3")

        assertEquals("spelling variants are repeats of one field, not separate fields", 1, result.size)
        assertEquals(mapOf("X-A" to "1, 2, 3"), result)
    }

    /** The kept spelling is whichever arrived first, not whichever looks canonical. */
    @Test
    fun theMergedEntryKeepsTheSpellingThatArrivedFirst() {
        assertEquals(mapOf("x-a" to "1, 2"), merged("x-a" to "1", "X-A" to "2"))
    }

    /** A header that appears once must come through exactly as sent - no separator, no rewriting. */
    @Test
    fun aHeaderThatAppearsOnceIsCarriedThroughUnchanged() {
        assertEquals(mapOf("X-A" to "1"), merged("X-A" to "1"))
    }

    /** Folding repeats must not disturb headers that are merely different from one another. */
    @Test
    fun distinctHeadersKeepTheirOwnValuesAndSpellings() {
        val result = merged(
            "Sec-WebSocket-Accept" to "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
            "Upgrade" to "websocket",
            "x-lower" to "a",
            "X-Upper" to "b",
        )

        assertEquals(
            mapOf(
                "Sec-WebSocket-Accept" to "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
                "Upgrade" to "websocket",
                "x-lower" to "a",
                "X-Upper" to "b",
            ),
            result,
        )
    }
}
