package com.didi.dimina.ui.view

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenderNavigationSecurityTest {
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
