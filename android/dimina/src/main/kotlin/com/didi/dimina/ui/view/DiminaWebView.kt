package com.didi.dimina.ui.view

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils.FILE_PROTOCOL
import com.didi.dimina.common.VersionUtils
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

/**
 * Author: Doslin
 */
private const val TAG = "DiminaWebView"

@Composable
fun DiminaWebView(
    onInitReady: (webView: WebView) -> Unit,
    onPageCompleted: () -> Unit,
    modifier: Modifier = Modifier,
    identifier: String? = null,
    enableCache: Boolean = true
) {
    val context = LocalContext.current
    val webViewIdentifier = remember { identifier ?: "webview_${System.currentTimeMillis()}" }

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
                releaseWebViewToCache(webViewIdentifier)
                LogUtils.d(TAG, "WebView released on dispose: $webViewIdentifier")
            }
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                val webView = if (enableCache) {
                    // 使用缓存管理器获取WebView实例
                    WebViewCacheManager.getWebView(context, onPageCompleted, webViewIdentifier)
                } else {
                    // 传统方式创建WebView
                    createWebView(context, onPageCompleted)
                }

                webView.apply {
                    onInitReady(this)
                    LogUtils.d(TAG, "WebView initialized with identifier: $webViewIdentifier")
                    LogUtils.d(TAG, "Cache info: ${getWebViewCacheInfo()}")
                }
            }
        )
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun createWebView(context: Context, onPageLoadFinished: () -> Unit): WebView {
    return WebView(context).apply {
        // 配置 WebView 设置
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        if (0 != (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)) {
            WebView.setWebContentsDebuggingEnabled(true)
            LogUtils.d(TAG, "Chrome remote debugging enabled")
        }

        // Configure WebViewClient with file interceptor
        webViewClient = createWebViewClientWithInterceptor { onPageLoadFinished() }
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
    // 构建 JSON body
    val jsonBody = StringBuilder()
    jsonBody.append("{")
    body.entries.forEachIndexed { index, entry ->
        if (index > 0) jsonBody.append(",")
        jsonBody.append("\"${entry.key}\":\"${entry.value}\"")
    }
    jsonBody.append("}")

    postMessage("{type:'$type', body:$jsonBody}", callback)
}

fun WebView.postMessage(msg: String, callback: ((String?) -> Unit)? = null) {
    this.evaluateJavascript("DiminaRenderBridge.onMessage($msg)", callback)
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
        LogUtils.d(TAG, "从WebView调用 DiminaRenderBridge.publish called from WebView: $message")
        this.publishHandler(JSONObject(message))
    }

    companion object {
        const val TAG = "DiminaRenderBridge"
    }
}


