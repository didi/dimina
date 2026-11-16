package com.didi.dimina

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.didi.dimina.api.ui.LoadingTestActivity
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.StoreUtils
import com.didi.dimina.ui.view.createWebViewClientWithInterceptor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class HostImagesWebViewTest {
    class Result {
        val ready = CountDownLatch(1)
        var value = ""
        @JavascriptInterface fun report(result: String) { value = result; ready.countDown() }
    }

    @Test fun webViewDecodesHostFilesAssetsDirectoriesAndRawResources() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        StoreUtils.initialize(context)
        val root = File(context.cacheDir, "host-images-${UUID.randomUUID()}").apply { mkdirs() }
        val bitmap = Bitmap.createBitmap(2, 3, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.RED) }
        val ids = listOf("formats", "Light_ON", "asset", "assets", "raw")
        try {
            mapOf("png" to Bitmap.CompressFormat.PNG, "jpg" to Bitmap.CompressFormat.JPEG, "webp" to Bitmap.CompressFormat.WEBP)
                .forEach { (extension, format) -> File(root, "image.$extension").outputStream().use { bitmap.compress(format, 100, it) } }
            HostImages.registerDirectory("formats", root)
            HostImages.registerFile("Light_ON", File(root, "image.png"))
            HostImages.registerAsset("asset", instrumentation.context, "host-images/nested/light.svg")
            HostImages.registerAssetDirectory("assets", instrumentation.context, "host-images")
            HostImages.registerResource("raw", instrumentation.context, com.didi.dimina.test.R.raw.host_image)
            val first = Result()
            val second = Result()
            lateinit var web: WebView
            ActivityScenario.launch<LoadingTestActivity>(Intent(context, LoadingTestActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    web = WebView(activity)
                    web.settings.javaScriptEnabled = true
                    web.webViewClient = createWebViewClientWithInterceptor(activity)
                    web.addJavascriptInterface(first, "testResult")
                    web.addJavascriptInterface(second, "missingResult")
                    activity.setContentView(web)
                    web.loadDataWithBaseURL("https://${PathUtils.WEBVIEW_ASSET_DOMAIN}/pageFrame.html", """
                        <body><script>
                        const paths = ['formats/image.png', 'formats/image.jpg', 'formats/image.webp', 'Light_ON', 'asset', 'assets/nested/light.svg', 'raw'];
                        Promise.all(paths.map(path => new Promise(resolve => {
                            const image = new Image();
                            image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
                            image.onerror = () => resolve([-1, -1]);
                            image.src = '/__dimina_host_images/' + path;
                            document.body.appendChild(image);
                        }))).then(result => testResult.report(JSON.stringify({result})));
                        </script></body>
                    """.trimIndent(), "text/html", "UTF-8", null)
                }
                assertTrue("Host image requests finish", first.ready.await(20, TimeUnit.SECONDS))
                val result = JSONObject(first.value).getJSONArray("result")
                assertEquals(7, result.length())
                for (index in 0 until result.length()) {
                    assertEquals(first.value, 2, result.getJSONArray(index).getInt(0))
                    assertEquals(first.value, 3, result.getJSONArray(index).getInt(1))
                }
                HostImages.unregister("formats")
                scenario.onActivity {
                    web.evaluateJavascript("""
                        (() => { const image = new Image();
                          image.onload = () => missingResult.report('loaded');
                          image.onerror = () => missingResult.report('failed');
                          image.src = '/__dimina_host_images/formats/image.png?after-unregister';
                        })()
                    """.trimIndent(), null)
                }
                assertTrue(second.ready.await(10, TimeUnit.SECONDS))
                assertEquals("failed", second.value)
                scenario.onActivity { web.destroy() }
            }
        } finally { ids.forEach { HostImages.unregister(it) }; bitmap.recycle(); root.deleteRecursively() }
    }
}
