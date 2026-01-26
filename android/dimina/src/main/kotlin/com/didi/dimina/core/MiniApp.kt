package com.didi.dimina.core

import android.app.Activity
import android.content.Context
import com.didi.dimina.Dimina
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.SyncResult
import com.didi.dimina.api.base.AppEventApi
import com.didi.dimina.api.base.BaseAPI
import com.didi.dimina.api.base.SystemApi
import com.didi.dimina.api.device.ClipboardApi
import com.didi.dimina.api.device.ContactApi
import com.didi.dimina.api.device.KeyboardApi
import com.didi.dimina.api.device.PhoneApi
import com.didi.dimina.api.device.ScanApi
import com.didi.dimina.api.device.VibrateAPI
import com.didi.dimina.api.media.ImageApi
import com.didi.dimina.api.media.VideoApi
import com.didi.dimina.api.route.RouteApi
import com.didi.dimina.api.storage.StorageApi
import com.didi.dimina.api.ui.InteractionApi
import com.didi.dimina.api.ui.MenuApi
import com.didi.dimina.api.ui.NavigationBarApi
import com.didi.dimina.api.ui.ScrollApi
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.common.VersionUtils
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
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

    // Map to store JsCore instances for each MiniProgram
    private val jsCoreMap = mutableMapOf<String, JsCore>()

    // Map to store Bridge instances for each MiniProgram
    private val bridgeListMap = mutableMapOf<String, MutableList<Bridge>>()

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
                                // 判断是否需要检测 JSSDK 的逻辑：调试模式或者 App 版本已更新
                                if (Dimina.getInstance().isDebugMode() || VersionUtils.isAppVersionUpdated(context)) {
                                    LogUtils.d(tag, "Checking for JSSDK updates...")
                                    val jsConfigString =
                                        context.assets.open("jssdk/config.json").bufferedReader()
                                            .use { it.readText() }
                                    val sdkObject = JSONObject(jsConfigString)
                                    val newVersionCode = sdkObject.getInt("versionCode")
                                    val versionName = sdkObject.getString("versionName")
                                    val oldVersionCode = VersionUtils.getJSVersion()
                                    if (newVersionCode > oldVersionCode) {
                                        LogUtils.d(tag, "JSSDK update found: $versionName($newVersionCode)")
                                        if (Utils.unzipAssets(
                                                context,
                                                "jssdk/main.zip",
                                                "jssdk/$newVersionCode",
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
                                        LogUtils.d(tag, "JSSDK is already up to date: $versionName($newVersionCode)")
                                    }
                                } else {
                                    LogUtils.d(tag, "Skipping JSSDK update check, last check was recent")
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

        // device
        ClipboardApi().registerWith(apiRegistry)
        KeyboardApi().registerWith(apiRegistry)
        PhoneApi().registerWith(apiRegistry)
        ContactApi().registerWith(apiRegistry)
        com.didi.dimina.api.device.NetworkApi().registerWith(apiRegistry)
        VibrateAPI().registerWith(apiRegistry)
        ScanApi().registerWith(apiRegistry)

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
        MenuApi().registerWith(apiRegistry)

        // network
        com.didi.dimina.api.network.NetworkApi().registerWith(apiRegistry)
        // ===== 添加UDP API注册 =====
        com.didi.dimina.api.udp.UdpApi().registerWith(apiRegistry)

        // storage
        StorageApi().registerWith(apiRegistry)
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
        try {
            LogUtils.d(tag, "Invoking API: $apiName with params: $params")

            // Invoke the API
            val result = apiRegistry.invoke(context, appId, apiName, params, responseCallback)
            if (result is AsyncResult) {
                isAsyncMethod = true
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
                ApiUtils.invokeFail(params,  JSONObject().apply {
                    put("errMsg", "$apiName:fail ${e.message}")
                }, responseCallback)
            }
        } finally {
            if (isAsyncMethod) {
                ApiUtils.invokeComplete(params, responseCallback)
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
        // Clear JsCore for this appId
        jsCoreMap[appId]?.let { jsCore ->
            LogUtils.d(tag, "Destroying JsCore for appId: $appId")
            jsCore.destroy()
            jsCoreMap.remove(appId)
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
        // Destroy all JsCore instances
        jsCoreMap.forEach { (appId, jsCore) ->
            LogUtils.d(tag, "Destroying JsCore for appId: $appId")
            jsCore.destroy()
        }
        jsCoreMap.clear()

        // Clear all Bridge lists
        bridgeListMap.clear()
        LogUtils.d(tag, "Cleared all Bridge lists")
    }

    fun destroy() {
        // Clear API resources
        apiRegistry.clear()
    }
}


