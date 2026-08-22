package com.didi.dimina.core

import org.json.JSONObject

internal data class AppVisibilityDelivery(
    val visible: Boolean,
    val options: JSONObject? = null,
)

/** Keeps app visibility until the service-side App instance can receive it. */
internal class AppVisibilityLedger {
    private var serviceReady = false
    private var desiredVisible: Boolean? = null
    private var sentVisible: Boolean? = null
    private var pendingShowOptions: JSONObject? = null

    @Synchronized
    fun onShow(options: JSONObject? = null): AppVisibilityDelivery? {
        if (options != null) {
            pendingShowOptions = JSONObject(options.toString())
        }
        desiredVisible = true
        return flush()
    }

    @Synchronized
    fun onHide(): AppVisibilityDelivery? {
        desiredVisible = false
        return flush()
    }

    @Synchronized
    fun onServiceReady(): AppVisibilityDelivery? {
        if (serviceReady) return null
        serviceReady = true
        // Creating the service-side App already emits its initial App.onShow.
        sentVisible = true
        return flush()
    }

    @Synchronized
    fun reset() {
        serviceReady = false
        desiredVisible = null
        sentVisible = null
        pendingShowOptions = null
    }

    private fun flush(): AppVisibilityDelivery? {
        val visible = desiredVisible ?: return null
        if (!serviceReady) return null
        if (sentVisible == visible && !(visible && pendingShowOptions != null)) return null

        val delivery = AppVisibilityDelivery(
            visible = visible,
            options = pendingShowOptions?.let { JSONObject(it.toString()) }.takeIf { visible },
        )
        if (visible) {
            pendingShowOptions = null
        }
        sentVisible = visible
        return delivery
    }
}
