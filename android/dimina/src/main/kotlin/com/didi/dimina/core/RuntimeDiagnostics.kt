package com.didi.dimina.core

import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque

internal object RuntimeDiagnostics {
    private const val MAX_EVENTS_PER_STREAM = 200
    private val launchEvents = ArrayDeque<JSONObject>()
    private val bridgeEvents = ArrayDeque<JSONObject>()
    private var startedAt = 0L
    private var sequence = 0L
    private var generation = 0L
    private var versions = JSONObject()

    @Volatile
    var enabled = false
        private set

    data class Call(
        val generation: Long,
        val id: String,
        val api: String,
        val appId: String,
        val pagePath: String?,
        val bridgeId: String?,
    )

    @Synchronized
    fun configure(enabled: Boolean, host: String?, sdk: String?, jssdk: String?, compiler: String?) {
        this.enabled = enabled
        generation++
        startedAt = System.nanoTime()
        launchEvents.clear()
        bridgeEvents.clear()
        versions = JSONObject().put("host", host).put("sdk", sdk).put("jssdk", jssdk).put("compiler", compiler)
    }

    fun launch(
        phase: String, appId: String, pagePath: String? = null, bridgeId: String? = null,
        resourceLoadId: String? = null, failure: String? = null,
    ) {
        if (!enabled) return
        synchronized(this) {
            if (!enabled) return
            append(launchEvents, event(phase, appId, pagePath, bridgeId)
                .put("resourceLoadId", resourceLoadId).put("failure", failure))
        }
    }

    fun beginCall(api: String, appId: String, pagePath: String?, bridgeId: String?): Call? {
        if (!enabled) return null
        return synchronized(this) {
            if (!enabled) return null
            val call = Call(generation, "call-${sequence + 1}", api, appId, pagePath, bridgeId)
            recordCall(call, "api-received")
            call
        }
    }

    @Synchronized
    fun recordCall(call: Call?, phase: String, outcome: String? = null) {
        if (call == null || !enabled || call.generation != generation) return
        append(bridgeEvents, event(phase, call.appId, call.pagePath, call.bridgeId)
            .put("callId", call.id).put("api", call.api).put("outcome", outcome))
    }

    @Synchronized
    fun json(): String? {
        if (!enabled) return null
        return JSONObject().put("schemaVersion", 1).put("platform", "Android")
            .put("versions", versions)
            .put("events", JSONArray((launchEvents + bridgeEvents).sortedBy { it.getLong("sequence") }))
            .toString()
    }

    private fun event(phase: String, appId: String, pagePath: String?, bridgeId: String?) = JSONObject()
        .put("sequence", ++sequence).put("elapsedMs", (System.nanoTime() - startedAt) / 1_000_000)
        .put("phase", phase).put("appId", appId)
        .put("pagePath", pagePath?.substringBefore('?')?.substringBefore('#'))
        .put("bridgeId", bridgeId)

    private fun append(events: ArrayDeque<JSONObject>, event: JSONObject) {
        if (events.size == MAX_EVENTS_PER_STREAM) events.removeFirst()
        events.addLast(event)
    }
}
