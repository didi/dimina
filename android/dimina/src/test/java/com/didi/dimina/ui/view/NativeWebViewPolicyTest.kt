package com.didi.dimina.ui.view

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeWebViewPolicyTest {
    @Test
    fun `registers web-view as a native component`() {
        assertTrue(NativeWebViewPolicy.TYPE in NativeWebViewPolicy.supportedComponentTypes)
    }

    @Test
    fun `accepts web sources without allowing executable schemes`() {
        assertTrue(NativeWebViewPolicy.isSupportedSource("https://www.baidu.com/"))
        assertTrue(NativeWebViewPolicy.isSupportedSource("http://localhost:8080/page"))
        assertFalse(NativeWebViewPolicy.isSupportedSource("javascript:alert(1)"))
        assertFalse(NativeWebViewPolicy.isSupportedSource("file:///data/local/tmp/page.html"))
        assertFalse(NativeWebViewPolicy.isSupportedSource(""))
    }

    @Test
    fun `serializes bridge metadata without interpolating executable values`() {
        val script = NativeWebViewPolicy.bootstrapScript(
            bridgeId = "bridge_'quoted'",
            attributes = JSONObject().apply {
                put("moduleId", "module-1")
                put("attrs", JSONObject().apply { put("message", "bindMessage") })
                put("javascript", "window.componentSdkLoaded = true;")
            },
        )

        assertTrue(script.contains("window.embed_webviewId = \"bridge_'quoted'\";"))
        assertTrue(script.contains("\"parentWebViewId\":\"bridge_'quoted'\""))
        assertTrue(script.contains("window.componentSdkLoaded = true;"))
    }
}
