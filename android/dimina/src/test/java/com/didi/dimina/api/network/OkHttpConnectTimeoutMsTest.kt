package com.didi.dimina.api.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers `okHttpConnectTimeoutMs`: the value actually handed to OkHttp's `connectTimeout` for
 * `connectSocket`. Android adds a 1000ms margin on top of the caller's requested timeout so the
 * container's own connect timer fires first; `validateTimeout` allows a requested value up to
 * `Int.MAX_VALUE` (0x7fffffff), so the naive `requestedMs + 1000` overflows past `Integer.MAX_VALUE`
 * and OkHttp throws `IllegalArgumentException: timeout too large` - the result must stay clamped to
 * `Int.MAX_VALUE` so it is always safe to pass to `connectTimeout(Long, TimeUnit.MILLISECONDS)`.
 */
class OkHttpConnectTimeoutMsTest {

    @Test
    fun ordinaryValueGetsTheOneSecondMargin() {
        assertEquals(6000L, okHttpConnectTimeoutMs(5000))
    }

    @Test
    fun theValidatorsMaximumRequestedTimeoutIsClampedNotOverflowed() {
        // validateTimeout's own upper bound - the exact value that triggers the OkHttp crash.
        assertEquals(Int.MAX_VALUE.toLong(), okHttpConnectTimeoutMs(Int.MAX_VALUE))
    }

    @Test
    fun aRequestedValueCloseToTheLimitIsAlsoClamped() {
        // requestedMs + 1000 still exceeds Int.MAX_VALUE here (500ms short of it), so this must
        // clamp too, not just the exact boundary value.
        assertEquals(Int.MAX_VALUE.toLong(), okHttpConnectTimeoutMs(Int.MAX_VALUE - 500))
    }

    @Test
    fun everyLegalRequestedTimeoutProducesAResultSafeForOkHttpsConnectTimeout() {
        // Every requestedMs validateTimeout can hand back (1..Int.MAX_VALUE) must map to something
        // OkHttp's connectTimeout(Long, TimeUnit) accepts: strictly positive and never overflowed.
        val samples = listOf(1, 1000, 60000, 120000, Int.MAX_VALUE / 2, Int.MAX_VALUE - 1000, Int.MAX_VALUE - 1, Int.MAX_VALUE)
        for (requested in samples) {
            val result = okHttpConnectTimeoutMs(requested)
            assertTrue("requested=$requested produced non-positive result=$result", result > 0)
            assertTrue("requested=$requested produced overflowed result=$result", result <= Int.MAX_VALUE.toLong())
        }
    }
}
