package com.didi.dimina.core

import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.webkit.WebView
import android.view.WindowManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.Dimina
import com.didi.dimina.api.ui.LoadingTestActivity
import com.didi.dimina.bean.*
import com.didi.dimina.common.*
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.view.createWebView
import com.didi.dimina.ui.view.postMessage
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

@RunWith(AndroidJUnit4::class)
class CanvasBinaryTest {
    @Test fun actualQuickJSAndWebViewUploadOwnedBinaryTexturesInOrder() = verify(false)
    @Test fun rendererWithoutAcknowledgementsKeepsTheLegacyPath() = verify(true)

    private fun verify(legacy: Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val appId = "canvas-${UUID.randomUUID()}"
        Dimina.init(context, Dimina.DiminaConfig.Builder().build())
        StoreUtils.initialize(context)
        val oldVersion = VersionUtils.getJSVersion()
        val version = JSONObject(context.assets.open("jssdk/config.json").bufferedReader().use { it.readText() }).getInt("versionCode")
        val sdkRoot = File(context.filesDir, "jssdk/$version").apply { mkdirs() }
        ZipInputStream(context.assets.open("jssdk/main.zip")).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val target = File(sdkRoot, entry.name)
                require(target.canonicalPath.startsWith(sdkRoot.canonicalPath + File.separator))
                if (entry.isDirectory) target.mkdirs() else { target.parentFile!!.mkdirs(); target.outputStream().use { zip.copyTo(it) } }
            }
        }
        VersionUtils.setJSVersion(version)
        val core = JsCore()
        assertTrue(core.init())
        val loaded = CountDownLatch(1)
        lateinit var web: WebView
        lateinit var bridge: Bridge
        var page = ""
        ActivityScenario.launch<LoadingTestActivity>(Intent(context, LoadingTestActivity::class.java)).use { scenario ->
            try {
                scenario.onActivity { activity ->
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    web = createWebView(activity, { loaded.countDown() }, appId)
                    activity.setContentView(web)
                    val parent = DiminaActivity()
                    ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java)
                        .apply { isAccessible = true }.invoke(parent, context)
                    bridge = Bridge(BridgeOptions(PathInfo("game", null), 1001, core, web, true, "main", appId, "game", emptyList(),
                        MergedPageConfig("", "#fff", "black", "#fff", "custom", false, emptyMap())), parent)
                    page = Bridge::class.java.getDeclaredField("id").apply { isAccessible = true }.get(bridge) as String
                    bridge.init()
                }
                assertTrue("bundled Render loaded", loaded.await(15, TimeUnit.SECONDS))
                if (legacy) {
                    val changed = CountDownLatch(1)
                    scenario.onActivity { web.evaluateJavascript("delete globalThis.__diminaCanvasBinaryAcknowledgements") { changed.countDown() } }
                    assertTrue(changed.await(5, TimeUnit.SECONDS))
                }
                assertNotEquals(com.didi.dimina.engine.qjs.JSValue.Type.ERROR, core.evaluateFromFile(File(sdkRoot, "main/assets/service.js").path).type)
                core.evaluate("modDefine('game', function() {}); DiminaServiceBridge.onMessage({type:'loadResource',body:{bridgeId:'$page',appId:'$appId',pagePath:'game',runtimeType:'game',hostEnv:{systemInfo:{windowWidth:256,windowHeight:256,pixelRatio:1}}}})")
                scenario.onActivity { web.postMessage(JSONObject().put("type", "loadResource").put("body", JSONObject()
                    .put("bridgeId", page).put("appId", appId).put("root", "main").put("pagePath", "game").put("runtimeType", "game").put("baseUrl", PathUtils.WEBVIEW_JSAPP_BASE_URL)).toString()) }
                val create = core.evaluate("""
                    (()=>{try{globalThis.canvas=wx.createOffscreenCanvas({type:'webgl',width:256,height:256});
                    globalThis.gl=canvas.getContext('webgl'); return !!gl && gl.getError()===0}catch(e){return String(e)}})()
                """.trimIndent())
                assertTrue(create.toString(), create.booleanValue)
                val deadline = System.currentTimeMillis() + 5000
                while (!legacy && !core.isCanvasBinaryReady(page) && System.currentTimeMillis() < deadline) Thread.sleep(2)
                val result = core.evaluate("""
                    (()=>{try{
                        const pixels=new Uint8Array(256*256*4).fill(255);
                        const descriptor=DiminaServiceBridge.encodeCanvasArrayBuffer(pixels.buffer,'$page');
                        const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);
                        const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
                        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
                        let exact=true,ordered=true;
                        for(let round=0;round<3;round++){
                            for(let i=0;i<pixels.length;i+=4){pixels[i]=round===0?255:(i*37+round)&255;pixels[i+1]=round===0?255:(i*13+9)&255;pixels[i+2]=round===0?255:(i*7+11)&255;pixels[i+3]=255}
                            const expected=pixels.slice();gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,256,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                            if(round===2){gl.canvas.flushOperations();const first=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,first);ordered=first.every((byte,index)=>byte===expected[index])}pixels.fill(17);
                            const output=new Uint8Array(expected.length);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,output);
                            exact=exact&&output.every((value,index)=>value===expected[index]);
                        }
                        return JSON.stringify({binary:descriptor.packed instanceof ArrayBuffer,compressed:descriptor.encoding==='rle32-v1',exact,ordered,error:gl.getError()});
                    }catch(e){return JSON.stringify({error:String(e),stack:e.stack})}})()
                """.trimIndent())
                val report = JSONObject(result.stringValue ?: "{}")
                println("CANVAS_BINARY_REPORT=$report")
                assertEquals(report.toString(), !legacy, report.optBoolean("binary"))
                assertTrue(report.toString(), report.optBoolean("compressed"))
                assertTrue(report.toString(), report.optBoolean("exact"))
                assertTrue(report.toString(), report.optBoolean("ordered"))
                assertEquals(report.toString(), 0, report.getInt("error"))
                if (!legacy) {
                    val delayed = CountDownLatch(1)
                    scenario.onActivity { web.evaluateJavascript("""
                        globalThis.__originalPortPost=MessagePort.prototype.postMessage;
                        MessagePort.prototype.postMessage=function(value,...args){
                            if(typeof value==='string'&&value.endsWith('\nnull'))setTimeout(()=>__originalPortPost.call(this,value,...args),250);
                            else __originalPortPost.call(this,value,...args);
                        };
                    """.trimIndent()) { delayed.countDown() } }
                    assertTrue(delayed.await(5, TimeUnit.SECONDS))
                    try {
                        val pressure = JSONObject(core.evaluate("""
                            (()=>{try{const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
                                for(let i=0;i<512;i++){gl.bufferData(gl.ARRAY_BUFFER,new Uint8Array([i&255,0,0,0]),gl.DYNAMIC_DRAW);gl.canvas.flushOperations()}
                                const size=gl.getBufferParameter(gl.ARRAY_BUFFER,gl.BUFFER_SIZE);gl.deleteBuffer(buffer);
                                return JSON.stringify({size,errorCode:gl.getError()});
                            }catch(e){return JSON.stringify({error:String(e)})}})()
                        """.trimIndent()).stringValue ?: "{}")
                        assertFalse("Delayed acknowledgements must apply backpressure without dropping GL commands: $pressure", pressure.has("error"))
                        assertEquals(4, pressure.getInt("size")); assertEquals(0, pressure.getInt("errorCode"))
                    } finally {
                        val restored = CountDownLatch(1)
                        scenario.onActivity { web.evaluateJavascript("MessagePort.prototype.postMessage=__originalPortPost") { restored.countDown() } }
                        assertTrue(restored.await(5, TimeUnit.SECONDS))
                    }
                }
                if (!legacy && InstrumentationRegistry.getArguments().getString("pag") == "true") {
                    val appRoot = File(context.filesDir, "jsapp/$appId").apply { mkdirs() }
                    try {
                        val assets = File(appRoot, "main/pages/libpag/assets").apply { mkdirs() }
                        for (name in listOf("libpag.wasm.br", "video.pag")) {
                            instrumentation.context.assets.open("generated/pag/$name").use { input ->
                                File(assets, name).outputStream().use { input.copyTo(it) }
                            }
                        }
                        val library = instrumentation.context.assets.open("generated/pag/index.js").bufferedReader().use { it.readText() }
                        core.invoke("canvas-pixels") {
                            val done = CountDownLatch(1)
                            var value: String? = null
                            instrumentation.runOnMainSync {
                                web.evaluateJavascript("""
                                    (()=>{const canvas=document.querySelector('canvas[data-dimina-game-canvas]');if(!canvas)return {error:'visible game canvas missing'};
                                    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
                                    let hash=2166136261,alpha=0;for(let i=0;i<pixels.length;i++){hash=Math.imul(hash^pixels[i],16777619);if(i%4===3)alpha+=pixels[i]}
                                    return {hash:hash>>>0,alpha}})()
                                """.trimIndent()) { result -> value = result; done.countDown() }
                            }
                            assertTrue(done.await(5, TimeUnit.SECONDS))
                            com.didi.dimina.engine.qjs.JSValue.createObject(value ?: "{}")
                        }
                        core.evaluate("modDefine('pag-benchmark',function(require,module,exports){$library\n});globalThis.__pagCanvasReport=function(value){globalThis.__pagCanvasResult=value};globalThis.__pagPresentedPixels=()=>DiminaServiceBridge.invoke({type:'testPixels',target:'container',body:{bridgeId:'canvas-pixels'}});")
                        core.evaluate(instrumentation.context.assets.open("pag-canvas-benchmark.js").bufferedReader().use { it.readText() })
                        val pagDeadline = System.currentTimeMillis() + 150_000
                        var measured = ""
                        while (measured.isEmpty() && System.currentTimeMillis() < pagDeadline) {
                            Thread.sleep(500)
                            scenario.onActivity { assertTrue("PAG performance requires a foreground WebView", web.hasWindowFocus()) }
                            measured = core.evaluate("globalThis.__pagCanvasResult || ''").stringValue ?: ""
                        }
                        val pag = JSONObject(measured)
                        instrumentation.sendStatus(0, android.os.Bundle().apply { putString("stream", "\nPAG_CANVAS_REPORT=$pag\n") })
                        assertFalse(pag.toString(), pag.has("error"))
                        val hashes = pag.getJSONArray("pixels")
                        assertEquals(2, hashes.length())
                        assertEquals(hashes.getJSONArray(0).toString(), hashes.getJSONArray(1).toString())
                    } finally {
                        appRoot.deleteRecursively()
                        PathUtils.appUserRoot(context, appId).deleteRecursively()
                        PathUtils.appTempRoot(context, appId).deleteRecursively()
                    }
                }
            } finally {
                scenario.onActivity { bridge.destroy(); web.destroy() }
                core.destroy()
                VersionUtils.setJSVersion(oldVersion)
            }
        }
    }
}
