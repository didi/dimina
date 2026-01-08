package com.didi.dimina.ui.view

import android.annotation.SuppressLint
import android.app.Application
import android.content.ComponentCallbacks2
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.res.Configuration
import android.os.Handler
import android.os.Looper
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils.FILE_PROTOCOL
import com.didi.dimina.common.VersionUtils
import java.io.File
import java.io.FileInputStream
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue

/**
 * Author: Doslin
 * WebView实例缓存管理器
 * 使用LRU策略管理WebView实例，提供预创建池以提升性能
 *
 * // 基础使用
 * DiminaWebView(
 *     onInitReady = { webView -> ... },
 *     onPageCompleted = { ... }
 * )
 *
 * // 自定义标识符
 * DiminaWebView(
 *     identifier = "main_webview",
 *     onInitReady = { webView -> ... },
 *     onPageCompleted = { ... }
 * )
 *
 * // 手动管理缓存
 * releaseWebViewToCache("main_webview")
 * clearWebViewCache()
 * val cacheInfo = getWebViewCacheInfo()
 *
 * 特性:
 * - LRU缓存策略，最大缓存3个WebView实例
 * - 预创建1个WebView实例以提升性能
 * - 自动内存管理，根据系统内存压力自动清理
 * - 5分钟过期时间，自动清理长时间未使用的实例
 * - 线程安全的操作
 */
object WebViewCacheManager : ComponentCallbacks2 {
    private const val TAG = "WebViewCacheManager"
    private const val MAX_CACHE_SIZE = 3 // 最大缓存数量
    private const val PRE_CREATE_SIZE = 1 // 预创建数量
    private const val CACHE_EXPIRE_TIME = 5 * 60 * 1000L // 5分钟过期时间
    
    // 活跃的WebView实例（正在使用）
    private val activeWebViews = ConcurrentHashMap<String, WebView>()
    
    // 空闲的WebView实例池（LRU顺序）
    private val idleWebViews = LinkedBlockingQueue<CachedWebView>()
    
    // 预创建的WebView实例池
    private val preCreatedWebViews = LinkedBlockingQueue<CachedWebView>()
    
    // 主线程Handler
    private val mainHandler = Handler(Looper.getMainLooper())
    
    // Context弱引用，避免内存泄漏
    private var contextRef: WeakReference<Context>? = null
    
    // 初始化状态
    private var isInitialized = false
    
    // 清理任务Runnable
    private val cleanupRunnable = object : Runnable {
        override fun run() {
            cleanupExpiredWebViews()
            // 每分钟执行一次清理
            mainHandler.postDelayed(this, 60 * 1000L)
        }
    }
    
    /**
     * 缓存的WebView包装类
     */
    private data class CachedWebView(
        val webView: WebView,
        val createTime: Long = System.currentTimeMillis(),
        var lastUsedTime: Long = System.currentTimeMillis()
    ) {
        fun updateLastUsedTime() {
            lastUsedTime = System.currentTimeMillis()
        }
    }
    
    /**
     * 初始化缓存管理器
     */
    fun initialize(context: Context) {
        if (isInitialized) return
        
        contextRef = WeakReference(context.applicationContext)
        isInitialized = true
        
        // 注册内存回调监听器
        if (context.applicationContext is Application) {
            (context.applicationContext as Application).registerComponentCallbacks(this)
        }
        
        // 启动定期清理任务
        mainHandler.post(cleanupRunnable)
        
        LogUtils.d(TAG, "WebViewCacheManager initialized")
        
        // 预创建WebView实例
        preCreateWebViews()
    }
    
    /**
     * 销毁缓存管理器
     */
    fun destroy() {
        if (!isInitialized) return
        
        isInitialized = false
        mainHandler.removeCallbacks(cleanupRunnable)
        
        // 注销内存回调监听器
        contextRef?.get()?.let { context ->
            if (context is Application) {
                context.unregisterComponentCallbacks(this)
            }
        }
        
        // 清理所有缓存
        clearCache()
        contextRef = null
        
        LogUtils.d(TAG, "WebViewCacheManager destroyed")
    }
    
