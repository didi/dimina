package com.didi.dimina.ui.view

import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import org.json.JSONObject
import java.net.URI

internal fun supportsIsolatedRenderBridge(): Boolean =
    WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
        WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)

internal fun isTrustedRenderBridgeSource(origin: String, isMainFrame: Boolean): Boolean = try {
    val uri = URI(origin)
    isMainFrame && uri.scheme == "https" && uri.host == PathUtils.WEBVIEW_ASSET_DOMAIN &&
        (uri.port == -1 || uri.port == 443)
} catch (_: Exception) { false }

/** A native interface scoped to the trusted main frame, unavailable to H5 children. */
internal fun installIsolatedRenderBridge(
    view: WebView,
    invoke: (JSONObject) -> Unit,
    publish: (JSONObject) -> Unit,
    touch: (JSONObject) -> Unit,
): () -> Unit {
    val name = "DiminaRenderMessageBridge"
    val origins = setOf("https://${PathUtils.WEBVIEW_ASSET_DOMAIN}")
    WebViewCompat.addWebMessageListener(view, name, origins) { _, message, origin, mainFrame, _ ->
        if (message.type != WebMessageCompat.TYPE_STRING || !isTrustedRenderBridgeSource(origin.toString(), mainFrame)) {
            return@addWebMessageListener
        }
        try {
            val envelope = JSONObject(message.data ?: return@addWebMessageListener)
            val payload = JSONObject(envelope.getString("message"))
            when (envelope.getString("method")) {
                "invoke" -> invoke(payload)
                "publish" -> publish(payload)
                "touch" -> touch(payload)
            }
        } catch (error: Exception) {
            LogUtils.e(name, "Invalid render bridge message: ${error.message}")
        }
    }
    val script = WebViewCompat.addDocumentStartJavaScript(view, """
        (function () {
            if (window !== window.top) return;
            var transport = window.$name;
            function send(method, message) {
                transport.postMessage(JSON.stringify({method:method,message:message}));
            }
            window.DiminaRenderBridge = {
                invoke:function(message){send('invoke',message)},
                publish:function(message){send('publish',message)},
                supportsEmbeddedWebView:function(){return true}
            };
            window.DiminaNativeComponentBridge = {dispatchTouch:function(message){send('touch',message)}};
        })();
    """.trimIndent(), origins)
    var disposed = false
    return {
        if (!disposed) {
            disposed = true
            script.remove()
            WebViewCompat.removeWebMessageListener(view, name)
        }
    }
}
