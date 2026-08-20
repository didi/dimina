package com.didi.dimina.ui.view

import org.json.JSONObject
import java.net.URI

internal object NativeWebViewPolicy {
    const val TYPE = "native/webview"

    val supportedComponentTypes = setOf(
        "native/video",
        "native/cover-view",
        "native/cover-image",
        TYPE,
    )

    fun isSupportedSource(rawUrl: String): Boolean {
        if (rawUrl.isBlank()) return false
        return try {
            val uri = URI(rawUrl)
            uri.isAbsolute && (uri.scheme.equals("http", true) || uri.scheme.equals("https", true))
        } catch (_: Exception) {
            false
        }
    }

    fun bootstrapScript(bridgeId: String, attributes: JSONObject?): String {
        val metadata = JSONObject().apply {
            put("moduleId", attributes?.optString("moduleId").orEmpty())
            put("attrs", attributes?.optJSONObject("attrs") ?: JSONObject())
            put("parentWebViewId", bridgeId)
        }
        val componentScript = attributes?.optString("javascript").orEmpty()
        return """
            window.DiminaRenderBridge = window.DiminaRenderBridge || {};
            window.DiminaRenderBridge.invoke = function(message) {
                return DiminaEmbeddedWebViewBridge.invoke(JSON.stringify(message));
            };
            window.embed_webviewId = ${JSONObject.quote(bridgeId)};
            window.embed_webview_data = $metadata;
            $componentScript
        """.trimIndent()
    }
}
