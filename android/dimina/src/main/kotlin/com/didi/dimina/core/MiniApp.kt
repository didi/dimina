package com.didi.dimina.core

import android.app.Activity
import android.content.Context
import com.didi.dimina.Dimina
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.SyncResult
import com.didi.dimina.api.ext.ExtModuleHandler
import com.didi.dimina.api.base.AppEventApi
import com.didi.dimina.api.base.BaseAPI
import com.didi.dimina.api.base.SystemApi
import com.didi.dimina.api.base.UpdateApi
import com.didi.dimina.api.file.FileApi
import com.didi.dimina.api.device.ClipboardApi
import com.didi.dimina.api.device.BluetoothApi
import com.didi.dimina.api.device.ContactApi
import com.didi.dimina.api.device.KeyboardApi
import com.didi.dimina.api.device.PhoneApi
import com.didi.dimina.api.device.ScanApi
import com.didi.dimina.api.device.VibrateAPI
import com.didi.dimina.api.media.ImageApi
import com.didi.dimina.api.media.VideoApi
import com.didi.dimina.api.network.LocalNetworkApi
import com.didi.dimina.api.route.RouteApi
import com.didi.dimina.api.storage.StorageApi
import com.didi.dimina.api.ui.InteractionApi
import com.didi.dimina.api.ui.MenuApi
import com.didi.dimina.api.ui.NavigationBarApi
import com.didi.dimina.api.ui.NativeComponentApi
import com.didi.dimina.api.ui.ScrollApi
import com.didi.dimina.api.ui.TabBarApi
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.BundledResourcePolicy
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.common.VersionUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * Author: Doslin
 *
 * MiniApp API architecture to handle container-side APIs like navigation, photo gallery, camera functionality, etc.
 * This class provides a centralized way to manage all API handlers and their callbacks.
 */
class MiniApp private constructor() {
    private val tag = "MiniApp"

    private val apiRegistry = ApiRegistry()
    private val bluetoothApi = BluetoothApi()
    private val localNetworkApi = LocalNetworkApi()
    private val updateCheckRegistry = UpdateCheckRegistry()

    // Map to store JsCore instances for each MiniProgram
    private val jsCoreMap = mutableMapOf<String, JsCore>()

    // Map to store Bridge instances for each MiniProgram
    private val bridgeListMap = mutableMapOf<String, MutableList<Bridge>>()

    // One-shot App.onShow options for a mini program revealed by navigateBackMiniProgram.
    private val pendingAppShowOptions = mutableMapOf<String, JSONObject>()

    companion object {
        @Volatile
        private var instance: MiniApp = MiniApp()

        fun getInstance(): MiniApp {
            return instance
        }
    }

    init {
        // Register API handlers that are common for all MiniPrograms
        registerApiHandlers()
    }

    /**
     * Open a MiniProgram in DiminaActivity
     *
     * @param miniProgram The MiniProgram to open
     */
    fun openApp(context: Activity, miniProgram: MiniProgram) {
        // Initialize or get JsCore for this MiniProgram
        getOrCreateJsCore(miniProgram.appId, context)

        DiminaActivity.launch(context, miniProgram)
    }

    @Synchronized
    fun setPendingAppShowOptions(appId: String, options: JSONObject) {
        pendingAppShowOptions[appId] = JSONObject(options.toString())
    }

    @Synchronized
    fun consumePendingAppShowOptions(appId: String): JSONObject? {
        return pendingAppShowOptions.remove(appId)
    }

    @Synchronized
    fun isRunning(appId: String): Boolean = jsCoreMap.containsKey(appId)

    /**
     * Get the JsCore instance for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @param context The context to use for initializing JsCore if needed
     * @return The JsCore instance for the MiniProgram
     */
    fun getJsCore(appId: String, context: Context? = null): JsCore {
        return getOrCreateJsCore(appId, context)
    }

    fun postUpdateStatus(appId: String, event: String) {
        jsCoreMap[appId]?.postMessage("onUpdateStatusChange", mapOf("event" to event))
    }

