package com.didi.dimina.ui.container

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.content.res.Resources
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.view.animation.AccelerateDecelerateInterpolator
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets as ComposeWindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.didi.dimina.Dimina
import com.didi.dimina.bean.AppConfig
import com.didi.dimina.bean.BridgeOptions
import com.didi.dimina.bean.MergedPageConfig
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.bean.PathInfo
import com.didi.dimina.bean.TabBarConfig
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.common.VersionUtils
import com.didi.dimina.core.Bridge
import com.didi.dimina.core.MiniApp
import com.didi.dimina.core.RemoteUpdateManager
import com.didi.dimina.ui.theme.DiminaAndroidTheme
import com.didi.dimina.ui.view.ActionSheet
import com.didi.dimina.ui.view.ContactPicker
import com.didi.dimina.ui.view.DiminaTabBar
import com.didi.dimina.ui.view.DiminaWebView
import com.didi.dimina.ui.view.MediaPickerRoot
import com.didi.dimina.ui.view.MediaType
import com.didi.dimina.ui.view.NativeComponentHost
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.json.JSONObject
import java.io.File
import java.io.IOException
import kotlin.math.cos
import kotlin.math.sin

/**
 * Author: Doslin
 */
class DiminaActivity : ComponentActivity() {
    private val tag = "DiminaActivity"
    private val isLoading = mutableStateOf(true)

    // UI state for navigation bar
    private val showNavigationBar = mutableStateOf(true)
    private val navigationBarTitle = mutableStateOf("")
    private val navigationBarTextColor = mutableStateOf(Color.Black)
    private val navigationBarBackgroundColor = mutableStateOf("#FFFFFF")
    private val backgroundColor = mutableStateOf("#FFFFFF")
    private val tabBarConfigState = mutableStateOf<TabBarConfig?>(null)
    private val selectedTabIndex = mutableIntStateOf(-1)
    private val currentPagePath = mutableStateOf("")
    private val useTabBarContainer = mutableStateOf(false)
    private val loadedTabIndices = mutableStateOf<Set<Int>>(emptySet())

    // State for ActionSheet
    private val showActionSheet = mutableStateOf(false)
    private val showMiniProgramMenu = mutableStateOf(false)
    private var actionTextColor = "#000000"
    private var actionSheetOptions = listOf<String>()
    private var actionSheetCallback: ((Int) -> Unit)? = null

    private val mediaType = mutableStateOf(MediaType.NONE)
    private val maxImageCount = mutableIntStateOf(1)

    // WebView初始化完成后的回调列表
    private val webViewReadyCallbacks = mutableListOf<(WebView) -> Unit>()

    // 页面加载完成回调
    private var pageReadyCallback: (() -> Unit)? = null

    private var webView: WebView? = null
    private var bridge: Bridge? = null
    private var nativeOverlay: FrameLayout? = null
    private var nativeComponentHost: NativeComponentHost? = null
    private val tabPageStates = mutableMapOf<Int, TabPageState>()
    private var apiBridgeContext: Bridge? = null

    // App configuration
    private lateinit var appConfig: AppConfig

    // Reference to the MiniApp instance
    private lateinit var miniApp: MiniApp

    // Current MiniProgram
    private lateinit var miniProgram: MiniProgram

    // Contact picker for handling contact-related operations
    private lateinit var contactPicker: ContactPicker

    private var imageChooseCallback: ((List<String>) -> Unit)? = null
    
    private var adjustBottom = 0.0
    private var updateCheckStarted = false

    // 屏幕高度
    private var screenHeight = 0

    private data class TabPageState(
        val index: Int,
        var pathInfo: PathInfo,
        var root: String,
        var configInfo: MergedPageConfig,
        var webView: WebView? = null,
        var bridge: Bridge? = null,
        var nativeOverlay: FrameLayout? = null,
        var nativeComponentHost: NativeComponentHost? = null,
        val webViewReadyCallbacks: MutableList<(WebView) -> Unit> = mutableListOf(),
        var pageReadyCallback: (() -> Unit)? = null,
        var bridgeStarted: Boolean = false,
    )


    /**
     * 调整WebView的位置以适应键盘
     * @param bottom 元素到屏幕底部的距离，单位为像素
     */
    fun adjustViewPosition(bottom: Double) {
        // 获取设备像素比率（density）
        val density = Resources.getSystem().displayMetrics.density
        // CSS 像素转换为物理像素
        adjustBottom = bottom * density
    }

    fun handleChooseMedia(
        type: MediaType,
        count: Int,
        allowAlbum: Boolean,
        allowCamera: Boolean,
        callback: (List<String>) -> Unit,
    ) {
        imageChooseCallback = callback

        if (allowCamera && !allowAlbum) {
            // 只允许相机
            openSystemCamera()
        } else if (allowAlbum && !allowCamera) {
            // 只允许相册
            openSystemGallery(type, count)
        } else {
            // 设置ActionSheet的状态和回调
            showActionSheet(listOf("拍摄", "从相册选择")) { index ->
                when (index) {
                    0 -> openSystemCamera()
                    1 -> openSystemGallery(type, count)
                }
            }
        }
    }

    fun showActionSheet(
        options: List<String>,
        itemColor: String = "#000000",
        callback: (Int) -> Unit,
    ) {
        actionTextColor = itemColor
        actionSheetOptions = options
        actionSheetCallback = callback
        showActionSheet.value = true
    }

    fun handleAddContact(callback: (Boolean) -> Unit) {
        contactPicker.handleAddContact(callback)
    }

    fun handleChooseContact(callback: (Boolean, JSONObject) -> Unit) {
        contactPicker.handleChooseContact(callback)
    }

    private fun openSystemGallery(type: MediaType, maxCount: Int) {
        // Set the maximum number of images that can be selected
        maxImageCount.intValue = maxCount
        // Show the MediaPicker UI
        mediaType.value = type
    }

    private fun openSystemCamera() {
        mediaType.value = MediaType.CAMERA
    }


