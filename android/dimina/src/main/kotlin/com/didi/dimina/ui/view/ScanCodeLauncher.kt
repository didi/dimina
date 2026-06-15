package com.didi.dimina.ui.view

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.didi.dimina.api.device.ScanCodeOptions
import com.didi.dimina.ui.container.ScanCodeActivity
import org.json.JSONObject

class ScanCodeLauncher(private val activity: ComponentActivity) {
    private lateinit var cameraPermissionLauncher: ActivityResultLauncher<String>
    private lateinit var scannerLauncher: ActivityResultLauncher<Intent>

    private var pendingOptions: ScanCodeOptions? = null
    private var scanCodeCallback: ((Boolean, JSONObject) -> Unit)? = null

    init {
        cameraPermissionLauncher = activity.registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) {
                pendingOptions?.let { launchScanner(it) }
            } else {
                dispatch(false, JSONObject().put("errMsg", "auth denied"))
            }
        }

        scannerLauncher = activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult(),
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK) {
                val resultJson = result.data?.getStringExtra(ScanCodeActivity.EXTRA_RESULT_JSON)
                dispatch(true, JSONObject(resultJson ?: "{}"))
            } else {
                val errMsg = result.data?.getStringExtra(ScanCodeActivity.EXTRA_ERROR_MESSAGE) ?: "cancel"
                dispatch(false, JSONObject().put("errMsg", errMsg))
            }
        }
    }

    fun launch(options: ScanCodeOptions, callback: (Boolean, JSONObject) -> Unit) {
        scanCodeCallback = callback
        pendingOptions = options

        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchScanner(options)
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun launchScanner(options: ScanCodeOptions) {
        scannerLauncher.launch(ScanCodeActivity.createIntent(activity, options))
    }

    private fun dispatch(success: Boolean, result: JSONObject) {
        scanCodeCallback?.invoke(success, result)
        scanCodeCallback = null
        pendingOptions = null
    }
}
