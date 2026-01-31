package com.didi.dimina.api.openMiNiapp

import android.util.Log
import com.didi.dimina.Dimina
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.ApiHandler
import com.didi.dimina.api.ApiRegistry
import com.didi.dimina.api.NoneResult
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * 对齐微信 navigateToMiniProgram API 规范的小程序打开接口
 */
class OpenMiniApi : ApiHandler {

    companion object {
        private const val TAG = "OpenMiniApi"
        // 对齐微信 API 名称
        const val API_NAVIGATE_TO_MINI_PROGRAM = "navigateToMiniProgram"

        // 微信 API 标准参数常量（完全对齐微信命名）
        private const val PARAM_APP_ID = "appId"             // 微信标准：目标小程序appId（必填）
        private const val PARAM_PATH = "path"               // 微信标准：打开的页面路径
        private const val PARAM_EXTRA_DATA = "extraData"     // 微信标准：传递给目标小程序的额外数据
        private const val PARAM_ENV_VERSION = "envVersion"   // 微信标准：小程序版本（develop/trial/release）
        private const val PARAM_SUCCESS = "success"         // 微信标准：成功回调标识
        private const val PARAM_FAIL = "fail"               // 微信标准：失败回调标识
        private const val PARAM_COMPLETE = "complete"       // 微信标准：完成回调标识

        // 微信标准 envVersion 有效值
        private const val ENV_VERSION_DEVELOP = "develop"   // 开发版
        private const val ENV_VERSION_TRIAL = "trial"       // 体验版
        private const val ENV_VERSION_RELEASE = "release"   // 正式版（默认）
    }

    fun registerWith(registry: ApiRegistry) {
        registry.register(API_NAVIGATE_TO_MINI_PROGRAM, this)
        Log.d(TAG, "微信标准 navigateToMiniProgram API 注册完成")
    }

    /**
     * 处理UDP API调用（核心入口，完全对齐微信API规范）
     */
    override fun handleAction(
        activity: DiminaActivity,       // 本身就是Activity类型，无需转换
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit
    ): APIResult {
        Log.d(TAG, "处理微信标准API: $apiName, 调用方appId: $appId, 参数: $params")
        return when (apiName) {
            API_NAVIGATE_TO_MINI_PROGRAM -> navigateToMiniProgram(activity, params, responseCallback)
            else -> {
                val errorMsg = "未知的微信标准API: $apiName"
                Log.w(TAG, errorMsg)
                triggerWeChatCallback(responseCallback, params, false, errorMsg)
                NoneResult()
            }
        }
    }

    /**
     * 核心逻辑：对齐微信 navigateToMiniProgram 逻辑打开小程序
     */
    private fun navigateToMiniProgram(
        activity: DiminaActivity,       // 直接接收Activity类型参数
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        // 定义回调标识（从参数中提取微信标准的success/fail/complete）
        val successCallbackId = if (params.has(PARAM_SUCCESS)) params.getString(PARAM_SUCCESS) else ""
        val failCallbackId = if (params.has(PARAM_FAIL)) params.getString(PARAM_FAIL) else ""
        val completeCallbackId = if (params.has(PARAM_COMPLETE)) params.getString(PARAM_COMPLETE) else ""

        return try {
            // 1. 微信标准参数校验：必须包含appId（对齐微信必填规则）
            if (!params.has(PARAM_APP_ID) || params.getString(PARAM_APP_ID).isBlank()) {
                val errorMsg = "微信API规范：缺少必填参数 $PARAM_APP_ID（目标小程序appId）"
                Log.e(TAG, errorMsg)
                triggerWeChatCallback(responseCallback, params, false, errorMsg)
                return NoneResult()
            }

            // 2. 解析微信标准参数（完全对齐微信参数名和规则）
            val targetAppId = params.getString(PARAM_APP_ID)
            val path = if (params.has(PARAM_PATH)) params.getString(PARAM_PATH) else ""
            val extraData = if (params.has(PARAM_EXTRA_DATA)) params.getJSONObject(PARAM_EXTRA_DATA) else JSONObject()
            // 处理envVersion，默认值对齐微信（release）
            val envVersion = if (params.has(PARAM_ENV_VERSION)) {
                val env = params.getString(PARAM_ENV_VERSION)
                // 校验envVersion有效值，非法值默认release
                if (env in listOf(ENV_VERSION_DEVELOP, ENV_VERSION_TRIAL, ENV_VERSION_RELEASE)) env else ENV_VERSION_RELEASE
            } else {
                ENV_VERSION_RELEASE
            }

            // 3. 构造MiniProgram对象（兼容Dimina内部逻辑）
            val targetMiniProgram = MiniProgram(
                appId = targetAppId,
                name = "微信小程序_$targetAppId",
                versionCode = 1,
                versionName = envVersion,
                path = path
            )

            // 4. 打印微信标准参数日志（便于调试）
            Log.d(TAG, """
                执行微信标准 navigateToMiniProgram：
                - 目标appId: $targetAppId
                - 路径: $path
                - 额外数据: $extraData
                - 小程序版本: $envVersion
                - 成功回调ID: $successCallbackId
                - 失败回调ID: $failCallbackId
                - 完成回调ID: $completeCallbackId
            """.trimIndent())

            // 👇 关键修复：直接传入activity（Activity类型），无需强转Context
            Dimina.getInstance().startMiniProgram(activity, targetMiniProgram)

            // 5. 触发微信标准的success + complete回调
            val successMsg = "微信API：小程序打开请求已提交（appId=$targetAppId, envVersion=$envVersion）"
            triggerWeChatCallback(responseCallback, params, true, successMsg)

            NoneResult()
        } catch (e: Exception) {
            // 6. 异常处理：触发微信标准的fail + complete回调
            val errorMsg = "微信API：打开小程序失败 - ${e.message}"
            Log.e(TAG, errorMsg, e)
            triggerWeChatCallback(responseCallback, params, false, errorMsg)
            NoneResult()
        }
    }

    /**
     * 触发微信标准的回调（对齐微信 success/fail/complete 逻辑）
     */
    private fun triggerWeChatCallback(
        responseCallback: (String) -> Unit,
        params: JSONObject,
        success: Boolean,
        msg: String
    ) {
        // 1. 构建微信标准的回调结果JSON
        val resultJson = JSONObject().apply {
            put("errMsg", if (success) "navigateToMiniProgram:ok" else "navigateToMiniProgram:fail $msg")
            put("success", success)
            put("msg", msg)
            // 携带微信原始回调标识
            if (params.has(PARAM_SUCCESS)) put(PARAM_SUCCESS, params.getString(PARAM_SUCCESS))
            if (params.has(PARAM_FAIL)) put(PARAM_FAIL, params.getString(PARAM_FAIL))
            if (params.has(PARAM_COMPLETE)) put(PARAM_COMPLETE, params.getString(PARAM_COMPLETE))
            // 携带目标小程序appId
            if (params.has(PARAM_APP_ID)) put(PARAM_APP_ID, params.getString(PARAM_APP_ID))
        }

        // 2. 执行回调
        responseCallback(resultJson.toString())

        // 3. 日志记录回调触发情况
        Log.d(TAG, "触发微信标准回调：${if (success) "success" else "fail"}，结果：$resultJson")
    }
}