    fun getSoftKeyboardHeight(rootView: View, callback: (Int) -> Unit) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            rootView.setOnApplyWindowInsetsListener { _, insets ->
                // 获取软键盘的高度（px）
                val imeHeight = insets.getInsets(WindowInsets.Type.ime()).bottom
                callback(imeHeight)
                insets // 返回 insets 以保持默认行为
            }
        } else {
            ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
                val imeHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                callback(imeHeight)
                insets
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        if (intent.getBooleanExtra(CLOSE_MINI_PROGRAM_KEY, false)) {
            finish()
            return
        }
        
        // 获取屏幕高度
        screenHeight = resources.displayMetrics.heightPixels

        // 设置键盘监听
        getSoftKeyboardHeight(window.decorView.rootView) { keyBoardHeight ->
            withWebView { webView ->
                if (adjustBottom > 0 && adjustBottom < keyBoardHeight) {
                    val translationY = adjustBottom - keyBoardHeight
                    webView.translationY = translationY.toFloat()
                    LogUtils.d(tag, "调整WebView位置: translationY=$translationY, bottom=$adjustBottom, keyboardHeight=$keyBoardHeight")
                } else {
                    adjustBottom = 0.0
                    webView.translationY = 0f
                }
            }
        }

        // 接收 MiniProgram 对象
        val program = getMiniProgramFromIntent(intent)

        if (program == null) {
            finish()
            return
        }

        // Get MiniApp instance and JsCore for this MiniProgram
        try {
            miniApp = MiniApp.getInstance()
            miniProgram = program
            LogUtils.d(
                tag,
                "Successfully obtained MiniApp instance and JsCore for appId: ${miniProgram.appId}"
            )
        } catch (e: Exception) {
            LogUtils.e(tag, "Failed to get MiniApp instance or JsCore: ${e.message}")
            finish()
            return
        }

        // Initialize the ContactPicker
        contactPicker = ContactPicker(this)

        setContent {
            DiminaAndroidTheme {
                val pageBackgroundColor = parseCssColor(backgroundColor.value)
                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    containerColor = pageBackgroundColor
                ) { innerPadding ->
                    DiminaContent(
                        miniProgram = miniProgram,
                        isLoading = isLoading,
                        modifier = Modifier
                            .background(pageBackgroundColor)
                            .padding(
                                0.dp,
                                0.dp,
                                0.dp,
                                innerPadding.calculateBottomPadding()
                            )
                    )
                }
            }
        }

        // 使用协程初始化JS引擎并加载小程序
        CoroutineScope(Dispatchers.Main).launch {
            initialize()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)

        if (intent.getBooleanExtra(CLOSE_MINI_PROGRAM_KEY, false)) {
            finish()
            return
        }

        if (intent.getBooleanExtra(APPLY_UPDATE_RESTART_KEY, false)) {
            getMiniProgramFromIntent(intent)?.let { program ->
                DiminaActivity.launch(this, program)
            }
            finish()
            return
        }

        val program = getMiniProgramFromIntent(intent) ?: return
        if (::miniProgram.isInitialized && program.appId != miniProgram.appId) {
            return
        }

        miniProgram = program
        val url = program.path ?: return
        if (!::appConfig.isInitialized) {
            return
        }

        if (isTabBarPageUrl(url)) {
            switchTab(url)
        } else {
            updatePath(url)
        }
    }

    private fun getMiniProgramFromIntent(intent: Intent): MiniProgram? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(MINI_PROGRAM_KEY, MiniProgram::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(MINI_PROGRAM_KEY) as? MiniProgram
        }
    }


    /**
     * Create and initialize the QuickJS engine after UI setup
     */
    private suspend fun initialize() {
        // 在IO线程中执行耗时操作
        withContext(Dispatchers.IO) {
            // 1.解压小程序资源包 jsApp
            val appId = miniProgram.appId
            try {
                // 判断是否需要更新小程序包的逻辑：
                // 1. 是小程序首页入口
                // 2. 如果是调试模式，只要版本号大于本地版本就解压
                // 3. 如果是发布模式，需要应用版本已升级且小程序版本号大于本地版本才解压
                val shouldExtract = if (miniProgram.root) {
                    val localVersion = VersionUtils.getAppVersion(appId)
                    val isDebugMode = Dimina.getInstance().isDebugMode()
                    val appVersionUpdated = VersionUtils.isAppVersionUpdated(this@DiminaActivity)
                    
                    when {
                        isDebugMode -> {
                            // 调试模式：版本号大于本地版本就解压
                            miniProgram.versionCode > localVersion
                        }
                        appVersionUpdated -> {
                            // 发布模式且应用版本已升级：版本号大于本地版本才解压
                            miniProgram.versionCode > localVersion
                        }
                        else -> false
                    }
                } else false
                // 使用上面的shouldExtract变量来决定是否解压
                if (shouldExtract) {
                    if (Utils.unzipAssets(this@DiminaActivity, "jsapp/$appId/$appId.zip", "jsapp/$appId")) {
                        VersionUtils.setAppVersion(appId, miniProgram.versionCode)
                        LogUtils.d(tag, "Mini program extraction completed successfully")
                    } else {
                        LogUtils.e(tag, "Failed to extract mini program for appId: $appId")
                    }
                }
            } catch (e: Exception) {
                LogUtils.e(tag, "Error extracting mini program: ${e.message}")
                withContext(Dispatchers.Main) { finish() }
                return@withContext
            }

            // 2.读取配置文件 - Only after extraction is complete
            try {
                val config = readAppConfig("jsapp/$appId")
                if (config == null) {
                    LogUtils.e(tag, "Failed to read app config for appId: $appId")
                    withContext(Dispatchers.Main) { finish() }
                    return@withContext
                }
                appConfig = config
                LogUtils.d(tag, "Successfully loaded app config")
            } catch (e: Exception) {
                LogUtils.e(tag, "Error reading app config: ${e.message}")
                withContext(Dispatchers.Main) { finish() }
                return@withContext
            }

            // 3.读取页面配置
            val entryPagePath =
                miniProgram.path ?: getDefaultEntryPagePath() ?: run {
                    withContext(Dispatchers.Main) { finish() }
                    return@withContext
                }
            val pathInfo = Utils.queryPath(entryPagePath)
            val pageConfig = appConfig.modules[pathInfo.pagePath]
            val mergedPageConfig = Utils.mergePageConfig(appConfig.app, pageConfig)

            // 切换到主线程设置UI
            withContext(Dispatchers.Main) {
                // 4.设置标题栏以及状态栏颜色模式
                tabBarConfigState.value = appConfig.app.tabBar
                val initialTabIndex = getTabBarIndex(pathInfo.pagePath)
                useTabBarContainer.value = miniProgram.root && initialTabIndex >= 0
                syncTabBarState(pathInfo.pagePath)
                setInitialStyle(mergedPageConfig)

                if (useTabBarContainer.value) {
                    ensureTabLoaded(initialTabIndex, pathInfo)
                } else {
                    withWebView { webView ->
                        // 5.创建通信 bridge
                        val entryPageBridge = createBridge(
                            BridgeOptions(
                                pathInfo = pathInfo,
                                scene = 1001,
                                jscore = miniApp.getJsCore(appId, this@DiminaActivity),
                                webview = webView,
                                isRoot = true,
                                root = pageConfig?.root ?: "main",
                                appId = miniProgram.appId,
                                pages = appConfig.app.pages,
                                configInfo = mergedPageConfig
                            )
                        )
                        // Add bridge to MiniApp's bridge list for this appId
                        miniApp.addBridge(miniProgram.appId, entryPageBridge)

                        withWebViewPageLoaded {
                            LogUtils.d(tag, "Page loaded, starting bridge")
                            entryPageBridge.start()
                        }
                    }
                }
            }
        }


    }

    private fun createBridge(options: BridgeOptions, setAsActive: Boolean = true): Bridge {
        val bridge = Bridge(options = options, parent = this)
        bridge.init()
        if (setAsActive) {
            this.bridge = bridge
        }
        startUpdateCheckIfNeeded()
        return bridge
    }

    private fun startUpdateCheckIfNeeded() {
        if (updateCheckStarted) {
            return
        }
        updateCheckStarted = true

        CoroutineScope(Dispatchers.IO).launch {
            RemoteUpdateManager.checkForUpdate(
                context = applicationContext,
                miniProgram = miniProgram,
                notify = { event ->
                    miniApp.postUpdateStatus(miniProgram.appId, event)
                }
            )
        }
    }


    private fun setInitialStyle(config: MergedPageConfig) {
        // Set navigation bar visibility based on navigationStyle
        showNavigationBar.value = config.navigationStyle != "custom"

        // Set navigation bar title
        navigationBarTitle.value = config.navigationBarTitleText

        // Set navigation bar background color
        navigationBarBackgroundColor.value = config.navigationBarBackgroundColor

        // Set page background color
        backgroundColor.value = config.backgroundColor

        updateSystemNavigationBarColor(config.backgroundColor)
        updateWebViewBackgroundColor(config.backgroundColor)

        // Update status bar style based on text style
        this.updateActionColorStyle(config.navigationBarTextStyle)
    }

    private fun parseCssColor(value: String, fallback: Color = Color.White): Color {
        return try {
            Color(value.toColorInt())
        } catch (_: Exception) {
            fallback
        }
    }

    private fun updateSystemNavigationBarColor(color: String) {
        val navigationBarColor = parseCssColor(color)
        @Suppress("DEPRECATION")
        window.navigationBarColor = navigationBarColor.toArgb()
        WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightNavigationBars =
            isLightColor(navigationBarColor)
    }

    private fun updateWebViewBackgroundColor(color: String) {
        val backgroundColor = parseCssColor(color).toArgb()
        val activeWebView = getWebViewForBridge(apiBridgeContext)
        if (activeWebView != null) {
            activeWebView.setBackgroundColor(backgroundColor)
        } else {
            withWebView { webView ->
                webView.setBackgroundColor(backgroundColor)
            }
        }
    }

    private fun isLightColor(color: Color): Boolean {
        val argb = color.toArgb()
        val red = android.graphics.Color.red(argb)
        val green = android.graphics.Color.green(argb)
        val blue = android.graphics.Color.blue(argb)
        return (red * 299 + green * 587 + blue * 114) / 1000 > 128
    }

    private fun isWhiteNavigationTextStyle(color: String): Boolean {
        return when (color.trim().lowercase()) {
            "white", "#fff", "#ffffff", "#ffffffff" -> true
            else -> false
        }
    }

    fun isTabBarPageUrl(url: String): Boolean {
        if (!::appConfig.isInitialized) {
            return false
        }
        return getTabBarIndex(Utils.queryPath(url).pagePath) >= 0
    }

    fun switchTab(url: String): Boolean {
        if (!::appConfig.isInitialized) {
            return false
        }

        val pathInfo = Utils.queryPath(url)
        val targetIndex = getTabBarIndex(pathInfo.pagePath)
        if (targetIndex < 0) {
            return false
        }

        if (!miniProgram.root) {
            DiminaActivity.launch(
                this,
                MiniProgram(
                    appId = miniProgram.appId,
                    name = miniProgram.name,
                    root = true,
                    path = url,
                    versionCode = miniProgram.versionCode,
                    versionName = miniProgram.versionName,
                    updateManifestUrl = miniProgram.updateManifestUrl
                ),
                Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            )
            finish()
            return true
        }

        runOnUiThread {
            switchTabInRoot(targetIndex, pathInfo)
        }
        return true
    }

    private fun switchTabInRoot(targetIndex: Int, pathInfo: PathInfo) {
        val previousIndex = selectedTabIndex.intValue
        val previousBridge = getActiveBridge()
        val wasUsingTabBarContainer = useTabBarContainer.value

        useTabBarContainer.value = true
        ensureTabLoaded(targetIndex, pathInfo)
        val targetState = tabPageStates[targetIndex] ?: return

        if (!wasUsingTabBarContainer && previousBridge != null) {
            miniApp.removeBridge(miniProgram.appId, previousBridge)?.destroy()
            webView = null
            bridge = null
            nativeOverlay = null
            nativeComponentHost = null
        } else if (previousIndex != targetIndex) {
            previousBridge?.pageHide()
        }

        selectedTabIndex.intValue = targetIndex
        currentPagePath.value = targetState.pathInfo.pagePath
        setInitialStyle(targetState.configInfo)
        activateTabState(targetIndex)

        if (!wasUsingTabBarContainer || previousIndex != targetIndex) {
            targetState.bridge?.pageShow()
        }
    }

    private fun ensureTabLoaded(index: Int, pathInfo: PathInfo? = null): TabPageState? {
        val tabBarConfig = appConfig.app.tabBar ?: return null
        val tabItem = tabBarConfig.list.getOrNull(index) ?: return null
        val resolvedPathInfo = pathInfo ?: Utils.queryPath(tabItem.pagePath)
        val pageConfig = appConfig.modules[resolvedPathInfo.pagePath]
        val mergedPageConfig = Utils.mergePageConfig(appConfig.app, pageConfig)
        val state = tabPageStates.getOrPut(index) {
            TabPageState(
                index = index,
                pathInfo = resolvedPathInfo,
                root = pageConfig?.root ?: "main",
                configInfo = mergedPageConfig,
            )
        }

        state.pathInfo = resolvedPathInfo
        state.root = pageConfig?.root ?: "main"
        state.configInfo = mergedPageConfig

        if (!loadedTabIndices.value.contains(index)) {
            loadedTabIndices.value = loadedTabIndices.value + index
        }
        return state
    }

    private fun activateTabState(index: Int) {
        val state = tabPageStates[index] ?: return
        webView = state.webView
        bridge = state.bridge
        nativeOverlay = state.nativeOverlay
        nativeComponentHost = state.nativeComponentHost
    }

    private fun getActiveBridge(): Bridge? {
        if (useTabBarContainer.value) {
            return tabPageStates[selectedTabIndex.intValue]?.bridge ?: bridge
        }
        return bridge
    }

    private fun getWebViewForBridge(sourceBridge: Bridge?): WebView? {
        if (sourceBridge != null) {
            tabPageStates.values.firstOrNull { it.bridge === sourceBridge }?.webView?.let {
                return it
            }
            if (bridge === sourceBridge) {
                return webView
            }
        }
        return if (useTabBarContainer.value) {
            tabPageStates[selectedTabIndex.intValue]?.webView ?: webView
        } else {
            webView
        }
    }

    private fun syncTabBarState(pagePath: String) {
        currentPagePath.value = pagePath
        val tabIndex = getTabBarIndex(pagePath)
        if (tabIndex >= 0) {
            selectedTabIndex.intValue = tabIndex
        }
    }

    private fun getTabBarIndex(pagePath: String): Int {
        return appConfig.app.tabBar?.list?.indexOfFirst { item ->
            item.pagePath == pagePath
        } ?: -1
    }

    private fun tabWebViewIdentifier(index: Int): String {
        val pagePath = appConfig.app.tabBar?.list?.getOrNull(index)?.pagePath ?: "unknown"
        return "tab_${miniProgram.appId}_${index}_${pagePath}"
    }

    fun setNavigationBarTitle(title: String) {
        navigationBarTitle.value = title
    }

    fun setNavigationBarColor(frontColor:String, backgroundColor: String) {
        updateActionColorStyle(frontColor)
        navigationBarBackgroundColor.value = backgroundColor
    }

    /**
     * 设置状态栏样式
     */
    private fun updateActionColorStyle(color: String) {
        val isWhiteTextStyle = isWhiteNavigationTextStyle(color)
        if (isWhiteTextStyle) {
            navigationBarTextColor.value = Color.White
        } else {
            navigationBarTextColor.value = Color.Black
        }
        runOnUiThread {
            WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars =
                !isWhiteTextStyle
        }
    }

    fun pageScrollTo(scrollTop: Int, duration: Int) {
        val targetWebView = getWebViewForBridge(apiBridgeContext)
        val runScroll: (WebView) -> Unit = { webView ->
            try {
                if (duration > 0) {
                    // Get current scroll position
                    runOnUiThread {
                        val startScroll = webView.scrollY
                        val distance = scrollTop - startScroll

                        // Create and configure the animator
                        ValueAnimator.ofFloat(0f, 1f).apply {
                            this.duration = duration.toLong()
                            interpolator =
                                AccelerateDecelerateInterpolator() // Smooth ease-in-out effect

                            addUpdateListener { animation ->
                                val fraction = animation.animatedValue as Float
                                val newScroll = startScroll + (distance * fraction).toInt()
                                webView.scrollTo(0, newScroll)
                            }

                            addListener(object : AnimatorListenerAdapter() {
                                override fun onAnimationEnd(animation: Animator) {
                                    LogUtils.d(
                                        tag,
                                        "Scroll animation completed to position: $scrollTop"
                                    )
                                }
                            })

                            start()
                        }
                    }
                } else {
                    // Immediate scroll without animation
                    webView.scrollTo(0, scrollTop)
                    LogUtils.d(tag, "Immediate scroll to position: $scrollTop")
                }
            } catch (e: Exception) {
                LogUtils.e(tag, "Error during page scroll: ${e.message}")
            }
        }
        if (targetWebView != null) {
            runScroll(targetWebView)
        } else {
            withWebView(runScroll)
        }
    }


    /**
     * Reads and parses the app-config.json file from the extracted mini program
     * @return The AppConfig containing the app configuration, or null if failed
     */
    private fun readAppConfig(target: String, root: String = "main"): AppConfig? {
        try {
            // Check both possible locations for app-config.json
            val miniProgramDir = File(filesDir, target)
            var configFile = File(miniProgramDir, "${root}/app-config.json")

            // If not found in main/app-config.json, try app-config.json directly
            if (!configFile.exists()) {
                configFile = File(miniProgramDir, "app-config.json")
                if (!configFile.exists()) {
                    // Log the directory structure to help debug
                    LogUtils.e(tag, "app-config.json not found in the package")
                    logDirectoryStructure(miniProgramDir)
                    return null
                }
            }

            // Parse the JSON file
            val appConfigContent = configFile.readText()
            val json = Json { ignoreUnknownKeys = true }
            return json.decodeFromString<AppConfig>(appConfigContent)

        } catch (e: IOException) {
            LogUtils.e(tag, "Error reading app config: ${e.message}")
            e.printStackTrace()
            return null
        } catch (e: Exception) {
            LogUtils.e(tag, "Unexpected error reading config: ${e.message}")
            e.printStackTrace()
            return null
        }
    }

    /**
     * Helper method to log the directory structure for debugging
     */
    private fun logDirectoryStructure(directory: File, indent: String = "") {
        LogUtils.d(tag, "${indent}Directory: ${directory.name}")
        directory.listFiles()?.forEach { file ->
            if (file.isDirectory) {
                logDirectoryStructure(file, "$indent  ")
            } else {
                LogUtils.d(tag, "$indent  File: ${file.name} (${file.length()} bytes)")
            }
        } ?: LogUtils.d(tag, "${indent}Empty or not a directory")
    }

    /**
     * 安全地执行WebView操作，如果WebView尚未初始化，则将操作添加到回调队列中
     * @param action 要在WebView上执行的操作
     * @return true如果操作立即执行，false如果操作被加入队列
     */
    private fun withWebView(action: (WebView) -> Unit): Boolean {
        if (useTabBarContainer.value) {
            val state = tabPageStates[selectedTabIndex.intValue]
            return state?.webView?.let {
                action(it)
                true
            } ?: run {
                if (state != null) {
                    state.webViewReadyCallbacks.add(action)
                } else {
                    webViewReadyCallbacks.add(action)
                }
                Log.w(tag, "Tab WebView not initialized yet, adding to callback queue")
                false
            }
        }
        return webView?.let {
            action(it)
            true
        } ?: run {
            Log.w(tag, "WebView not initialized yet, adding to callback queue")
            webViewReadyCallbacks.add(action)
            false
        }
    }

    private fun withWebViewPageLoaded(action: () -> Unit) {
        pageReadyCallback = action
    }

    private fun withTabWebViewPageLoaded(index: Int, action: () -> Unit) {
        tabPageStates[index]?.pageReadyCallback = action
    }

    /**
     * 当WebView初始化完成时调用此方法
     * @param webView 初始化完成的WebView实例
     */
    private fun onWebViewReady(webView: WebView) {
        this.webView = webView
        webView.setBackgroundColor(parseCssColor(backgroundColor.value).toArgb())
        bindNativeComponentHost()
        LogUtils.d(tag, "WebView is now initialized and ready")

        // 执行所有等待的回调
        val callbacks = ArrayList(webViewReadyCallbacks) // 创建副本以避免并发修改
        webViewReadyCallbacks.clear()

        callbacks.forEach { callback ->
            try {
                callback(webView)
                LogUtils.d(tag, "Executed queued WebView callback")
            } catch (e: Exception) {
                LogUtils.e(tag, "Error executing WebView callback: ${e.message}")
            }
        }
    }

    private fun onPageReady() {
        pageReadyCallback?.invoke()
    }

    private fun onTabWebViewReady(index: Int, webView: WebView) {
        val state = tabPageStates[index] ?: return
        state.webView = webView
        webView.setBackgroundColor(parseCssColor(state.configInfo.backgroundColor).toArgb())
        if (index == selectedTabIndex.intValue) {
            this.webView = webView
        }
        bindNativeComponentHost(index)
        LogUtils.d(tag, "Tab WebView is ready: index=$index")

        val callbacks = ArrayList(state.webViewReadyCallbacks)
        state.webViewReadyCallbacks.clear()
        callbacks.forEach { callback ->
            try {
                callback(webView)
                LogUtils.d(tag, "Executed queued tab WebView callback: index=$index")
            } catch (e: Exception) {
                LogUtils.e(tag, "Error executing tab WebView callback: ${e.message}")
            }
        }

        if (state.bridge == null) {
            val tabBridge = createBridge(
                BridgeOptions(
                    pathInfo = state.pathInfo,
                    scene = 1001,
                    jscore = miniApp.getJsCore(miniProgram.appId, this@DiminaActivity),
                    webview = webView,
                    isRoot = index == selectedTabIndex.intValue,
                    root = state.root,
                    appId = miniProgram.appId,
                    pages = appConfig.app.pages,
                    configInfo = state.configInfo
                ),
                setAsActive = index == selectedTabIndex.intValue
            )
            state.bridge = tabBridge
            miniApp.addBridge(miniProgram.appId, tabBridge)
            withTabWebViewPageLoaded(index) {
                if (!state.bridgeStarted) {
                    LogUtils.d(tag, "Tab page loaded, starting bridge: index=$index")
                    state.bridgeStarted = true
                    tabBridge.start()
                }
            }
        }

        if (index == selectedTabIndex.intValue) {
            activateTabState(index)
        }
    }

    private fun onTabPageReady(index: Int) {
        val state = tabPageStates[index] ?: return
        state.pageReadyCallback?.invoke()
    }

    private fun onNativeOverlayReady(overlay: FrameLayout) {
        nativeOverlay = overlay
        bindNativeComponentHost()
    }

    private fun onTabNativeOverlayReady(index: Int, overlay: FrameLayout) {
        val state = tabPageStates[index] ?: return
        state.nativeOverlay = overlay
        if (index == selectedTabIndex.intValue) {
            nativeOverlay = overlay
        }
        bindNativeComponentHost(index)
    }

    private fun bindNativeComponentHost() {
        val currentWebView = webView ?: return
        val overlay = nativeOverlay ?: return
        nativeComponentHost = NativeComponentHost(this, currentWebView, overlay)
    }

    private fun bindNativeComponentHost(index: Int) {
        val state = tabPageStates[index] ?: return
        val currentWebView = state.webView ?: return
        val overlay = state.nativeOverlay ?: return
        state.nativeComponentHost = NativeComponentHost(this, currentWebView, overlay)
        if (index == selectedTabIndex.intValue) {
            nativeComponentHost = state.nativeComponentHost
        }
    }

    fun <T> runWithBridgeContext(sourceBridge: Bridge, action: () -> T): T {
        val previousBridge = apiBridgeContext
        apiBridgeContext = sourceBridge
        return try {
            action()
        } finally {
            apiBridgeContext = previousBridge
        }
    }

    private fun getNativeComponentHostForBridge(sourceBridge: Bridge?): NativeComponentHost? {
        if (sourceBridge != null) {
            tabPageStates.values.firstOrNull { it.bridge === sourceBridge }?.nativeComponentHost?.let {
                return it
            }
            if (bridge === sourceBridge) {
                return nativeComponentHost
            }
        }
        return nativeComponentHost
    }

    fun handleNativeComponentAction(apiName: String, params: JSONObject): Boolean {
        return getNativeComponentHostForBridge(apiBridgeContext)?.handle(apiName, params) ?: false
    }

    fun dispatchNativeComponentTouch(params: JSONObject, sourceBridge: Bridge? = null): Boolean {
        return getNativeComponentHostForBridge(sourceBridge)?.dispatchTouchFromWeb(params) ?: false
    }

    fun clearNativeComponents(sourceBridge: Bridge? = null) {
        getNativeComponentHostForBridge(sourceBridge)?.clear()
    }

    private fun clearAllNativeComponents() {
        nativeComponentHost?.clear()
        tabPageStates.values.forEach { state ->
            state.nativeComponentHost?.clear()
        }
    }

    fun onDomReady() {
        // 6.隐藏加载动画
        LogUtils.d(
            tag,
            "Mini program initialization complete, hiding loading indicator"
        )
        isLoading.value = false
    }

    override fun onResume() {
        super.onResume()
        getActiveBridge()?.let {
            it.appShow()
            it.pageShow()
        }
    }

    override fun onPause() {
        getActiveBridge()?.let {
            it.appHide()
            it.pageHide()
        }
        super.onPause()
    }

    override fun onDestroy() {
        val bridgesToDestroy = buildList {
            bridge?.let { add(it) }
            tabPageStates.values.forEach { state ->
                state.bridge?.let { add(it) }
            }
        }.distinct()

        bridgesToDestroy.forEach { cBridge ->
            miniApp.removeBridge(miniProgram.appId, cBridge)?.destroy()
        }
        clearAllNativeComponents()

        if (miniApp.isBridgeListEmpty(miniProgram.appId)) {
            // Clear resources for this specific MiniProgram
            miniApp.clear(miniProgram.appId)
        } else if (miniApp.isBridgeListEmpty()) {
            miniApp.clearAll()
        }
        super.onDestroy()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    fun DiminaContent(
        miniProgram: MiniProgram,
        isLoading: State<Boolean>,
        modifier: Modifier = Modifier,
    ) {
        if (showActionSheet.value) {
            ActionSheet(
                buttonLabelsColor = actionTextColor,
                buttonLabels = actionSheetOptions,
                onButtonClick = { index ->
                    actionSheetCallback?.invoke(index)
                    showActionSheet.value = false
                },
                onDismiss = {
                    actionSheetCallback?.invoke(-1)
                    showActionSheet.value = false
                }
            )
        }
        if (showMiniProgramMenu.value) {
            MiniProgramMenuSheet(
                appName = miniProgram.name.ifBlank {
                    navigationBarTitle.value.ifBlank { "小程序" }
                },
                onReenterClick = {
                    showMiniProgramMenu.value = false
                    reenterMiniProgram()
                },
                onCloseClick = {
                    showMiniProgramMenu.value = false
                    closeMiniProgram()
                },
                onDismiss = {
                    showMiniProgramMenu.value = false
                }
            )
        }
        MediaPickerRoot(
            type = mediaType.value,
            maxCount = maxImageCount.intValue,
            context = this,
            onSelected = { uris ->
                // Convert URIs to file paths
                val paths =
                    uris.mapNotNull { uri -> PathUtils.uriToTempFile(this@DiminaActivity, uri) }
                // Invoke the callback with the selected image paths
                imageChooseCallback?.invoke(paths)
                // Reset the callback and hide the picker
                imageChooseCallback = null
                mediaType.value = MediaType.NONE
            },
        )
        // Convert color strings to Color objects
        val bgColor = parseCssColor(backgroundColor.value)

        val navBarBgColor = parseCssColor(navigationBarBackgroundColor.value)
        val isCustomNavigation = !showNavigationBar.value
        val tabBarConfig = tabBarConfigState.value
        val shouldShowTabBar = !isLoading.value && tabBarConfig != null && getTabBarIndex(currentPagePath.value) >= 0
        val statusBarHeight = ComposeWindowInsets.statusBars.asPaddingValues().calculateTopPadding()

        Box(modifier = modifier.fillMaxSize()) {
            Scaffold(
                topBar = {
                    // Only show the navigation bar when not loading and showNavigationBar is true
                    if (!isLoading.value && showNavigationBar.value) {
                        CenterAlignedTopAppBar(
                            title = {
                                Text(
                                    text = navigationBarTitle.value,
                                    style = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.Bold, color = navigationBarTextColor.value)
                                )
                            },
                            colors = TopAppBarDefaults.topAppBarColors(
                                containerColor = navBarBgColor
                            ),
                            navigationIcon = {
                                IconButton(onClick = { finish() }) {
                                    Icon(
                                        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowLeft,
                                        contentDescription = "Back",
                                        tint = navigationBarTextColor.value,
                                        modifier = Modifier.size(30.dp)
                                    )
                                }
                            },
                            actions = {
                                Spacer(modifier = Modifier.width(97.dp))
                            }
                        )
                    }
                },
                modifier = Modifier.fillMaxSize(),
                containerColor = bgColor
            ) { innerPadding ->
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(
                            top = if (isCustomNavigation) 0.dp else innerPadding.calculateTopPadding()
                        )
                        .background(bgColor)
                ) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                    ) {
                        if (useTabBarContainer.value) {
                            loadedTabIndices.value.sorted().forEach { tabIndex ->
                                key(tabIndex) {
                                    val isSelected = tabIndex == selectedTabIndex.intValue
                                    DiminaWebView(
                                        onInitReady = { webView -> onTabWebViewReady(tabIndex, webView) },
                                        onPageCompleted = { onTabPageReady(tabIndex) },
                                        onNativeOverlayReady = { overlay ->
                                            onTabNativeOverlayReady(tabIndex, overlay)
                                        },
                                        identifier = tabWebViewIdentifier(tabIndex),
                                        modifier = Modifier
                                            .fillMaxSize()
                                            .alpha(if (isSelected) 1f else 0f)
                                            .zIndex(if (isSelected) 1f else 0f)
                                    )
                                }
                            }
                        } else {
                            // 始终创建DiminaWebView
                            DiminaWebView(
                                onInitReady = { webView -> onWebViewReady(webView) },
                                onPageCompleted = { onPageReady() },
                                onNativeOverlayReady = { overlay -> onNativeOverlayReady(overlay) },
                            )
                        }

                        // 加载遮罩层使用 AnimatedVisibility 只添加淡出效果
                        androidx.compose.animation.AnimatedVisibility(
                            visible = isLoading.value && miniProgram.root,
                            exit = fadeOut(animationSpec = tween(300)),
                            modifier = Modifier.fillMaxSize()
                        ) {
                            LoadingAnimation(miniProgram)
                        }
                    }

                    tabBarConfig?.takeIf { shouldShowTabBar }?.let { visibleTabBarConfig ->
                        DiminaTabBar(
                            tabBarConfig = visibleTabBarConfig,
                            selectedIndex = selectedTabIndex.intValue,
                            appId = miniProgram.appId,
                            filesDir = filesDir,
                            onSelected = { index ->
                                visibleTabBarConfig.list.getOrNull(index)?.let { item ->
                                    switchTab(item.pagePath)
                                }
                            },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }

            if (!isCustomNavigation) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopStart)
                        .fillMaxWidth()
                        .height(statusBarHeight)
                        .background(navBarBgColor)
                )
            }

            if (!isLoading.value) {
                val menuRect = remember { Utils.getMenuButtonBoundingClientRect(this@DiminaActivity) }
                MiniProgramCapsuleButton(
                    onMoreClick = {
                        showMiniProgramMenu.value = true
                    },
                    onCloseClick = { closeMiniProgram() },
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(
                            top = menuRect.optInt("top", Utils.getStatusBarHeight(this@DiminaActivity)).dp,
                            end = (Utils.getMiniProgramSystemInfo(this@DiminaActivity)
                                .optInt("windowWidth") - menuRect.optInt("right", 0)).dp
                        )
                        .zIndex(10f)
                )
            }
        }
    }

    private fun closeMiniProgram() {
        val closeIntent = Intent(this, DiminaActivity::class.java).apply {
            putExtra(MINI_PROGRAM_KEY, miniProgram.copy(root = true))
            putExtra(CLOSE_MINI_PROGRAM_KEY, true)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(closeIntent)
        finish()
    }

    private fun reenterMiniProgram() {
        val entryPagePath = getDefaultEntryPagePath() ?: miniProgram.path
        DiminaActivity.launch(
            this,
            miniProgram.copy(root = true, path = entryPagePath),
            Intent.FLAG_ACTIVITY_CLEAR_TOP
        )
    }

    fun applyUpdate() {
        val entryPagePath = getDefaultEntryPagePath() ?: miniProgram.path
        val updatedMiniProgram = miniProgram.copy(root = true, path = entryPagePath)
        miniApp.clear(miniProgram.appId)
        val intent = Intent(this, DiminaActivity::class.java).apply {
            putExtra(MINI_PROGRAM_KEY, updatedMiniProgram)
            putExtra(APPLY_UPDATE_RESTART_KEY, true)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        startActivity(intent)
    }

    private fun getDefaultEntryPagePath(): String? {
        if (!::appConfig.isInitialized) {
            return null
        }
        return appConfig.app.entryPagePath ?: appConfig.app.pages.firstOrNull()
    }

    @OptIn(ExperimentalMaterial3Api::class)
    @Composable
    private fun MiniProgramMenuSheet(
        appName: String,
        onReenterClick: () -> Unit,
        onCloseClick: () -> Unit,
        onDismiss: () -> Unit
    ) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
            shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp),
            containerColor = Color.White,
            dragHandle = { }
        ) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 20.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Box(
                        modifier = Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(22.dp))
                            .background(Color(0xFFF4F4F4)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = appName.take(1).ifBlank { "小" },
                            fontSize = 18.sp,
                            color = Color(0xFF8A8A8A),
                            fontWeight = FontWeight.Medium
                        )
                    }
                    Column(modifier = Modifier.padding(start = 14.dp)) {
                        Text(
                            text = appName,
                            fontSize = 18.sp,
                            color = Color(0xFF202020),
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = "小程序",
                            fontSize = 14.sp,
                            color = Color(0xFF9A9A9A)
                        )
                    }
                }

                HorizontalDivider(color = Color(0xFFF2F2F2), thickness = 1.dp)

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp, vertical = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    MiniProgramMenuItem(
                        label = "重新进入\n小程序",
                        onClick = onReenterClick,
                        modifier = Modifier.width(78.dp)
                    ) {
                        ReenterMenuIcon()
                    }
                    MiniProgramMenuItem(
                        label = "关闭小程序",
                        onClick = onCloseClick,
                        modifier = Modifier.width(78.dp)
                    ) {
                        CloseMenuIcon()
                    }
                }

                HorizontalDivider(color = Color(0xFFEDEDED), thickness = 1.dp)
                Text(
                    text = "取消",
                    fontSize = 18.sp,
                    color = Color(0xFF576B95),
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable(onClick = onDismiss)
                        .padding(vertical = 18.dp)
                )
            }
        }
    }

    @Composable
    private fun MiniProgramMenuItem(
        label: String,
        onClick: () -> Unit,
        modifier: Modifier = Modifier,
        icon: @Composable () -> Unit
    ) {
        Column(
            modifier = modifier.clickable(onClick = onClick),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Box(
                modifier = Modifier
                    .size(52.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(Color(0xFFF8F8F8)),
                contentAlignment = Alignment.Center
            ) {
                icon()
            }
            Text(
                text = label,
                fontSize = 13.sp,
                color = Color(0xFF686868),
                textAlign = TextAlign.Center,
                lineHeight = 17.sp,
                modifier = Modifier.padding(top = 8.dp)
            )
        }
    }

    @Composable
    private fun ReenterMenuIcon() {
        Text(
            text = "↻",
            fontSize = 24.sp,
            lineHeight = 24.sp,
            color = Color(0xFF333333),
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center
        )
    }

    @Composable
    private fun CloseMenuIcon() {
        Text(
            text = "×",
            fontSize = 24.sp,
            lineHeight = 24.sp,
            color = Color(0xFF333333),
            fontWeight = FontWeight.Normal,
            textAlign = TextAlign.Center
        )
    }

    @Composable
    private fun MiniProgramCapsuleButton(
        onMoreClick: () -> Unit,
        onCloseClick: () -> Unit,
        modifier: Modifier = Modifier
    ) {
        val foreground = Color(0xFF1F1F1F)
        val borderColor = Color(0xFFE5E5E5)
        val separatorColor = Color(0xFFE9E9E9)
        val shape = RoundedCornerShape(16.dp)

        Box(
            modifier = modifier
                .size(width = 87.dp, height = 32.dp)
                .shadow(1.dp, shape, clip = false)
                .clip(shape)
                .background(Color.White)
                .border(BorderStroke(0.5.dp, borderColor), shape)
        ) {
            Row(
                modifier = Modifier.fillMaxSize(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(width = 43.dp, height = 32.dp)
                        .clickable(onClick = onMoreClick),
                    contentAlignment = Alignment.Center
                ) {
                    Canvas(modifier = Modifier.size(width = 20.dp, height = 10.dp)) {
                        val centerY = size.height / 2
                        val gap = 7.2.dp.toPx()
                        val centerX = size.width / 2
                        drawCircle(foreground, 1.9.dp.toPx(), Offset(centerX - gap, centerY))
                        drawCircle(foreground, 3.2.dp.toPx(), Offset(centerX, centerY))
                        drawCircle(foreground, 1.9.dp.toPx(), Offset(centerX + gap, centerY))
                    }
                }

                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .height(16.dp)
                        .align(Alignment.CenterVertically)
                        .background(separatorColor)
                )

                Box(
                    modifier = Modifier
                        .size(width = 43.dp, height = 32.dp)
                        .clickable(onClick = onCloseClick),
                    contentAlignment = Alignment.Center
                ) {
                    Canvas(modifier = Modifier.size(22.dp)) {
                        val center = Offset(size.width / 2, size.height / 2)
                        drawCircle(
                            color = foreground,
                            radius = 7.8.dp.toPx(),
                            center = center,
                            style = Stroke(width = 2.4.dp.toPx())
                        )
                        drawCircle(
                            color = foreground,
                            radius = 3.1.dp.toPx(),
                            center = center
                        )
                    }
                }
            }
        }
    }

    @Composable
    fun LoadingAnimation(miniProgram: MiniProgram) {
        // 使用 remember 记忆颜色值，避免每次重组时重新创建
        val iconColor = remember { Color(Utils.generateColorFromName(miniProgram.name)) }
        val trackColor = remember { Color.LightGray.copy(alpha = 0.3f) }
        val dotColor = remember { Color(0xFF4CAF50) }
        val firstLetter = remember { miniProgram.name.substring(0, 1) }

        // 使用 InfiniteTransition 创建无限循环动画
        val infiniteTransition = rememberInfiniteTransition(label = "loadingRotation")
        val rotation by infiniteTransition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = tween(
                    durationMillis = 1000,
                    easing = LinearEasing
                ),
                repeatMode = RepeatMode.Restart
            ),
            label = "rotation"
        )

        // 添加背景的Box作为遮罩层
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(Color.White), // 添加背景遮住后面的 Webview
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
                Box(
                    modifier = Modifier.size(80.dp),
                    contentAlignment = Alignment.Center
                ) {
                    val dotRadiusDp = 4.dp

                    Canvas(
                        modifier = Modifier.fillMaxSize()
                    ) {
                        // 预计算常量值，避免在绘制时重复计算
                        val minSize = minOf(size.width, size.height)
                        val circleRadius = minSize / 4
                        val centerX = size.width / 2
                        val centerY = size.height / 2
                        val orbitRadius = circleRadius * 1.5f
                        val dotRadius = dotRadiusDp.toPx()

                        // 绘制大圆（背景）
                        drawCircle(
                            color = iconColor,
                            radius = circleRadius,
                            center = Offset(centerX, centerY)
                        )

                        // 绘制轨道
                        drawCircle(
                            color = trackColor,
                            radius = orbitRadius,
                            center = Offset(centerX, centerY),
                            style = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.dp.toPx())
                        )

                        // 绘制小圆点（旋转）- 只有这部分需要在每一帧更新
                        val angleInRadians = Math.toRadians(rotation.toDouble()).toFloat()
                        val dotX = centerX + orbitRadius * cos(angleInRadians)
                        val dotY = centerY + orbitRadius * sin(angleInRadians)

                        drawCircle(
                            color = dotColor,
                            radius = dotRadius,
                            center = Offset(dotX, dotY)
                        )
                    }

                    Text(
                        text = firstLetter,
                        color = Color.White,
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.align(Alignment.Center)
                    )
                }
                // 底部文本
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = miniProgram.name,
                    style = TextStyle(
                        fontSize = 16.sp,
                        color = Color.Black,
                        fontWeight = FontWeight.Medium
                    )
                )
            }
        }
    }

    /**
     * 更新当前页面的路径并重新加载
     * @param url 新的页面路径
     */
    fun updatePath(url: String) {
        runOnUiThread {
            // 获取当前的 bridge
            getActiveBridge()?.let { currentBridge ->
                val activeTabIndex = if (useTabBarContainer.value) selectedTabIndex.intValue else -1
                val activeTabState = tabPageStates[activeTabIndex]
                val pathInfo = Utils.queryPath(url)
                val pageConfig = appConfig.modules[pathInfo.pagePath]
                val mergedPageConfig = Utils.mergePageConfig(appConfig.app, pageConfig)

                // 更新页面配置和样式
                syncTabBarState(pathInfo.pagePath)
                setInitialStyle(mergedPageConfig)
                activeTabState?.let { state ->
                    state.pathInfo = pathInfo
                    state.root = pageConfig?.root ?: "main"
                    state.configInfo = mergedPageConfig
                    state.bridgeStarted = false
                }

                currentBridge.destroy(true)
                // 更新当前 bridge 的配置
                currentBridge.updateOptions(
                    pathInfo = pathInfo,
                    root = pageConfig?.root ?: "main",
                    configInfo = mergedPageConfig
                )
                currentBridge.init(false)
                if (activeTabState != null && activeTabIndex >= 0) {
                    withTabWebViewPageLoaded(activeTabIndex) {
                        if (!activeTabState.bridgeStarted) {
                            LogUtils.d(tag, "Tab page loaded, restarting bridge: index=$activeTabIndex")
                            activeTabState.bridgeStarted = true
                            currentBridge.start()
                        }
                    }
                } else {
                    withWebViewPageLoaded {
                        LogUtils.d(tag, "Page loaded, restarting bridge")
                        currentBridge.start()
                    }
                }
            }
        }
    }

    fun getMiniProgram(): MiniProgram {
        return this.miniProgram
    }

    companion object {
        const val MINI_PROGRAM_KEY = "mini_program"
        private const val CLOSE_MINI_PROGRAM_KEY = "close_mini_program"
        private const val APPLY_UPDATE_RESTART_KEY = "apply_update_restart"

        fun launch(
            context: Context,
            miniProgram: MiniProgram,
            flag: Int? = null,
        ) {
            val intent = Intent(context, DiminaActivity::class.java).apply {
                putExtra(MINI_PROGRAM_KEY, miniProgram)
                flag?.let {
                    addFlags(flag)
                }
            }
            context.startActivity(intent)
        }
    }
}