    fun startUpdateCheckIfNeeded(context: Context, miniProgram: MiniProgram) {
        if (!updateCheckRegistry.begin(miniProgram.appId)) {
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            RemoteUpdateManager.checkForUpdate(
                context = context.applicationContext,
                miniProgram = miniProgram,
                notify = { event -> postUpdateStatus(miniProgram.appId, event) },
            )
        }
    }

    /**
     * Get or create a JsCore instance for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @return The JsCore instance for the MiniProgram
     */
    private fun getOrCreateJsCore(appId: String, context: Context? = null): JsCore {
        return jsCoreMap.getOrPut(appId) {
            LogUtils.d(tag, "Creating new JsCore instance for appId: $appId")
            JsCore().apply {
                init { initialized ->
                    if (initialized) {
                        context?.let {
                            try {
                                // JSSDK has its own version and readiness state. Do not gate it on
                                // the host-app update marker: that marker is shared with jsapp and
                                // reading it mutates the value seen by the next resource initializer.
                                val jsConfigString =
                                    context.assets.open("jssdk/config.json").bufferedReader()
                                        .use { it.readText() }
                                val sdkObject = JSONObject(jsConfigString)
                                val newVersionCode = sdkObject.getInt("versionCode")
                                val versionName = sdkObject.getString("versionName")
                                val oldVersionCode = VersionUtils.getJSVersion()
                                val activeServiceFile = File(
                                    context.filesDir,
                                    "jssdk/$oldVersionCode/main/assets/service.js"
                                )
                                val shouldExtract = BundledResourcePolicy.shouldExtract(
                                    bundledVersion = newVersionCode,
                                    installedVersion = oldVersionCode,
                                    requiredResourcePresent = activeServiceFile.isFile,
                                )

                                if (shouldExtract) {
                                    LogUtils.d(tag, "Extracting bundled JSSDK: $versionName($newVersionCode)")
                                    if (Utils.unzipAssets(
                                            context,
                                            "jssdk/main.zip",
                                            "jssdk/$newVersionCode",
                                            requiredPaths = listOf(
                                                "main/assets/service.js",
                                                "main/pageFrame.html",
                                            ),
                                        )
                                    ) {
                                        VersionUtils.setJSVersion(newVersionCode)
                                        LogUtils.d(tag, "JSSDK updated successfully to version $versionName($newVersionCode)")
                                    } else {
                                        LogUtils.e(
                                            tag,
                                            "Failed to extract JSSDK: $versionName($newVersionCode)"
                                        )
                                    }
                                } else {
                                    LogUtils.d(tag, "JSSDK is already available: version=$oldVersionCode")
                                }
                                // Inject custom API namespaces before loading service.js
                                val namespaces = Dimina.getInstance().getApiNamespaces()
                                if (namespaces.isNotEmpty()) {
                                    val json = org.json.JSONArray(namespaces).toString()
                                    evaluate("globalThis.__diminaApiNamespaces = $json")
                                }
                                // 注入已注册的 API 名字，使 service 层的 wx 对象能枚举到它们
                                val registeredApis = getAvailableApis()
                                if (registeredApis.isNotEmpty()) {
                                    val apisJson = org.json.JSONArray(registeredApis).toString()
                                    evaluate("globalThis.__diminaRegisteredApis = $apisJson")
                                }

                                evaluateFromFile(
                                    File(
                                        context.filesDir.absolutePath,
                                        "jssdk/${VersionUtils.getJSVersion()}/main/assets/service.js"
                                    ).absolutePath
                                )
                                LogUtils.d(tag, "JsCore initialized for appId: $appId")
                            } catch (e: Exception) {
                                LogUtils.e(tag, "Error extracting js sdk: ${e.message}")
                            }
                        }
                    } else {
                        LogUtils.e(tag, "Failed to initialize JsCore for appId: $appId")
                    }
                }
            }
        }
    }

