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
import androidx.compose.ui.Modifier
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
    modifier: Modifier = Modifier
) {
    Box(modifier = modifier.fillMaxSize()) {
        // WebView
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                createWebView(context, onPageCompleted).apply {
                    onInitReady(this)
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
        webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                LogUtils.d(TAG, "WebView page finished loading: $url")
                if (url.contains("pageFrame.html")) {
                    onPageLoadFinished()
                }
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val url = request.url.toString()
                val context = view.context

                if (url.startsWith(FILE_PROTOCOL)) {
                    try {
                        val localFile = getFilesFile(context, url.substring(FILE_PROTOCOL.length))
                        if (localFile.exists()) {
                            LogUtils.d(TAG, "Loading file from local: $url")
                            val mimeType = MimeTypeMap.getSingleton()
                                .getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(url))
                                ?: "text/html" // Fallback MIME type
                            return WebResourceResponse(mimeType, "UTF-8", FileInputStream(localFile))
                        } else {
                            LogUtils.e(TAG, "intercepting file: $url is not existed")
                        }
                    } catch (e: Exception) {
                        LogUtils.e(TAG, "Error intercepting file: $url", e)
                    }
                }
                // Fall back to default handling for other resources
                return super.shouldInterceptRequest(view, request)
            }
        }
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
 * 根据给定的URL获取文件对象
 * 此函数用于区分jsapp和jssdk类型的URL，并返回相应的文件对象
 *
 * @param context 上下文对象，用于访问应用程序的文件目录
 * @param url 需要解析的URL，用于确定文件路径
 * @return 返回一个File对象，表示解析后的文件路径
 */
private fun getFilesFile(context: Context, url: String): File {
    val filesDir = context.filesDir
    val appIdRegex = "(wx|dd)[0-9a-zA-Z]{16}".toRegex()
    val matchResult = appIdRegex.find(url)
    return if (matchResult != null) {
        // jsapp url，使用 appId 并构造路径
        File(filesDir, "jsapp/$url")
    } else {
        // jssdk url，使用版本号构造路径
        File(filesDir, "jssdk/${VersionUtils.getJSVersion()}/main/$url")
    }
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

