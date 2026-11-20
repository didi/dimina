package com.didi.dimina.core

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeDiagnosticsTest {
    @After
    fun disable() = RuntimeDiagnostics.configure(false, null, null, null, null)

    @Test
    fun capturesOutOfOrderCallbacksWithDistinctCallIdsAndStripsPageQuery() {
        disable()
        assertNull(RuntimeDiagnostics.json())
        RuntimeDiagnostics.configure(true, "fixture", null, null, null)
        RuntimeDiagnostics.launch("launch-start", "demo", "pages/index?token=private")
        val first = RuntimeDiagnostics.beginCall("request", "demo", "pages/index", "bridge")
        val second = RuntimeDiagnostics.beginCall("request", "demo", "pages/index", "bridge")
        RuntimeDiagnostics.recordCall(second, "api-callback", "fail")
        RuntimeDiagnostics.recordCall(first, "api-callback", "success")

        val json = requireNotNull(RuntimeDiagnostics.json())
        assertFalse(json.contains("private"))
        val report = JSONObject(json)
        assertEquals("fixture", report.getJSONObject("versions").getString("host"))
        val events = report.getJSONArray("events")
        assertEquals("pages/index", events.getJSONObject(0).getString("pagePath"))
        assertEquals(events.getJSONObject(2).getString("callId"), events.getJSONObject(3).getString("callId"))
        assertEquals(events.getJSONObject(1).getString("callId"), events.getJSONObject(4).getString("callId"))
        assertNotEquals(first?.id, second?.id)
    }

    @Test
    fun limitsBridgeEventsAndRejectsCallbacksFromEarlierCaptures() {
        RuntimeDiagnostics.configure(true, null, null, null, null)
        val stale = RuntimeDiagnostics.beginCall("old", "demo", null, null)
        RuntimeDiagnostics.configure(true, null, null, null, null)
        RuntimeDiagnostics.recordCall(stale, "api-callback", "success")
        val fresh = RuntimeDiagnostics.beginCall("fresh", "demo", null, null)
        assertFalse(requireNotNull(RuntimeDiagnostics.json()).contains("\"old\""))
        assertNotEquals(stale?.id, fresh?.id)

        RuntimeDiagnostics.launch("launch-start", "demo")
        repeat(201) { RuntimeDiagnostics.beginCall("new", "demo", null, null) }
        val events = JSONObject(requireNotNull(RuntimeDiagnostics.json())).getJSONArray("events")
        assertEquals(201, events.length())
        assertEquals("launch-start", events.getJSONObject(0).getString("phase"))
    }
}
