package com.didi.dimina.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppVisibilityLedgerTest {

    @Test
    fun `cold start uses the App show emitted while the service creates the app`() {
        val ledger = AppVisibilityLedger()

        assertNull(ledger.onShow())
        assertNull(ledger.onServiceReady())
    }

    @Test
    fun `hide before service readiness is delivered after the implicit initial show`() {
        val ledger = AppVisibilityLedger()

        assertNull(ledger.onShow())
        assertNull(ledger.onHide())
        val delivery = ledger.onServiceReady()!!

        assertFalse(delivery.visible)
        assertNull(delivery.options)
    }

    @Test
    fun `return show is retained with its options and duplicate directions are suppressed`() {
        val ledger = AppVisibilityLedger()
        ledger.onServiceReady()

        assertFalse(ledger.onHide()!!.visible)
        assertNull(ledger.onHide())

        val delivery = ledger.onShow(JSONObject("""{"scene":1038}"""))!!
        assertTrue(delivery.visible)
        assertEquals(1038, delivery.options!!.getInt("scene"))
        assertNull(ledger.onShow())
    }

    @Test
    fun `reset removes readiness and pending visibility from the old runtime`() {
        val ledger = AppVisibilityLedger()
        ledger.onServiceReady()
        ledger.onHide()
        ledger.reset()

        assertNull(ledger.onShow())
        assertNull(ledger.onServiceReady())
    }
}
