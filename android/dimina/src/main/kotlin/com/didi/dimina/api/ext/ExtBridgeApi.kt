package com.didi.dimina.api.ext

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * 处理 service 侧 extBridge 调用。
 *
 * service 侧调用链：
 *   extBridge({ event, module, data, success, fail, complete })
 *   → invokeAPI(name=event, params={ module, data, success, fail, complete })
 *   → container: apiName=event, params.module=模块名
 *
 * 本类不向 [com.didi.dimina.api.ApiRegistry] 注册固定 apiName，
 * 而是由 [com.didi.dimina.api.ApiRegistry] 在未命中已知 API 时，
 * 检测 params 中存在 "module" 字段后转发到此处处理。
 *
 * Author: Doslin
 */
class ExtBridgeApi(
    private val extModules: Map<String, ExtModuleHandler>,
) : BaseApiHandler() {

    private val tag = "ExtBridgeApi"

    // 不注册固定 apiName，由 ApiRegistry 动态路由
    override val apiNames: Set<String> = emptySet()

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val module = params.optString("module", "")
        val data = params.optJSONObject("data") ?: JSONObject()

        val handler = extModules[module]
        if (handler == null) {
            LogUtils.e(tag, "extBridge:fail module \"$module\" not registered")
            return AsyncResult(JSONObject().apply {
                put("errMsg", "extBridge:fail module \"$module\" not registered")
            })
        }

        val callback = object : ExtCallback {
            override fun onSuccess(result: JSONObject) {
                result.put("errMsg", "$apiName:ok")
                ApiUtils.invokeSuccess(params, result, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
            }

            override fun onFail(error: JSONObject) {
                if (!error.has("errMsg")) {
                    error.put("errMsg", "$apiName:fail")
                }
                ApiUtils.invokeFail(params, error, responseCallback)
                ApiUtils.invokeComplete(params, responseCallback)
            }
        }

        return try {
            handler.handle(apiName, data, callback)
            // 回调由 handler 异步触发，返回 NoneResult 跳过 MiniApp 的默认回调逻辑
            NoneResult()
        } catch (e: Exception) {
            LogUtils.e(tag, "extBridge:fail ${e.message}")
            AsyncResult(JSONObject().apply {
                put("errMsg", "$apiName:fail ${e.message}")
            })
        }
    }
}
