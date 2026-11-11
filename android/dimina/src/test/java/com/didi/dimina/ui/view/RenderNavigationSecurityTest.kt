package com.didi.dimina.ui.view

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenderNavigationSecurityTest {
    @Test
    fun allowsHttpSubframesOnlyWithAnIsolatedBridge() {
        val h5 = "https://h5.example/form"
        assertTrue(isAllowedRenderNavigation(h5, isMainFrame = false, isolatedBridge = true))
        assertFalse(isAllowedRenderNavigation(h5, isMainFrame = true, isolatedBridge = true))
        assertFalse(isAllowedRenderNavigation(h5, isMainFrame = false, isolatedBridge = false))
        listOf("javascript:alert(1)", "file:///data/secret", "intent://app", "https:").forEach {
            assertFalse(isAllowedRenderNavigation(it, isMainFrame = false, isolatedBridge = true))
        }
    }

    @Test
    fun nativeMessagesRequireTheTrustedMainFrameOrigin() {
        val origin = "https://appassets.androidplatform.net"
        assertTrue(isTrustedRenderBridgeSource(origin, true))
        assertTrue(isTrustedRenderBridgeSource("$origin:443", true))
        assertFalse(isTrustedRenderBridgeSource(origin, false))
        assertFalse(isTrustedRenderBridgeSource("https://h5.example", true))
        assertFalse(isTrustedRenderBridgeSource("http://appassets.androidplatform.net", true))
        assertFalse(isTrustedRenderBridgeSource("$origin:444", true))
    }
    @Test
    fun onlyAllowsTheInternalPageFrameAsANavigationTarget() {
        assertTrue(isTrustedRenderNavigation("about:blank"))
        assertTrue(isTrustedRenderNavigation(
            "https://appassets.androidplatform.net/jssdk/1.2.3/main/pageFrame.html?vconsole=1",
        ))

        assertFalse(isTrustedRenderNavigation("https://evil.example/pageFrame.html"))
        assertFalse(isTrustedRenderNavigation("https://appassets.androidplatform.net:444/jssdk/1/main/pageFrame.html"))
        assertFalse(isTrustedRenderNavigation("http://appassets.androidplatform.net/jssdk/1/main/pageFrame.html"))
        assertFalse(isTrustedRenderNavigation("https://appassets.androidplatform.net/jsapp/app/main/index.html"))
        assertFalse(isTrustedRenderNavigation("https://appassets.androidplatform.net/jssdk/../main/pageFrame.html"))
        assertFalse(isTrustedRenderNavigation("javascript:alert(1)"))
    }
}
