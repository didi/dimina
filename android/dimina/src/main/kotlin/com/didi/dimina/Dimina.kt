package com.didi.dimina

import android.app.Activity
import android.content.Context
import android.graphics.Color
import androidx.annotation.ColorInt
import androidx.annotation.MainThread
import com.didi.dimina.api.ext.ExtModuleHandler
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.StoreUtils
import com.didi.dimina.core.MiniApp
import com.didi.dimina.core.RemoteUpdateManager
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Author: Doslin
 */
class Dimina private constructor(context: Context) {
    // 伴生对象用于实现单例模式和提供初始化入口
    companion object {
        @Volatile
        private var instance: Dimina? = null

        /**
         * 初始化 SDK
         * @param context 应用上下文
         * @param config 配置参数
         * @return Dimina 实例
         */
        fun init(context: Context, config: DiminaConfig): Dimina {
            return instance ?: synchronized(this) {
                instance ?: Dimina(context.applicationContext).also { instance = it }.apply {
                    // 应用配置
                    applyConfig(config)
                }
            }
        }

        /**
         * 获取 Dimina 实例
         * @throws IllegalStateException 如果尚未初始化
         */
        fun getInstance(): Dimina {
            return instance ?: throw IllegalStateException("Dimina SDK not initialized. Please call init() first.")
        }
    }

    // 配置类
    class DiminaConfig private constructor(builder: Builder) {
        val showCapsule: Boolean = builder.showCapsule
        @ColorInt val capsuleBackgroundColor: Int = builder.capsuleBackgroundColor
        @ColorInt val capsuleIconColor: Int = builder.capsuleIconColor
        val enableMultiTask: Boolean = builder.enableMultiTask
        val showLaunchLoading: Boolean = builder.showLaunchLoading
        val debugMode: Boolean = builder.debugMode
        val apiNamespaces: List<String> = builder.apiNamespaces
        val virtualFilePrefix: String = builder.virtualFilePrefix

        class Builder {
            var enableMultiTask: Boolean = true
            fun setEnableMultiTask(enable: Boolean): Builder { enableMultiTask = enable; return this }

            var showLaunchLoading: Boolean = true
            fun setShowLaunchLoading(show: Boolean): Builder { showLaunchLoading = show; return this }

            var showCapsule: Boolean = true
            fun setShowCapsule(show: Boolean): Builder { showCapsule = show; return this }

            @ColorInt
            internal var capsuleBackgroundColor: Int = Color.WHITE
                private set

            /** Sets the capsule fill to an ARGB color. Configure before [Dimina.init]. */
            fun setCapsuleBackgroundColor(@ColorInt color: Int): Builder {
                capsuleBackgroundColor = color
                return this
            }

            @ColorInt
            internal var capsuleIconColor: Int = 0xFF1F1F1F.toInt()
                private set

            /** Sets both capsule icons to an ARGB color. Configure before [Dimina.init]. */
            fun setCapsuleIconColor(@ColorInt color: Int): Builder {
                capsuleIconColor = color
                return this
            }

            var debugMode: Boolean = false
            internal var apiNamespaces: MutableList<String> = mutableListOf()
            internal var virtualFilePrefix: String = PathUtils.DEFAULT_VIRTUAL_DOMAIN_URL

            fun setDebugMode(debugMode: Boolean): Builder {
                this.debugMode = debugMode
                return this
            }

            fun addApiNamespace(name: String): Builder {
                apiNamespaces.add(name)
                return this
            }

            /**
             * Configure the virtual file URI scheme used by both native path resolution and
             * the service JavaScript runtime. Call this before [Dimina.init].
             */
            fun setVirtualFilePrefix(prefix: String): Builder {
                virtualFilePrefix = PathUtils.normalizeVirtualFilePrefix(prefix)
                return this
            }

            fun build(): DiminaConfig {
                return DiminaConfig(this)
            }
        }
    }

    /**
     * 检查宿主是否显式启用调试模式，与 SDK AAR 的构建类型无关。
     * @return 是否为调试模式
     */
    fun isDebugMode(): Boolean {
        return config.debugMode
    }

    @MainThread
    fun configureRetention(policy: com.didi.dimina.core.RetentionPolicy) {
        MiniApp.getInstance().configureRetention(policy)
    }

    /** Hosts may forward their own pressure source here as well. */
    fun notifyMemoryPressure() { MiniApp.getInstance().notifyMemoryPressure() }

    fun getApiNamespaces(): List<String> = config.apiNamespaces

    private val appContext: Context = context
    private val operationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var config: DiminaConfig

    init {
        // 基础初始化逻辑
        setupCoreComponents()
    }

    // 初始化核心组件
    private fun setupCoreComponents() {
        StoreUtils.initialize(context = appContext)
        appContext.registerComponentCallbacks(object : android.content.ComponentCallbacks2 {
            override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {}
            override fun onLowMemory() { notifyMemoryPressure() }
            override fun onTrimMemory(level: Int) {
                if (level == android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW ||
                    level == android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL ||
                    level >= android.content.ComponentCallbacks2.TRIM_MEMORY_BACKGROUND) {
                    notifyMemoryPressure()
                }
            }
        })
    }

    // 应用配置
    private fun applyConfig(config: DiminaConfig) {
        // 存储配置到类属性
        this.config = config
        PathUtils.configureVirtualFilePrefix(config.virtualFilePrefix)

		// Debugging is explicitly controlled by the host, including with a release AAR.
		LogUtils.initialize(isDebugMode())
    }

