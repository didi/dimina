package com.didi.dimina.ui.view

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayInputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RenderFrameBridgeTest {
    @Test
    fun mainFrameCanPublishButCrossOriginH5CannotReachTheNativeObject() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val received = CountDownLatch(4)
        val messages = mutableListOf<String>()
        lateinit var web: MiniProgramWebView
        instrumentation.runOnMainSync {
            assertTrue("WebView supports an origin-scoped bridge", supportsIsolatedRenderBridge())
            web = MiniProgramWebView(instrumentation.targetContext)
            web.settings.javaScriptEnabled = true
            web.renderBridgeCleanup = installIsolatedRenderBridge(web,
                invoke = { messages.add(it.getString("source")); received.countDown() },
                publish = { messages.add(it.getString("source")); received.countDown() },
                touch = { messages.add(it.getString("source")); received.countDown() })
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !isAllowedRenderNavigation(request.url.toString(), request.isForMainFrame, true)

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (request.url.host != "h5.example") return null
                    val html = """<script>
                        parent.postMessage({isolated:typeof window.DiminaRenderMessageBridge==='undefined'
                            && typeof window.DiminaRenderBridge==='undefined'}, '*');
                    </script>""".trimIndent()
                    return WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(html.toByteArray()))
                }
            }
            web.loadDataWithBaseURL("https://appassets.androidplatform.net/jssdk/test/main/pageFrame.html", """
                <script>
                DiminaRenderBridge.invoke(JSON.stringify({source:'main'}));
                DiminaRenderBridge.publish(JSON.stringify({source:'publication'}));
                DiminaNativeComponentBridge.dispatchTouch(JSON.stringify({source:'touch'}));
                window.addEventListener('message',function(event){
                    if(event.source===document.getElementById('h5').contentWindow){
                        DiminaRenderBridge.publish(JSON.stringify({source:event.data.isolated?'isolated-child':'exposed-child'}));
                    }
                });
                </script><iframe id="h5" src="https://h5.example/form"></iframe>
            """.trimIndent(), "text/html", "UTF-8", null)
        }
        try {
            assertTrue("Main and child documents completed their bridge checks", received.await(15, TimeUnit.SECONDS))
            assertEquals(listOf("main", "publication", "touch", "isolated-child"), messages)
        } finally {
            instrumentation.runOnMainSync { web.destroy() }
        }
    }
}
