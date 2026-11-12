package com.didi.dimina.demo

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.Dimina
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.PathUtils
import com.didi.dimina.core.MiniApp
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the Service JS -> previewImage bridge -> rendered native pager. */
@RunWith(AndroidJUnit4::class)
class ImagePreviewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val ui get() = instrumentation.uiAutomation

    @Test
    fun localImagesRenderAndSwipeFromCurrentImage() {
        val appId = "preview-${UUID.randomUUID()}"
        val sdk = Dimina.getInstance()
        val zip = File(context.cacheDir, "$appId.zip")
        val prefix = PathUtils.VIRTUAL_DOMAIN_URL
        val urls = JSONArray(listOf("${prefix}usr/red.png", "${prefix}tmp/green.png", "blue.png"))
        val red = Base64.getEncoder().encodeToString(png(Color.RED))
        val green = Base64.getEncoder().encodeToString(png(Color.GREEN))
        val files = mapOf(
            "config.json" to """{"appId":"$appId","versionCode":1,"versionName":"1","name":"Image preview regression","path":"pages/index"}""",
            "main/app-config.json" to """{"app":{"pages":["pages/index"]},"modules":{"pages/index":{}}}""",
            "main/logic.js" to """
                modDefine("app",function(){App({})});
                modDefine("pages/index",function(){
                  globalThis.__extraInfo={path:"pages/index",usingComponents:{}};
                  Page({onReady(){
                    const fs=wx.getFileSystemManager();
                    fs.writeFileSync(wx.env.USER_DATA_PATH+"/red.png","$red","base64");
                    fs.writeFileSync("${prefix}tmp/green.png","$green","base64");
                    globalThis.__previewReady=true;
                  }});
                });
            """.trimIndent(),
            "main/pages_index.js" to """modDefine("pages/index",function(){Module({path:"pages/index",id:"preview-test",usingComponents:{},pageConfig:{},render:()=>_createBlock(_resolveComponent("dd-view"),{},{default:_withCtx(()=>[_createTextVNode("Preview ready")]),_:1})})});""",
            "main/app.css" to "", "main/pages_index.css" to "",
        )
        ZipOutputStream(zip.outputStream()).use { out ->
            files.forEach { (name, content) ->
                out.putNextEntry(ZipEntry(name)); out.write(content.toByteArray()); out.closeEntry()
            }
            out.putNextEntry(ZipEntry("main/blue.png")); out.write(png(Color.BLUE)); out.closeEntry()
        }
        try {
            val installed = CountDownLatch(1)
            var result: Result<JSONObject>? = null
            sdk.installMiniProgram(appId, zip.path) { result = it; installed.countDown() }
            assertTrue("Mini program installation timed out", installed.await(15, TimeUnit.SECONDS))
            result!!.getOrThrow()
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { host ->
                host.onActivity { sdk.startMiniProgram(it, MiniProgram(appId, path = "pages/index")) }
                await("Mini program did not become ready") {
                    runCatching {
                        MiniApp.getInstance().peekJsCore(appId)
                            ?.evaluate("JSON.stringify({ready:globalThis.__previewReady===true})")
                            ?.toString()?.let(::JSONObject)?.optBoolean("ready") == true
                    }.getOrDefault(false)
                }
                val core = checkNotNull(MiniApp.getInstance().peekJsCore(appId))
                core.evaluate("wx.previewImage({urls:$urls,current:${JSONObject.quote(urls.getString(1))}})")
                awaitImage(Color.GREEN, "preview-current")
                swipe(left = true)
                awaitImage(Color.BLUE, "preview-next")
                swipe(left = false)
                awaitImage(Color.GREEN, "preview-return")
                swipe(left = false)
                awaitImage(Color.RED, "preview-previous")
                ui.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            }
        } finally {
            val removed = CountDownLatch(1)
            var result: Result<Unit>? = null
            sdk.uninstallMiniProgram(appId, clearUserData = true) { result = it; removed.countDown() }
            try {
                assertTrue("Fixture cleanup timed out", removed.await(15, TimeUnit.SECONDS))
                result!!.getOrThrow()
            } finally {
                zip.delete()
            }
        }
    }

    private fun png(color: Int): ByteArray {
        val bitmap = Bitmap.createBitmap(400, 400, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(color)
        return ByteArrayOutputStream().use { out ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            bitmap.recycle()
            out.toByteArray()
        }
    }

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15_000
        do {
            if (condition()) return
            SystemClock.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
        fail(message)
    }

    private fun awaitImage(expected: Int, name: String) {
        await("Expected rendered image pixels for $name") {
            val frame = ui.takeScreenshot() ?: return@await false
            val matches = listOf(2, frame.width / 2, frame.width - 3).all { x ->
                frame.getPixel(x, frame.height / 2) == expected
            }
            File(context.cacheDir, "$name.png").outputStream().use {
                frame.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            frame.recycle()
            matches
        }
    }

    private fun swipe(left: Boolean) {
        val screen = checkNotNull(ui.takeScreenshot())
        val from = screen.width * if (left) .8f else .2f
        val to = screen.width * if (left) .2f else .8f
        val y = screen.height / 2f
        screen.recycle()
        val down = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float) {
            val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0)
            event.source = InputDevice.SOURCE_TOUCHSCREEN
            assertTrue(ui.injectInputEvent(event, true))
            event.recycle()
        }
        send(MotionEvent.ACTION_DOWN, from)
        repeat(20) { index ->
            SystemClock.sleep(16)
            send(MotionEvent.ACTION_MOVE, from + (to - from) * (index + 1) / 20f)
        }
        send(MotionEvent.ACTION_UP, to)
    }
}
