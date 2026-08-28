package com.didi.dimina.core

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PageVisibilityLedgerTest {

    private val delivered = mutableListOf<PageVisibilityDelivery>()
    private val ledger = PageVisibilityLedger { delivered.add(it) }

    @Test
    fun `onStart defaults to shown when nothing else has expressed an intent`() {
        ledger.onStart()
        assertEquals(emptyList<PageVisibilityDelivery>(), delivered)

        ledger.onResourceReady()

        assertEquals(listOf(PageVisibilityDelivery.SHOW), delivered)
    }

    @Test
    fun `onStart honors an explicit visibility over the default`() {
        ledger.onStart(explicitVisible = false)
        ledger.onResourceReady()

        assertEquals(emptyList<PageVisibilityDelivery>(), delivered)
    }

    @Test
    fun `an intent recorded before start is not overwritten by the default`() {
        ledger.onHide()
        ledger.onStart()
        ledger.onResourceReady()

        assertEquals(emptyList<PageVisibilityDelivery>(), delivered)
    }

    @Test
    fun `a page that never became visible does not owe a pageHide once ready`() {
        ledger.onHide()
        ledger.onResourceReady()
        ledger.onHide()

        assertEquals(emptyList<PageVisibilityDelivery>(), delivered)
    }

    @Test
    fun `only the latest direction before ready is delivered`() {
        ledger.onStart()
        ledger.onHide()
        ledger.onShow()
        ledger.onResourceReady()

        assertEquals(listOf(PageVisibilityDelivery.SHOW), delivered)
    }

    @Test
    fun `duplicate directions after becoming visible are suppressed`() {
        ledger.onStart()
        ledger.onResourceReady()

        ledger.onHide()
        ledger.onHide()
        ledger.onShow()
        ledger.onShow()

        assertEquals(
            listOf(
                PageVisibilityDelivery.SHOW,
                PageVisibilityDelivery.HIDE,
                PageVisibilityDelivery.SHOW,
            ),
            delivered,
        )
    }

    @Test
    fun `onResourceReady only flushes once per generation`() {
        ledger.onStart()
        ledger.onResourceReady()
        ledger.onResourceReady()

        assertEquals(listOf(PageVisibilityDelivery.SHOW), delivered)
    }

    @Test
    fun `different page bridges keep independent visibility state`() {
        val firstPage = mutableListOf<PageVisibilityDelivery>()
        val secondPage = mutableListOf<PageVisibilityDelivery>()
        val firstLedger = PageVisibilityLedger(firstPage::add)
        val secondLedger = PageVisibilityLedger(secondPage::add)

        firstLedger.onStart()
        secondLedger.onStart()
        firstLedger.onResourceReady()
        secondLedger.onResourceReady()

        firstLedger.onHide()
        firstLedger.onHide()
        secondLedger.onShow()
        secondLedger.onShow()

        assertEquals(
            listOf(PageVisibilityDelivery.SHOW, PageVisibilityDelivery.HIDE),
            firstPage,
        )
        assertEquals(listOf(PageVisibilityDelivery.SHOW), secondPage)
    }

    @Test
    fun `reset drops readiness and any recorded intent`() {
        ledger.onResourceReady()
        ledger.onHide()
        ledger.reset()

        ledger.onHide()
        ledger.onResourceReady()

        assertEquals(emptyList<PageVisibilityDelivery>(), delivered)
    }

    /**
     * Readiness arrives on the WebView's JavaBridge thread while show/hide intents arrive on the
     * main thread, so a hide can be raised while the show it supersedes is still on its way to the
     * service. The later transition must not overtake it: the service would be left visible while
     * the ledger records hidden, and no later intent can correct that, because the ledger
     * suppresses the direction it believes was already sent.
     *
     * The show delivery is held mid-flight while a second thread hides the page. Reaching the
     * service is recorded when the delivery returns, so a ledger that lets go of its state before
     * sending shows up as a HIDE arriving ahead of the SHOW it was meant to supersede.
     */
    @Test
    fun `a transition raised mid-delivery cannot overtake the delivery in flight`() {
        val arrived = Collections.synchronizedList(mutableListOf<PageVisibilityDelivery>())
        val showInFlight = CountDownLatch(1)
        val releaseShow = CountDownLatch(1)
        val raced = PageVisibilityLedger { delivery ->
            if (delivery == PageVisibilityDelivery.SHOW) {
                showInFlight.countDown()
                check(releaseShow.await(5, TimeUnit.SECONDS)) { "show delivery was never released" }
            }
            arrived.add(delivery)
        }
        raced.onStart()

        val ready = Thread { raced.onResourceReady() }
        ready.start()
        check(showInFlight.await(5, TimeUnit.SECONDS)) { "show was never delivered" }

        val hide = Thread { raced.onHide() }
        hide.start()
        // The hide must not reach the service while the show is still in flight.
        hide.join(300)
        assertEquals(emptyList<PageVisibilityDelivery>(), arrived.toList())

        releaseShow.countDown()
        ready.join(5_000)
        hide.join(5_000)

        assertEquals(
            listOf(PageVisibilityDelivery.SHOW, PageVisibilityDelivery.HIDE),
            arrived.toList(),
        )
    }
}
