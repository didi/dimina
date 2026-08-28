package com.didi.dimina.core

internal enum class PageVisibilityDelivery { SHOW, HIDE }

/**
 * Keeps a [Bridge]'s page visibility until both its render (WebView) and service (JsCore)
 * resources have loaded. Lives on Bridge, not JsCore: readiness here is "has *this page's*
 * WebView also reported `renderResourceLoaded`", and JsCore has no visibility into that - only
 * the Bridge that owns both the WebView and the JsCore reference can see it. Mirrors
 * [AppVisibilityLedger]'s show/hide-intent-can-arrive-before-ready shape, but that one lives
 * inside JsCore because its own readiness signal (`onServiceReady`) is purely internal to the
 * engine - JsCore already knows that fact about itself, unlike this ledger's cross-Bridge fact.
 *
 * [deliver] runs inside the ledger's own monitor, so the order messages reach the service is the
 * order of the transitions that produced them. Intents arrive on different threads - `pageShow`/
 * `pageHide` on the main thread, readiness on the WebView's JavaBridge thread - and handing the
 * delivery back to the caller to send afterwards would let a later transition overtake an earlier
 * one, leaving the service visible while the ledger records hidden (or the reverse), a state no
 * later intent can correct because the ledger suppresses what it believes was already sent.
 */
internal class PageVisibilityLedger(private val deliver: (PageVisibilityDelivery) -> Unit) {
    private var ready = false
    private var desiredVisible: Boolean? = null
    private var sentVisible: Boolean? = null

    /**
     * [Bridge.start] seeds the initial intent: an explicit value wins, otherwise an intent
     * already recorded (e.g. an early [onHide]) is kept, otherwise a page starts out wanting to
     * be shown.
     */
    @Synchronized
    fun onStart(explicitVisible: Boolean? = null) {
        desiredVisible = explicitVisible ?: (desiredVisible ?: true)
        flush()
    }

    @Synchronized
    fun onShow() {
        desiredVisible = true
        flush()
    }

    @Synchronized
    fun onHide() {
        desiredVisible = false
        flush()
    }

    /** Both resources have now loaded. A no-op past the first call for this generation. */
    @Synchronized
    fun onResourceReady() {
        if (ready) return
        ready = true
        flush()
    }

    @Synchronized
    fun reset() {
        ready = false
        desiredVisible = null
        sentVisible = null
    }

    private fun flush() {
        val visible = desiredVisible ?: return
        if (!ready || sentVisible == visible) return

        // A page that was never shown does not owe a pageHide - the service side never created
        // page state for it to begin with.
        if (!visible && sentVisible == null) {
            sentVisible = false
            return
        }

        sentVisible = visible
        deliver(if (visible) PageVisibilityDelivery.SHOW else PageVisibilityDelivery.HIDE)
    }
}
