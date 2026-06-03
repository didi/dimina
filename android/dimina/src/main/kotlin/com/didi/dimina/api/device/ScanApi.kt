package com.didi.dimina.api.device

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.container.ScanCodeConfig
import org.json.JSONObject

/**
 * Device - Scan API
 *
 * 调用流程：
 * 1. 小程序 JS: wx.scanCode({ ... })
 * 2. Service 层: invokeAPI('scanCode', opts)
 * 3. 此处: 通过 DiminaActivity 的 ScanCodeHandler 启动相机扫码
 * 4. 识别成功后回调 JS success
 *
 * 扫码引擎策略：
 * - Android 9+ : ML Kit Barcode Scanning（更精确）
 * - Android < 9 : ZXing（轻量备选）
 */
class ScanApi : BaseApiHandler() {
    private companion object {
        const val SCAN_CODE = "scanCode"
    }

    override val apiNames = setOf(SCAN_CODE)

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SCAN_CODE -> {
                val onlyFromCamera = params.optBoolean("onlyFromCamera", false)
                // 解析 UI 自定义配置（文案、颜色等）
                val uiConfig = ScanCodeConfig.fromJson(params)
                val continuous = params.optBoolean("continuous", false)

                activity.handleScanCode(
                    onlyFromCamera = onlyFromCamera,
                    continuous = continuous,
                    config = uiConfig,
                ) { success, data ->
                    data.put("errMsg", if (success) "scanCode:ok" else data.optString("errMsg", "scanCode:fail"))
                    responseCallback(data.toString())
                }

                // 异步结果：扫码结果通过 handleScanCode 的 callback 返回
                NoneResult()
            }
            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }
}