    /**
     * Registers all API handlers with the registry
     */
    private fun registerApiHandlers() {
        // base
        BaseAPI().registerWith(apiRegistry)
        SystemApi().registerWith(apiRegistry)
        UpdateApi().registerWith(apiRegistry)

        // device
        ClipboardApi().registerWith(apiRegistry)
        KeyboardApi().registerWith(apiRegistry)
        PhoneApi().registerWith(apiRegistry)
        ContactApi().registerWith(apiRegistry)
        com.didi.dimina.api.device.NetworkApi().registerWith(apiRegistry)
        VibrateAPI().registerWith(apiRegistry)
        ScanApi().registerWith(apiRegistry)
        bluetoothApi.registerWith(apiRegistry)

        // media
        ImageApi().registerWith(apiRegistry)
        VideoApi().registerWith(apiRegistry)

        // route
        RouteApi().registerWith(apiRegistry)

        // ui
        AppEventApi().registerWith(apiRegistry)
        InteractionApi().registerWith(apiRegistry)
        NavigationBarApi().registerWith(apiRegistry)
        ScrollApi().registerWith(apiRegistry)
        TabBarApi().registerWith(apiRegistry)
        MenuApi().registerWith(apiRegistry)
        NativeComponentApi().registerWith(apiRegistry)

        // network
        com.didi.dimina.api.network.NetworkApi().registerWith(apiRegistry)
        localNetworkApi.registerWith(apiRegistry)
        com.didi.dimina.api.network.WebSocketApi().registerWith(apiRegistry)

        // storage
        StorageApi().registerWith(apiRegistry)

        // file
        FileApi().registerWith(apiRegistry)
    }

    /**
     * 注册第三方扩展 bridge 模块。
     *
     * 宿主在 SDK 初始化后调用此方法，向框架注册 native 模块处理器。
     * 小程序侧通过 `wx.extBridge` / `wx.extOnBridge` / `wx.extOffBridge` 触发对应模块。
     *
     * @param moduleName 模块名，与 JS 侧 `module` 参数一致
     * @param handler    模块处理器，参见 [ExtModuleHandler]
     */
    fun registerExtModule(moduleName: String, handler: ExtModuleHandler) {
        apiRegistry.registerExtModule(moduleName, handler)
    }

    /**
     * Gets a set of all available API names from registered handlers
     *
     * @return Set of all available API names
     */
    fun getAvailableApis(): Set<String> {
        return apiRegistry.getRegisteredApiNames()
    }

    /**
     * Handles API invocation from JavaScript
     *
     * @param context The Activity context
     * @param apiName The name of the API to invoke
     * @param params Parameters for the API call
     * @param responseCallback Callback to send response back to JavaScript
     * @return True if API was successfully invoked, false otherwise
     */
    fun invokeAPI(
        appId: String,
        context: DiminaActivity,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): JSValue? {

        var isAsyncMethod = false
        var afterComplete: (() -> Unit)? = null
        var completeCarriesResult = false
        var callbackResult: JSONObject? = null
        try {
            LogUtils.d(tag, "Invoking API: $apiName with params: $params")

            // Invoke the API
            val result = apiRegistry.invoke(context, appId, apiName, params, responseCallback)
            if (result is AsyncResult) {
                isAsyncMethod = true
                afterComplete = result.afterComplete
                completeCarriesResult = result.completeCarriesResult
                callbackResult = result.value
                val errorMsg = result.value.optString("errMsg", "")
                if (errorMsg.isNotEmpty()) {
                    if (errorMsg.endsWith(":ok")) {
                        ApiUtils.invokeSuccess(params, result.value, responseCallback)
                    } else {
                        // API not found or invocation failed
                        ApiUtils.invokeFail(params, result.value, responseCallback)
                    }
                    return null
                }
            } else if (result is SyncResult) {
                return result.value
            }
        } catch (e: Exception) {
            // Collect all error information
            e.printStackTrace()
            LogUtils.e(tag, "Error invoking API: ${e.message}")
            if (isAsyncMethod) {
                val failureResult = JSONObject().apply {
                    put("errMsg", "$apiName:fail ${e.message}")
                }
                callbackResult = failureResult
                ApiUtils.invokeFail(params, failureResult, responseCallback)
            }
        } finally {
            if (isAsyncMethod) {
                ApiUtils.invokeComplete(
                    params,
                    responseCallback,
                    callbackResult.takeIf { completeCarriesResult },
                )
                afterComplete?.let { action ->
                    jsCoreMap[appId]?.postAfterMessages(action) ?: action()
                }
            }
        }
        return null
    }

