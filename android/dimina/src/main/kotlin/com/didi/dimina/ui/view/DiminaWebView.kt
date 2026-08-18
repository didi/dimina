package com.didi.dimina.ui.view

import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.didi.dimina.common.JavaScriptUtils
import com.didi.dimina.common.LogUtils
import org.json.JSONObject

/**
 * Author: Doslin
 */
private const val TAG = "DiminaWebView"

private class WebViewReference(var value: WebView? = null)

internal object MiniProgramWindowInsetsPolicy {
    internal fun withoutTopInset(insets: Insets): Insets =
        Insets.of(insets.left, 0, insets.right, insets.bottom)

    /**
     * Mini program custom navigation already uses statusBarHeight to keep controls below the
     * system status bar. Newer Android WebView versions also expose the same top inset through
     * CSS safe-area-inset-top, which makes compatible pages reserve the status bar twice.
     *
     * Clear only the top status-bar/cutout dimensions before dispatching insets to web content.
     * Bottom navigation-bar, IME and landscape side insets remain available to the page.
     */
    fun apply(insets: WindowInsetsCompat): WindowInsetsCompat {
        val statusBars = WindowInsetsCompat.Type.statusBars()
        val displayCutout = WindowInsetsCompat.Type.displayCutout()
        return WindowInsetsCompat.Builder(insets)
            .setInsets(statusBars, withoutTopInset(insets.getInsets(statusBars)))
            .setInsets(displayCutout, withoutTopInset(insets.getInsets(displayCutout)))
            .build()
    }
}

private fun WebView.applyMiniProgramWindowInsetsPolicy() {
    ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
        MiniProgramWindowInsetsPolicy.apply(insets)
    }
}

@Composable
fun DiminaWebView(
    onInitReady: (webView: WebView) -> Unit,
    onPageCompleted: () -> Unit,
    modifier: Modifier = Modifier,
    identifier: String? = null,
    appId: String = "",
    enableCache: Boolean = true,
    onNativeOverlayReady: (overlay: FrameLayout) -> Unit = {}
) {
    val context = LocalContext.current
    val webViewIdentifier = remember { identifier ?: "webview_${System.currentTimeMillis()}" }
    val webViewReference = remember(webViewIdentifier) { WebViewReference() }

    // 初始化缓存管理器
    remember {
        if (enableCache) {
            WebViewCacheManager.initialize(context)
        }
        true
    }

    // 生命周期管理
    DisposableEffect(webViewIdentifier) {
        onDispose {
            if (enableCache) {
                releaseWebViewToCache(webViewIdentifier, webViewReference.value)
                webViewReference.value = null
                LogUtils.d(TAG, "WebView released on dispose: $webViewIdentifier")
            }
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                NativeComponentOverlay(context).apply {
                    layoutParams = FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.MATCH_PARENT
                    )
                    clipChildren = false
                    clipToPadding = false
                    onNativeOverlayReady(this)
                }
            }
        )

        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                if (enableCache) {
                    // 使用缓存管理器获取WebView实例
                    WebViewCacheManager.getWebView(context, onPageCompleted, webViewIdentifier, appId)
                } else {
                    // 传统方式创建WebView（使用WebViewCacheManager中的统一配置）
                    createWebView(context, onPageCompleted, appId)
                }.apply {
                    applyMiniProgramWindowInsetsPolicy()
                    webViewReference.value = this
                    onInitReady(this)
                    LogUtils.d(TAG, "WebView initialized with identifier: $webViewIdentifier")
                    LogUtils.d(TAG, "Cache info: ${getWebViewCacheInfo()}")
                }
            }
        )
    }
}

/**
 * 向渲染线程发送消息
 * 这个方法封装了 webview.evaluateJavascript，使其接口与 jscore.postMessage 保持一致
 *
 * @param type 消息类型
 * @param body 消息内容
 * @param callback 可选的回调函数，接收 JavaScript 执行的结果
 */
fun WebView.postMessage(
    type: String,
    body: Map<String, String>,
    callback: ((String?) -> Unit)? = null
) {
    postMessage(JavaScriptUtils.message(type, body), callback)
}

fun WebView.postMessage(msg: String, callback: ((String?) -> Unit)? = null) {
    this.evaluateJavascript(JavaScriptUtils.invokeWithJson("DiminaRenderBridge.onMessage", msg), callback)
}


/**
 * JavaScript interface for DiminaRenderBridge
 * This class provides the native implementation of the DiminaRenderBridge
 * that will be exposed to JavaScript in the WebView
 */
class DiminaRenderBridge(
    private val invokeHandler: (JSONObject) -> Unit,
    private val publishHandler: (JSONObject) -> Unit
) {
    /**
     * Method that can be called from JavaScript to invoke a function in Kotlin
     * @param message The message from JavaScript
     */
    @Suppress("unused")
    @JavascriptInterface
    fun invoke(message: String) {
        LogUtils.d(TAG, "DiminaRenderBridge.invoke called from WebView: $message")
        this.invokeHandler(JSONObject(message))
    }

    /**
     * Method that can be called from JavaScript to publish a message to Kotlin
     * @param message The message from JavaScript
     */
    @Suppress("unused")
    @JavascriptInterface
    fun publish(message: String) {
        LogUtils.d(TAG, "DiminaRenderBridge.publish called from WebView: $message")
        this.publishHandler(JSONObject(message))
    }

    companion object {
        const val TAG = "DiminaRenderBridge"
    }
}

class DiminaNativeComponentBridge(
    private val touchHandler: (JSONObject) -> Unit,
) {
    @Suppress("unused")
    @JavascriptInterface
    fun dispatchTouch(message: String) {
        try {
            touchHandler(JSONObject(message))
        } catch (e: Exception) {
            LogUtils.e(TAG, "DiminaNativeComponentBridge.dispatchTouch failed: ${e.message}")
        }
    }

    companion object {
        const val TAG = "DiminaNativeComponentBridge"
    }
}