    /**
     * 获取WebView实例
     * 优先从预创建池获取，其次从空闲池获取，最后创建新实例
     */
    fun getWebView(
        context: Context,
        onPageLoadFinished: () -> Unit,
        identifier: String = generateIdentifier()
    ): WebView {
        return mainHandler.runOnUiThread {
            // 检查是否已有活跃实例
            activeWebViews[identifier]?.let {
                LogUtils.d(TAG, "Reusing active WebView for: $identifier")
                return@runOnUiThread it
            }
            
            // 尝试从预创建池获取
            var cachedWebView = preCreatedWebViews.poll()
            if (cachedWebView != null) {
                LogUtils.d(TAG, "Using pre-created WebView for: $identifier")
                // 补充预创建池
                preCreateWebViews()
            } else {
                // 尝试从空闲池获取
                cachedWebView = idleWebViews.poll()
                if (cachedWebView != null) {
                    LogUtils.d(TAG, "Using cached WebView for: $identifier")
                }
            }
            
            val webView = if (cachedWebView != null) {
                // 重置WebView状态
                resetWebView(cachedWebView.webView, onPageLoadFinished)
                cachedWebView.updateLastUsedTime()
                cachedWebView.webView
            } else {
                // 创建新的WebView实例
                LogUtils.d(TAG, "Creating new WebView for: $identifier")
                createWebView(context, onPageLoadFinished)
            }
            
            // 添加到活跃列表
            activeWebViews[identifier] = webView
            webView
        } ?: createWebView(context, onPageLoadFinished) // 备用方案
    }
    
    /**
     * 释放WebView实例到缓存池
     */
    fun releaseWebView(identifier: String) {
        mainHandler.post {
            activeWebViews.remove(identifier)?.let { webView ->
                LogUtils.d(TAG, "Releasing WebView to cache: $identifier")
                
                // 清理WebView状态
                cleanWebView(webView)
                
                // 检查缓存池大小
                if (idleWebViews.size >= MAX_CACHE_SIZE) {
                    // 移除最老的实例
                    val oldestCached = idleWebViews.poll()
                    oldestCached?.let {
                        LogUtils.d(TAG, "Destroying oldest cached WebView")
                        destroyWebView(it.webView)
                    }
                }
                
                // 添加到空闲池
                idleWebViews.offer(CachedWebView(webView))
            }
        }
    }
    
