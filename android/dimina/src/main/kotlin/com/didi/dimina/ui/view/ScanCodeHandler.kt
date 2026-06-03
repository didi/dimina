package com.didi.dimina.ui.view

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import com.didi.dimina.ui.container.ScanCodeActivity
import com.didi.dimina.ui.container.ScanCodeConfig
import org.json.JSONObject

/**
 * 扫码操作管理器
 *
 * 负责：
 * 1. 请求 CAMERA 权限
 * 2. 启动 ScanCodeActivity 进行扫码
 * 3. 解析扫码结果并通过回调返回
 *
 * 使用方法：在 DiminaActivity 中实例化，API handler 通过 activity 调用。
 *
 * @see ContactPicker 同类模式
 */
class ScanCodeHandler(private val activity: ComponentActivity) {

    private var scanCallback: ((Boolean, JSONObject) -> Unit)? = null
    private var pendingOnlyFromCamera: Boolean = false
    private var pendingConfig: ScanCodeConfig = ScanCodeConfig.DEFAULT

    private val cameraPermissionLauncher: ActivityResultLauncher<String> =
        activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                launchScanCode(onlyFromCamera = pendingOnlyFromCamera, continuous = pendingConfig.continuous, config = pendingConfig)
            } else {
                scanCallback?.invoke(false, JSONObject().apply {
                    put("errMsg", "scanCode:fail Camera permission denied")
                })
                scanCallback = null
            }
        }

    private val scanCodeLauncher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                val data = result.data
                if (data != null) {
                    val isBatch = data.getBooleanExtra("batch", false)
                    val scanResult = data.getStringExtra("result")
                    val scanType = data.getStringExtra("scanType")
                    val charSet = data.getStringExtra("charSet")
                    val errMsg = data.getStringExtra("errMsg")

                    if (scanResult != null) {
                        if (isBatch) {
                            // 连续扫码：返回 JSON 数组
                            val resultsArray = org.json.JSONArray(scanResult)
                            scanCallback?.invoke(true, JSONObject().apply {
                                put("result", resultsArray)
                                put("scanType", "BATCH")
                                put("charSet", charSet ?: "utf-8")
                                put("errMsg", errMsg ?: "scanCode:ok")
                                put("batch", true)
                            })
                        } else {
                            scanCallback?.invoke(true, JSONObject().apply {
                                put("result", scanResult)
                                put("scanType", scanType ?: "UNKNOWN")
                                put("charSet", charSet ?: "utf-8")
                                put("errMsg", errMsg ?: "scanCode:ok")
                            })
                        }
                    } else {
                        scanCallback?.invoke(false, JSONObject().apply {
                            put("errMsg", errMsg ?: "scanCode:fail")
                        })
                    }
                } else {
                    scanCallback?.invoke(false, JSONObject().apply {
                        put("errMsg", "scanCode:fail no data")
                    })
                }
            } else {
                scanCallback?.invoke(false, JSONObject().apply {
                    put("errMsg", "scanCode:fail cancel")
                })
            }
            scanCallback = null
        }

    /**
     * 发起扫码
     *
     * @param onlyFromCamera 是否仅从相机扫码
     * @param continuous 是否连续扫码模式
     * @param config UI 配置（文案、颜色等），来自 wx.scanCode 参数
     * @param callback 结果回调 (success, data)
     */
    fun handleScanCode(
        onlyFromCamera: Boolean = false,
        continuous: Boolean = false,
        config: ScanCodeConfig = ScanCodeConfig.DEFAULT,
        callback: (Boolean, JSONObject) -> Unit,
    ) {
        scanCallback = callback
        pendingOnlyFromCamera = onlyFromCamera
        pendingConfig = config  // 保存配置，权限回调时使用

        // 先检查相机权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (activity.checkSelfPermission(Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED
            ) {
                launchScanCode(onlyFromCamera, continuous, config)
            } else {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        } else {
            // Android < 6 不需要运行时权限
            launchScanCode(onlyFromCamera, continuous, config)
        }
    }

    private fun launchScanCode(onlyFromCamera: Boolean = false, continuous: Boolean = false, config: ScanCodeConfig = ScanCodeConfig.DEFAULT) {
        val intent = Intent(activity, ScanCodeActivity::class.java).apply {
            putExtra("canOpenAlbum", !onlyFromCamera)
            putExtra("continuous", continuous)
            ScanCodeConfig.putToIntent(this, config)
        }
        scanCodeLauncher.launch(intent)
    }
}
