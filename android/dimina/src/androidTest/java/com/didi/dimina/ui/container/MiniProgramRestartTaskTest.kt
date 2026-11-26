package com.didi.dimina.ui.container

import android.app.Instrumentation
import android.app.ActivityManager
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.didi.dimina.Dimina
import com.didi.dimina.api.ui.LoadingTestActivity
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.core.JsCore
import com.didi.dimina.core.MiniApp
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Issue #350: verify actual Android task identity, including empty cards left in Recents. */
@RunWith(AndroidJUnit4::class)
class MiniProgramRestartTaskTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val appId = "dimina-restart-task-test"
    private val title = "Dimina Restart Regression"
    private fun onMain(action: () -> Unit) = instrumentation.runOnMainSync(action)
    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 20000
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        fail(message)
    }
    private fun current(): DiminaActivity? {
        var result: DiminaActivity? = null
        onMain {
            result = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED).filterIsInstance<DiminaActivity>()
                .singleOrNull { it.getMiniProgram().appId == appId }
        }
        return result
    }
    private fun loads(): Int = runCatching {
        MiniApp.getInstance().peekJsCore(appId)?.evaluate("globalThis.__restartProbe.loads")
            ?.toString()?.toDoubleOrNull()?.toInt() ?: 0
    }.getOrDefault(0)

    private fun pageEvents(core: JsCore): List<String> {
        val events = JSONArray(core.evaluate("JSON.stringify(__restartProbe.pageEvents)").toString())
        return List(events.length()) { events.getString(it) }
    }

    @Test fun reLaunchKeepsIndependentTask() = verifyReplacement(true, false)
    @Test fun reenterKeepsIndependentTask() = verifyReplacement(true, true)
    @Test fun reLaunchKeepsHostTask() = verifyReplacement(false, false)
    @Test fun reenterKeepsHostTask() = verifyReplacement(false, true)

    @Test fun reLaunchDuringFirstPageLoadKeepsIndependentTask() =
        verifyReplacement(true, false, initialReLaunch = true)

    private fun verifyReplacement(multiTask: Boolean, cold: Boolean, initialReLaunch: Boolean = false) {
        val config = Dimina.DiminaConfig.Builder().setEnableMultiTask(multiTask).build()
        val sdk = Dimina.init(context, Dimina.DiminaConfig.Builder().build())
        // SDK configuration is immutable after init; isolate each mode within this test process.
        val configField = Dimina::class.java.getDeclaredField("config").apply { isAccessible = true }
        val previousConfig = configField.get(sdk)
        configField.set(sdk, config)
        val zip = File(context.cacheDir, "$appId.zip")
        val files = mapOf(
            "config.json" to """{"appId":"$appId","versionCode":1,"versionName":"1","name":"$title","path":"pages/index/index"}""",
            "main/app-config.json" to """{"app":{"pages":["pages/index/index"],"window":{"navigationBarTitleText":"$title"}},"modules":{"pages/index/index":{}}}""",
            "main/logic.js" to """
                modDefine("app",function(){App({
                  onLaunch(){globalThis.__restartProbe={launches:1,loads:0,hides:0,shows:[],pageEvents:[],updates:0}},
                  onShow(o){__restartProbe.shows.push(JSON.parse(JSON.stringify(o)))},
                  onHide(){__restartProbe.hides++}
                })});
                modDefine("pages/index/index",function(){
                  globalThis.__extraInfo={path:"pages/index/index",usingComponents:{}};
                  // Like Taro, instances of this route share a reference to the current page.
                  let pageElement;
                  Page({
                    data:{count:0},
                    onLoad(options){
                      pageElement=this;
                      this.probeId=options.probe||"initial";
                      __restartProbe.pageEvents.push("load:"+this.probeId);
                      __restartProbe.loads++;
                      if(options.relaunch==="1") wx.reLaunch({url:"/pages/index/index?probe=first"});
                    },
                    onShow(){__restartProbe.pageEvents.push("show:"+this.probeId)},
                    onUnload(){
                      pageElement=null;
                      __restartProbe.pageEvents.push("unload:"+this.probeId);
                    },
                    increment(){
                      pageElement?.setData({count:pageElement.data.count+1},()=>{__restartProbe.updates++});
                    }
                  });
                });
            """.trimIndent(),
            "main/pages_index_index.js" to """modDefine("pages/index/index",function(){Module({path:"pages/index/index",id:"restart-test",usingComponents:{},render:()=>_createBlock(_resolveComponent("dd-view"),{},{default:_withCtx(()=>[_createTextVNode("$title")]),_:1})})});""",
            "main/app.css" to "", "main/pages_index_index.css" to "",
        )
        ZipOutputStream(zip.outputStream()).use { out -> files.forEach { (name, content) ->
            out.putNextEntry(ZipEntry(name)); out.write(content.toByteArray()); out.closeEntry()
        } }
        val installed = CountDownLatch(1)
        var installResult: Result<JSONObject>? = null
        sdk.installMiniProgram(appId, zip.path) { installResult = it; installed.countDown() }
        assertTrue(installed.await(15, TimeUnit.SECONDS)); installResult!!.getOrThrow()
        ActivityScenario.launch<LoadingTestActivity>(Intent(context, LoadingTestActivity::class.java)).use { scenario ->
            lateinit var host: LoadingTestActivity
            scenario.onActivity { host = it }
            val manager = context.getSystemService(ActivityManager::class.java)
            try {
                val tasksBeforeLaunch = manager.appTasks.map { it.taskInfo.taskId }.toSet()
                var initialTaskId: Int? = null
                onMain {
                    val path = "pages/index/index" + if (initialReLaunch) "?relaunch=1" else ""
                    sdk.startMiniProgram(host, MiniProgram(appId, name = title, path = path))
                    if (multiTask) {
                        initialTaskId = manager.appTasks.single {
                            it.taskInfo.taskId !in tasksBeforeLaunch
                        }.taskInfo.taskId
                    }
                }
                await("Initial page did not load") {
                    current() != null && loads() == if (initialReLaunch) 2 else 1
                }
                var rootProbe = if (initialReLaunch) "first" else "initial"
                val initialCore = MiniApp.getInstance().peekJsCore(appId)!!
                await("Initial root did not show") { "show:$rootProbe" in pageEvents(initialCore) }
                if (initialReLaunch) {
                    await("First page did not unload") { "unload:initial" in pageEvents(initialCore) }
                    assertEquals(
                        "reLaunch from onLoad must unload the original page before showing the replacement",
                        listOf("load:initial", "unload:initial", "load:first", "show:first"),
                        pageEvents(initialCore).filterNot { it == "show:initial" },
                    )
                }
                if (multiTask) {
                    assertEquals("First-load reLaunch must keep the initial task", initialTaskId, current()!!.taskId)
                    assertEquals(tasksBeforeLaunch + initialTaskId!!,
                        manager.appTasks.map { it.taskInfo.taskId }.toSet())
                }
                val taskId = current()!!.taskId
                if (multiTask) assertNotEquals(host.taskId, taskId) else assertEquals(host.taskId, taskId)
                val taskIds = manager.appTasks.map { it.taskInfo.taskId }.toSet()
                // First replace a root, then replace a deeper stack, then repeat a root replacement.
                repeat(3) { cycle ->
                    val oldRoot = current()!!
                    if (cycle == 1) {
                        val beforeLoads = loads()
                        val core = MiniApp.getInstance().peekJsCore(appId)!!
                        core.evaluate("wx.navigateTo({url:'/pages/index/index?probe=child'})")
                        await("Child page did not show") {
                            current()?.let { it !== oldRoot && !it.getMiniProgram().root } == true &&
                                loads() > beforeLoads && "show:child" in pageEvents(core)
                        }
                    }
                    val old = current()!!
                    val core = MiniApp.getInstance().peekJsCore(appId)!!
                    val beforeLoads = loads()
                    val beforeEvents = pageEvents(core).size
                    val newProbe = "replacement-$cycle"
                    var sourceWasFinishing: Boolean? = null
                    val monitor = object : Instrumentation.ActivityMonitor() {
                        override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                            if (intent.component?.className == DiminaActivity::class.java.name) {
                                sourceWasFinishing = old.isFinishing
                            }
                            return null
                        }
                    }
                    instrumentation.addMonitor(monitor)
                    try {
                        if (cold) {
                            // Invoke the exact entry used by the capsule's re-enter menu item.
                            onMain {
                                DiminaActivity::class.java.getDeclaredMethod("reenterMiniProgram").apply {
                                    isAccessible = true
                                }.invoke(old)
                            }
                        } else {
                            core.evaluate("wx.reLaunch({url:'/pages/index/index?probe=$newProbe'})")
                        }
                        await("Replacement page did not load") {
                            current()?.let { it !== old && it.getMiniProgram().root } == true &&
                                if (cold) loads() == 1 else loads() > beforeLoads
                        }
                    } finally {
                        instrumentation.removeMonitor(monitor)
                    }
                    assertEquals("Start the replacement before finishing its source Activity", false, sourceWasFinishing)
                    assertEquals("Replacement must stay in the original task", taskId, current()!!.taskId)
                    assertEquals("Replacement must not leave duplicate recent tasks", taskIds,
                        manager.appTasks.map { it.taskInfo.taskId }.toSet())
                    assertEquals(1 + if (multiTask) 0 else 1,
                        manager.appTasks.single { it.taskInfo.taskId == taskId }.taskInfo.numActivities)
                    if (cold) {
                        assertNotSame(core, MiniApp.getInstance().peekJsCore(appId))
                    } else {
                        assertSame(core, MiniApp.getInstance().peekJsCore(appId))
                        await("Old Activities did not finish or replacement did not show") {
                            old.isDestroyed && oldRoot.isDestroyed && "show:$newProbe" in pageEvents(core)
                        }
                        val events = pageEvents(core).drop(beforeEvents)
                        val expected = buildList {
                            if (cycle == 1) add("unload:child")
                            add("unload:$rootProbe")
                            add("load:$newProbe")
                            add("show:$newProbe")
                        }
                        assertEquals("Old pages must unload once, top to root, before replacement", expected, events)
                        core.evaluate("getCurrentPages().at(-1).increment()")
                        await("Replacement page setData did not complete") {
                            core.evaluate("__restartProbe.updates === ${cycle + 1}").toString() == "true"
                        }
                        rootProbe = newProbe
                    }
                    assertFalse("Shared host must survive replacement", host.isFinishing)
                }
            } finally {
                onMain { sdk.destroyAllMiniPrograms() }
                configField.set(sdk, previousConfig)
            }
        }
        zip.delete()
    }
}