    /**
     * 清理所有缓存的WebView实例
     */
    fun clearCache() {
        mainHandler.post {
            LogUtils.d(TAG, "Clearing all cached WebViews")
            
            // 清理预创建池
            while (preCreatedWebViews.isNotEmpty()) {
                preCreatedWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            
            // 清理空闲池
            while (idleWebViews.isNotEmpty()) {
                idleWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            
            // 清理活跃实例（慎重使用）
            activeWebViews.clear()
        }
    }
    
    /**
     * 预创建WebView实例
     */
    private fun preCreateWebViews() {
        val context = contextRef?.get() ?: return
        
        mainHandler.post {
            while (preCreatedWebViews.size < PRE_CREATE_SIZE) {
                try {
                    val webView = createWebView(context) {}
                    preCreatedWebViews.offer(CachedWebView(webView))
                    LogUtils.d(TAG, "Pre-created WebView instance")
                } catch (e: Exception) {
                    LogUtils.e(TAG, "Failed to pre-create WebView", e)
                    break
                }
            }
        }
    }
    
    /**
     * 重置WebView状态以便复用
     */
    private fun resetWebView(webView: WebView, onPageLoadFinished: () -> Unit) {
        try {
            // 停止加载
            webView.stopLoading()
            
            // 清理历史记录
            webView.clearHistory()
            
            // 清理缓存（可选）
            webView.clearCache(true)
            
            // 重新设置WebViewClient
            webView.webViewClient = createWebViewClientWithInterceptor { onPageLoadFinished() }
            
        } catch (e: Exception) {
            LogUtils.e(TAG, "Failed to reset WebView", e)
        }
    }
    
    /**
     * 清理WebView状态
     */
    private fun cleanWebView(webView: WebView) {
        try {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.clearHistory()
            webView.removeJavascriptInterface("DiminaRenderBridge")
        } catch (e: Exception) {
            LogUtils.e(TAG, "Failed to clean WebView", e)
        }
    }
    
    /**
     * 销毁WebView实例
     */
    private fun destroyWebView(webView: WebView) {
        try {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.clearHistory()
            webView.clearCache(true)
            webView.removeAllViews()
            webView.destroy()
        } catch (e: Exception) {
            LogUtils.e(TAG, "Failed to destroy WebView", e)
        }
    }
    
    /**
     * 生成唯一标识符
     */
    private fun generateIdentifier(): String {
        return "webview_${System.currentTimeMillis()}_${Thread.currentThread().id}"
    }
    
    /**
     * 在主线程运行代码块
     */
    private fun <T> Handler.runOnUiThread(block: () -> T): T? {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return block()
        } else {
            var result: T? = null
            val latch = java.util.concurrent.CountDownLatch(1)
            post {
                result = block()
                latch.countDown()
            }
            try {
                latch.await()
            } catch (e: InterruptedException) {
                LogUtils.e(TAG, "Interrupted while waiting for UI thread", e)
            }
            return result
        }
    }
    
    /**
     * 清理过期的WebView实例
     */
    private fun cleanupExpiredWebViews() {
        val currentTime = System.currentTimeMillis()
        val expiredWebViews = mutableListOf<CachedWebView>()
        
        // 检查空闲池中的过期实例
        val iterator = idleWebViews.iterator()
        while (iterator.hasNext()) {
            val cachedWebView = iterator.next()
            if (currentTime - cachedWebView.lastUsedTime > CACHE_EXPIRE_TIME) {
                iterator.remove()
                expiredWebViews.add(cachedWebView)
            }
        }
        
        // 检查预创建池中的过期实例
        val preIterator = preCreatedWebViews.iterator()
        while (preIterator.hasNext()) {
            val cachedWebView = preIterator.next()
            if (currentTime - cachedWebView.createTime > CACHE_EXPIRE_TIME) {
                preIterator.remove()
                expiredWebViews.add(cachedWebView)
            }
        }
        
        // 销毁过期的WebView实例
        if (expiredWebViews.isNotEmpty()) {
            LogUtils.d(TAG, "Cleaning up ${expiredWebViews.size} expired WebViews")
            expiredWebViews.forEach { destroyWebView(it.webView) }
        }
        
        // 补充预创建池
        if (preCreatedWebViews.isEmpty()) {
            preCreateWebViews()
        }
    }
    
    /**
     * 获取缓存状态信息
     */
    fun getCacheInfo(): String {
        return "Active: ${activeWebViews.size}, Idle: ${idleWebViews.size}, PreCreated: ${preCreatedWebViews.size}"
    }
    
    // ComponentCallbacks2 接口实现
    override fun onConfigurationChanged(newConfig: Configuration) {
        // 配置变化时不需要特殊处理
    }
    
    override fun onLowMemory() {
        LogUtils.w(TAG, "Low memory warning - clearing WebView cache")
        // 低内存时清理部分缓存
        clearExpiredAndIdleWebViews()
    }
    
    override fun onTrimMemory(level: Int) {
        LogUtils.d(TAG, "Trim memory level: $level")
        when (level) {
            ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN,
            ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> {
                // 应用进入后台，清理空闲的WebView
                clearIdleWebViews()
            }
            ComponentCallbacks2.TRIM_MEMORY_MODERATE -> {
                // 内存适度紧张，清理过期和部分空闲WebView
                clearExpiredAndIdleWebViews()
            }
            ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> {
                // 内存严重不足，清理所有非活跃WebView
                clearAllNonActiveWebViews()
            }
        }
    }
    
    /**
     * 清理空闲的WebView实例
     */
    private fun clearIdleWebViews() {
        mainHandler.post {
            val idleCount = idleWebViews.size
            while (idleWebViews.isNotEmpty()) {
                idleWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            if (idleCount > 0) {
                LogUtils.d(TAG, "Cleared $idleCount idle WebViews")
            }
        }
    }
    
    /**
     * 清理过期和空闲的WebView实例
     */
    private fun clearExpiredAndIdleWebViews() {
        mainHandler.post {
            // 清理过期实例
            cleanupExpiredWebViews()
            
            // 清理一半空闲实例
            val halfSize = idleWebViews.size / 2
            repeat(halfSize) {
                idleWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            
            LogUtils.d(TAG, "Cleared expired and half idle WebViews")
        }
    }
    
    /**
     * 清理所有非活跃的WebView实例
     */
    private fun clearAllNonActiveWebViews() {
        mainHandler.post {
            val totalCleared = idleWebViews.size + preCreatedWebViews.size
            
            // 清理空闲池
            while (idleWebViews.isNotEmpty()) {
                idleWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            
            // 清理预创建池
            while (preCreatedWebViews.isNotEmpty()) {
                preCreatedWebViews.poll()?.let { destroyWebView(it.webView) }
            }
            
            LogUtils.w(TAG, "Memory critical - cleared $totalCleared non-active WebViews")
        }
    }
}

// 文件级别的TAG常量，用于日志记录
private const val WEBVIEW_TAG = "WebViewInterceptor"

/**
 * 根据给定的URL获取文件对象
 * 此函数用于区分jsapp和jssdk类型的URL，并返回相应的文件对象
 *
 * @param context 上下文对象，用于访问应用程序的文件目录
 * @param url 需要解析的URL，用于确定文件路径
 * @return 返回一个File对象，表示解析后的文件路径
 */
internal fun getFilesFile(context: Context, url: String): File {
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
 * 创建统一的文件拦截处理器
 * 用于拦截WebView的文件协议请求，从本地文件系统加载资源
 *
 * @param onPageFinished 页面加载完成的回调
 * @return WebViewClient实例
 */
internal fun createWebViewClientWithInterceptor(
    onPageFinished: (String) -> Unit = {}
): WebViewClient {
    return object : WebViewClient() {
        override fun onPageFinished(view: WebView, url: String) {
            super.onPageFinished(view, url)
            LogUtils.d(WEBVIEW_TAG, "WebView page finished loading: $url")
            if (url.contains("pageFrame.html")) {
                onPageFinished(url)
            }
        }
        
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest
        ): WebResourceResponse? {
            return handleFileInterceptRequest(view.context, request)
        }
    }
}

/**
 * 统一处理文件拦截请求的逻辑
 * 拦截file://协议的请求，优先从本地文件系统加载资源
 * 
 * 处理策略：
 * 1. 优先尝试作为本地文件加载
 * 2. 如果文件不存在，则判断可能是被错误解析的协议相对URL，转换为https://协议加载
 * 
 * 这样可以兼容两种情况：
 * - 真正的本地文件：直接加载
 * - 被错误解析的网络资源：自动转换为https加载
 *
 * @param context 上下文对象
 * @param request WebView资源请求
 * @return 如果是文件协议请求且文件存在，返回WebResourceResponse；如果文件不存在则尝试网络加载；否则返回null
 */
internal fun handleFileInterceptRequest(
    context: Context,
    request: WebResourceRequest
): WebResourceResponse? {
    val url = request.url.toString()
    
    if (url.startsWith(FILE_PROTOCOL)) {
        try {
            // 提取file://协议后的路径部分
            val pathAfterProtocol = url.substring(FILE_PROTOCOL.length)
            
            // 优先尝试作为本地文件加载
            val localFile = getFilesFile(context, pathAfterProtocol)
            if (localFile.exists()) {
                LogUtils.d(WEBVIEW_TAG, "Loading file from local: $url")
                val mimeType = MimeTypeMap.getSingleton()
                    .getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(url))
                    ?: "text/html" // Fallback MIME type
                return WebResourceResponse(mimeType, "UTF-8", FileInputStream(localFile))
            }
            
            // 文件不存在，可能是被错误解析的协议相对URL，尝试转换为https://协议加载网络资源
            LogUtils.d(WEBVIEW_TAG, "Local file not found: $url")
            LogUtils.d(WEBVIEW_TAG, "Attempting to load as network resource via https")
            
            val correctedUrl = "https:/${pathAfterProtocol}" // 转换为 https://domain/path
            LogUtils.d(WEBVIEW_TAG, "Corrected URL: $correctedUrl")
            
            try {
                val connection = java.net.URL(correctedUrl).openConnection()
                connection.connectTimeout = 5000
                connection.readTimeout = 10000
                val inputStream = connection.getInputStream()
                val mimeType = connection.contentType?.split(";")?.firstOrNull()?.trim() 
                    ?: MimeTypeMap.getSingleton()
                        .getMimeTypeFromExtension(MimeTypeMap.getFileExtensionFromUrl(correctedUrl))
                    ?: "application/octet-stream"
                
                LogUtils.d(WEBVIEW_TAG, "Successfully loaded network resource: $correctedUrl")
                return WebResourceResponse(mimeType, "UTF-8", inputStream)
            } catch (e: Exception) {
                LogUtils.e(WEBVIEW_TAG, "Failed to load network resource: $correctedUrl", e)
                // 返回null，让WebView按默认方式处理
                return null
            }
        } catch (e: Exception) {
            LogUtils.e(WEBVIEW_TAG, "Error intercepting file: $url", e)
        }
    }
    
    return null
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
            LogUtils.d("WebViewCacheManager", "Chrome remote debugging enabled")
        }

        // Configure WebViewClient with file interceptor
        webViewClient = createWebViewClientWithInterceptor { onPageLoadFinished() }
    }
}

/**
 * 辅助函数：手动释放WebView到缓存池
 */
fun releaseWebViewToCache(identifier: String) {
    WebViewCacheManager.releaseWebView(identifier)
}

/**
 * 辅助函数：清理所有WebView缓存
 */
fun clearWebViewCache() {
    WebViewCacheManager.clearCache()
}

/**
 * 辅助函数：获取WebView缓存状态
 */
fun getWebViewCacheInfo(): String {
    return WebViewCacheManager.getCacheInfo()
}