    /**
     * Get the list of Bridge instances for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @return The list of Bridge instances for the MiniProgram
     */
    fun getBridgeList(appId: String): MutableList<Bridge> {
        return bridgeListMap.getOrPut(appId) { mutableListOf() }
    }

    /**
     * Add a Bridge instance for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @param bridge The Bridge instance to add
     */
    fun addBridge(appId: String, bridge: Bridge) {
        getBridgeList(appId).add(bridge)
        LogUtils.d(
            tag,
            "Added Bridge for appId: $appId, total bridges: ${getBridgeList(appId).size}"
        )
    }

    /**
     * Remove the Bridge instance for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @return The removed Bridge instance, or null if no Bridge was removed
     */
    fun removeBridge(appId: String, bridge: Bridge): Bridge? {
        val bridgeList = getBridgeList(appId)
        if (bridgeList.isEmpty()) return null

        val removedBridge = if (bridgeList.remove(bridge)) bridge else null
        LogUtils.d(tag, "Removed Bridge for appId: $appId, remaining bridges: ${bridgeList.size}")
        return removedBridge
    }

    /**
     * Check if there are any Bridge instances for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @return True if there are no Bridge instances, false otherwise
     */
    fun isBridgeListEmpty(appId: String): Boolean {
        return getBridgeList(appId).isEmpty()
    }

    fun isBridgeListEmpty(): Boolean {
        return bridgeListMap.isEmpty()
    }

    /**
     * Get the last Bridge instance for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram
     * @return The last Bridge instance, or null if there are no Bridge instances
     */
    fun getLastBridge(appId: String): Bridge? {
        return getBridgeList(appId).lastOrNull()
    }

    /**
     * Clears all API resources and callbacks for a specific MiniProgram
     *
     * @param appId The ID of the MiniProgram to clear resources for
     */
    fun clear(appId: String) {
        updateCheckRegistry.reset(appId)
        synchronized(this) {
            pendingAppShowOptions.remove(appId)
        }
        // Silently tear down this owner's WebSocket connections/timers/listeners first,
        // ahead of JsCore.destroy(), so no transport event can race into a dying JsCore.
        com.didi.dimina.api.network.WebSocketManager.shared.disposeOwner(appId)

        // 清理第三方扩展的持续订阅
        apiRegistry.clearExtSubscriptions(appId)
        bluetoothApi.clearApp(appId)
        localNetworkApi.clearApp(appId)

        // Detach this generation immediately so a rapid reopen creates a fresh runtime, but place
        // native engine destruction behind lifecycle messages already queued by Bridge.destroy().
        jsCoreMap.remove(appId)?.let { jsCore ->
            LogUtils.d(tag, "Scheduling JsCore destruction for appId: $appId")
            jsCore.destroyAfterMessages()
        }

        // Clear Bridge list for this appId
        bridgeListMap.remove(appId)?.let { bridges ->
            LogUtils.d(tag, "Removed ${bridges.size} bridges for appId: $appId")
        }
    }

    /**
     * Clears all API resources and callbacks for all MiniPrograms
     */
    fun clearAll() {
        updateCheckRegistry.resetAll()
        synchronized(this) {
            pendingAppShowOptions.clear()
        }
        // Silently tear down every owner's WebSocket state before destroying JsCore instances.
        com.didi.dimina.api.network.WebSocketManager.shared.disposeAll()

        // Detach every generation before scheduling its own FIFO-safe destruction.
        val jsCoresToDestroy = jsCoreMap.toMap()
        jsCoreMap.clear()
        jsCoresToDestroy.forEach { (appId, jsCore) ->
            LogUtils.d(tag, "Scheduling JsCore destruction for appId: $appId")
            jsCore.destroyAfterMessages()
        }

        // Clear all Bridge lists
        bridgeListMap.clear()
        LogUtils.d(tag, "Cleared all Bridge lists")
    }

    fun registerApi(handler: BaseApiHandler) {
        handler.registerWith(apiRegistry)
    }

    fun destroy() {
        // Clear API resources
        apiRegistry.clear()
    }
}
