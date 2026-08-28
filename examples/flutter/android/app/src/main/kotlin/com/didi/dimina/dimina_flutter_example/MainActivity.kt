package com.didi.dimina.dimina_flutter_example

import android.os.Bundle
import android.content.pm.ApplicationInfo
import com.didi.dimina.Dimina
import com.didi.dimina.bean.MiniProgram
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        Dimina.init(
            applicationContext,
            Dimina.DiminaConfig.Builder()
                .setDebugMode(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
                .build(),
        )
        super.onCreate(savedInstanceState)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            CHANNEL_NAME,
        ).setMethodCallHandler(::onMethodCall)
    }

    private fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "openMiniProgram" -> {
                    val miniProgram = MiniProgram(
                        appId = call.requiredString("appId"),
                        name = call.requiredString("name"),
                        path = call.requiredString("path"),
                        versionCode = call.argument<Number>("versionCode")?.toInt()
                            ?: throw IllegalArgumentException("versionCode is required"),
                        versionName = call.requiredString("versionName"),
                        updateManifestUrl = call.argument<String>("updateManifestUrl").orEmpty(),
                    )
                    Dimina.getInstance().startMiniProgram(this, miniProgram)
                    result.success(true)
                }

                "closeMiniProgram" -> {
                    val appId = call.requiredString("appId")
                    result.success(Dimina.getInstance().closeMiniProgram(appId))
                }

                else -> result.notImplemented()
            }
        } catch (error: Throwable) {
            result.error("DIMINA_FAILED", error.message, null)
        }
    }

    private fun MethodCall.requiredString(name: String): String {
        return argument<String>(name)?.trim()?.takeIf(String::isNotEmpty)
            ?: throw IllegalArgumentException("$name is required")
    }

    private companion object {
        const val CHANNEL_NAME = "com.didi.dimina/host"
    }
}
