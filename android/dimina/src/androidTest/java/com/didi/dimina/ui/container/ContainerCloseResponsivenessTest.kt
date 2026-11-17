package com.didi.dimina.ui.container

import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleCallback
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.filters.SdkSuppress
import com.didi.dimina.Dimina
import com.didi.dimina.api.network.Cancellable
import com.didi.dimina.api.network.Clock
import com.didi.dimina.api.network.SerialExecutor
import com.didi.dimina.api.network.SocketTransport
import com.didi.dimina.api.network.TaskScheduler
import com.didi.dimina.api.network.TransportCallbacks
import com.didi.dimina.api.network.TransportConnectSpec
import com.didi.dimina.api.network.TransportHandle
import com.didi.dimina.api.network.WebSocketManager
import com.didi.dimina.api.ui.LoadingTestActivity
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.core.MiniApp
import com.didi.dimina.engine.qjs.JSValue
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Issue #395: real Activity focus/return with the socket executor deliberately unable to run. */
@RunWith(AndroidJUnit4::class)
class ContainerCloseResponsivenessTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val appId = "dimina-close-responsiveness-test"
    private fun onMain(action: () -> Unit) = instrumentation.runOnMainSync(action)
    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        fail(message)
    }

    private class HeldExecutor : SerialExecutor {
        @Volatile
        var holding = false
        private val tasks = LinkedBlockingQueue<() -> Unit>()
        override fun execute(task: () -> Unit) {
            if (holding) tasks.add(task) else task()
        }
        fun drain() { while (true) (tasks.poll() ?: return).invoke() }
    }

    private fun current(): DiminaActivity? {
        var activity: DiminaActivity? = null
        onMain {
            activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                .filterIsInstance<DiminaActivity>().singleOrNull { it.getMiniProgram().appId == appId }
        }
        return activity
    }

    private fun assertFrameCommitted(activity: android.app.Activity) {
        val committed = CountDownLatch(1)
        onMain {
            activity.window.decorView.apply {
                viewTreeObserver.registerFrameCommitCallback { committed.countDown() }
                invalidate()
            }
        }
        assertTrue("Focused window must commit a rendered frame", committed.await(2, TimeUnit.SECONDS))
    }

    @Test
    @SdkSuppress(minSdkVersion = 29)
    fun returnsClosesAndReopensWhileSocketCleanupIsPending() {
        val sdk = Dimina.init(context, Dimina.DiminaConfig.Builder().build())
        val configField = Dimina::class.java.getDeclaredField("config").apply { isAccessible = true }
        val previousConfig = configField.get(sdk)
        configField.set(sdk, Dimina.DiminaConfig.Builder().setEnableMultiTask(false).build())
        val executor = HeldExecutor()
        val sockets = WebSocketManager(object : SocketTransport {
            override fun connect(spec: TransportConnectSpec, callbacks: TransportCallbacks): TransportHandle =
                error("This static mini program must not open sockets")
        }, object : TaskScheduler {
            override fun schedule(delayMs: Long, task: () -> Unit): Cancellable = object : Cancellable {
                override fun cancel() {}
            }
        }, object : Clock {
            override fun nowMs() = SystemClock.uptimeMillis()
        }, executor)
        WebSocketManager.setSharedForTesting(sockets)
        val zip = File(context.cacheDir, "$appId.zip")
        try {
            val files = mutableMapOf(
                "config.json" to """{"appId":"$appId","versionCode":1,"versionName":"1","name":"Close Regression","path":"pages/index/index"}""",
                "main/app-config.json" to """{"app":{"pages":["pages/index/index","pages/detail/index"]},"modules":{"pages/index/index":{},"pages/detail/index":{}}}""",
                "main/logic.js" to """
                    modDefine("app",function(){App({
                      onLaunch(){globalThis.__closeProbe={loads:0,shows:0,hides:0}},
                      onShow(){__closeProbe.shows++},onHide(){__closeProbe.hides++}
                    })});
                    ["pages/index/index","pages/detail/index"].forEach(function(path){
                      modDefine(path,function(){globalThis.__extraInfo={path:path,usingComponents:{}};
                        Page({onLoad(){__closeProbe.loads++}})});
                    });
                """.trimIndent(),
                "main/app.css" to "",
            )
            listOf("index", "detail").forEach { page ->
                files["main/pages_${page}_index.js"] = """modDefine("pages/$page/index",function(){Module({path:"pages/$page/index",id:"close-$page",usingComponents:{},render:()=>_createBlock(_resolveComponent("dd-view"),{},{default:_withCtx(()=>[_createTextVNode("Close regression $page")]),_:1})})});"""
                files["main/pages_${page}_index.css"] = ""
            }
            ZipOutputStream(zip.outputStream()).use { out -> files.forEach { (name, content) ->
                out.putNextEntry(ZipEntry(name)); out.write(content.toByteArray()); out.closeEntry()
            } }
            val installed = CountDownLatch(1)
            var result: Result<JSONObject>? = null
            sdk.installMiniProgram(appId, zip.path) { result = it; installed.countDown() }
            assertTrue(installed.await(15, TimeUnit.SECONDS)); result!!.getOrThrow()
            ActivityScenario.launch<LoadingTestActivity>(Intent(context, LoadingTestActivity::class.java)).use { scenario ->
                lateinit var host: LoadingTestActivity
                scenario.onActivity { host = it }
                onMain { sdk.startMiniProgram(host, MiniProgram(appId, name = "Close Regression", path = "pages/index/index")) }
                await("Root did not load") { current() != null && MiniApp.getInstance().peekJsCore(appId)
                    ?.evaluate("globalThis.__closeProbe?.loads===1")?.booleanValue == true }
                val root = current()!!
                val core = MiniApp.getInstance().peekJsCore(appId)!!
                assertFrameCommitted(root)
                repeat(3) { cycle ->
                    core.evaluate("wx.navigateTo({url:'/pages/detail/index'})")
                    await("Child did not load") { current()?.let { it !== root } == true &&
                        core.evaluate("__closeProbe.loads===${cycle + 2}").booleanValue }
                    if (cycle % 2 == 0) instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK)
                    else core.evaluate("wx.navigateBack({})")
                    await("Root did not regain focus") { current() === root && root.hasWindowFocus() }
                    assertFrameCommitted(root)
                }

                executor.holding = true
                val destroyed = CountDownLatch(1)
                val callback = ActivityLifecycleCallback { activity, stage ->
                    if (activity === root && stage == Stage.DESTROYED) destroyed.countDown()
                }
                onMain { ActivityLifecycleMonitorRegistry.getInstance().addLifecycleCallback(callback) }
                try {
                    onMain { assertTrue(sdk.closeMiniProgram(appId)) }
                    assertTrue("Activity destruction must finish without waiting for socket cleanup",
                        destroyed.await(1500, TimeUnit.MILLISECONDS))
                    await("Host did not regain focus") { host.hasWindowFocus() }
                    assertFrameCommitted(host)
                    assertNull(MiniApp.getInstance().peekJsCore(appId))
                    await("App.onHide must precede native teardown") {
                        val hides = core.evaluate("__closeProbe.hides")
                        assertNotEquals("Native engine must survive until socket cleanup completes",
                            JSValue.Type.ERROR, hides.type)
                        hides.numberValue == 1.0
                    }
                    core.postMessage("appShow")
                    assertTrue("Late messages must be rejected by the closing runtime",
                        core.evaluate("__closeProbe.shows===1").booleanValue)
                    onMain { sdk.startMiniProgram(host, MiniProgram(appId, name = "Close Regression", path = "pages/index/index")) }
                    await("Rapid reopen did not render and regain focus") {
                        current()?.let { it !== root && it.hasWindowFocus() } == true &&
                            MiniApp.getInstance().peekJsCore(appId)?.evaluate("__closeProbe.loads===1")?.booleanValue == true
                    }
                    val freshCore = MiniApp.getInstance().peekJsCore(appId)!!
                    assertFrameCommitted(current()!!)
                    assertNotSame(core, freshCore)
                    executor.drain()
                    await("Old engine was not released after socket cleanup") {
                        core.evaluate("true").type == JSValue.Type.ERROR
                    }
                    assertTrue(freshCore.evaluate("__closeProbe.loads===1").booleanValue)
                    val start = SystemClock.uptimeMillis()
                    onMain { sdk.destroyAllMiniPrograms() }
                    assertTrue("Batch teardown must not wait on the socket executor",
                        SystemClock.uptimeMillis() - start < 1500)
                } finally {
                    executor.holding = false
                    executor.drain()
                    onMain { ActivityLifecycleMonitorRegistry.getInstance().removeLifecycleCallback(callback) }
                }
            }
        } finally {
            executor.holding = false
            executor.drain()
            onMain { sdk.destroyAllMiniPrograms() }
            WebSocketManager.setSharedForTesting(null)
            configField.set(sdk, previousConfig)
            zip.delete()
        }
    }
}