    /**
     * 启动小程序
     * @param context 上下文
     * @param miniProgram 要启动的小程序对象
     */
    fun startMiniProgram(context: Activity, miniProgram: MiniProgram) {
        val miniApp = MiniApp.getInstance()
        miniApp.openApp(context, miniProgram)
    }

    /** Hide an app while retaining its page stack and runtime for the next startMiniProgram. */
    @MainThread
    fun hideMiniProgram(appId: String): Boolean {
        val normalizedAppId = appId.trim()
        if (normalizedAppId.isEmpty()) return false
        return DiminaActivity.hideMiniProgramFromHost(normalizedAppId)
    }

    /**
     * Requests a normal mini-program exit from the host application.
     *
     * The request is routed through the top Activity's exit path so lifecycle ordering and a
     * possible opener mini program are preserved. The method must be called on the main thread.
     *
     * @return `true` when a running Activity accepted the request, or `false` when [appId] is
     * blank or no Activity is currently registered for it.
     */
    @MainThread
    fun closeMiniProgram(appId: String): Boolean {
        val normalizedAppId = appId.trim()
        if (normalizedAppId.isEmpty()) return false
        return DiminaActivity.closeMiniProgramFromHost(normalizedAppId)
    }

    /** Destroy every foreground/background instance, preserving installed packages and user data.
     * Call on the main thread. Stop issuing launches before calling this API.
     */
    @MainThread
    fun destroyAllMiniPrograms() {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            "destroyAllMiniPrograms must run on the main thread"
        }
        DiminaActivity.destroyAllMiniProgramsFromHost()
        MiniApp.getInstance().clearAll()
    }

    fun isMultiTaskEnabled(): Boolean = config.enableMultiTask

    fun shouldShowLaunchLoading(): Boolean = config.showLaunchLoading

    fun shouldShowCapsule(): Boolean = config.showCapsule

    @ColorInt
    internal fun getCapsuleBackgroundColor(): Int = config.capsuleBackgroundColor

    internal fun getCapsuleIconColor(): Int = config.capsuleIconColor

    /** Queries installed disk contents, not whether a runtime is currently alive. */
    fun isExistsApp(appId: String): Boolean = getAppVersionInfo(appId) != null

    fun getAppVersionInfo(appId: String): org.json.JSONObject? =
        RemoteUpdateManager.getAppVersionInfo(appContext, appId.trim())

    /** Installs a Dimina ZIP containing config.json and main/. Keeps the source ZIP and user data. */
    fun installMiniProgram(appId: String, packagePath: String,
        completion: (Result<org.json.JSONObject>) -> Unit) {
        val normalizedAppId = appId.trim()
        try {
            RemoteUpdateManager.beginUninstall(normalizedAppId)
        } catch (error: Throwable) {
            completion(Result.failure(error))
            return
        }
        operationScope.launch {
            val result = runCatching {
                withContext(Dispatchers.Main.immediate) {
                    DiminaActivity.closeForUninstall(normalizedAppId)
                    MiniApp.getInstance().clear(normalizedAppId)
                }
                RemoteUpdateManager.installLocalPackage(appContext, normalizedAppId, packagePath)
            }
            RemoteUpdateManager.endUninstall(normalizedAppId)
            withContext(Dispatchers.Main.immediate) { completion(result) }
        }
    }

    /**
     * Stops and uninstalls one mini program without clearing persistent user data by default.
     * Bundled packages are restored from the host application the next time they are launched.
     */
    fun uninstallMiniProgram(
        appId: String,
        clearUserData: Boolean = false,
        completion: (Result<Unit>) -> Unit = {},
    ) {
        val normalizedAppId = appId.trim()
        try {
            RemoteUpdateManager.beginUninstall(normalizedAppId)
        } catch (error: Throwable) {
            completion(Result.failure(error))
            return
        }

        operationScope.launch {
            val result = runCatching {
                withContext(Dispatchers.Main.immediate) {
                    DiminaActivity.closeForUninstall(normalizedAppId)
                    MiniApp.getInstance().clear(normalizedAppId)
                }
                RemoteUpdateManager.uninstallPackage(
                    context = appContext,
                    appId = normalizedAppId,
                    clearUserData = clearUserData,
                )
            }
            RemoteUpdateManager.endUninstall(normalizedAppId)
            withContext(Dispatchers.Main.immediate) {
                completion(result)
            }
        }
    }

    /**
     * 注册第三方扩展 bridge 模块。
     *
     * 小程序通过 `wx.extBridge` / `wx.extOnBridge` / `wx.extOffBridge` 与 native 模块通信，
     * 宿主通过此方法向框架注册对应的处理器。建议在 [init] 之后、[startMiniProgram] 之前调用。
     *
     * 示例：
     * ```kotlin
     * Dimina.getInstance().registerExtModule("MyModule") { event, data, callback ->
     *     when (event) {
     *         "doSomething" -> {
     *             // 一次性调用
     *             callback.onSuccess(JSONObject().apply { put("result", 42) })
     *             null
     *         }
     *         "onDataChange" -> {
     *             // 持续订阅，返回取消函数
     *             val listener = registerListener { res -> callback.onSuccess(res) }
     *             Runnable { unregisterListener(listener) }
     *         }
     *         else -> { callback.onFail(JSONObject().apply { put("errMsg", "unknown event") }); null }
     *     }
     * }
     * ```
     *
     * @param moduleName 模块名，与小程序侧 `module` 参数一致
     * @param handler    处理器，参见 [ExtModuleHandler]
     */
    fun registerExtModule(moduleName: String, handler: ExtModuleHandler) {
        MiniApp.getInstance().registerExtModule(moduleName, handler)
    }
}
