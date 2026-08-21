package com.didi.dimina

import android.content.pm.ActivityInfo
import com.didi.dimina.bean.AppConfig
import com.didi.dimina.bean.MergedPageConfig
import com.didi.dimina.bean.PageModule
import com.didi.dimina.bean.WindowConfig
import com.didi.dimina.common.PageOrientation
import com.didi.dimina.common.Utils
import com.didi.dimina.core.MiniApp
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageOrientationCapabilityTest {
    @Test
    fun `page orientation is opt-in for existing hosts`() {
        val config = Dimina.DiminaConfig.Builder().build()

        assertFalse(config.pageOrientationEnabled)
    }

    @Test
    fun `host can explicitly enable page orientation`() {
        val config = Dimina.DiminaConfig.Builder()
            .setPageOrientationEnabled(true)
            .build()

        assertTrue(config.pageOrientationEnabled)
    }

    @Test
    fun `invalid page values fall through and missing values default to portrait`() {
        assertEquals(PageOrientation.LANDSCAPE, PageOrientation.resolve("invalid", "landscape"))
        assertEquals(PageOrientation.PORTRAIT, PageOrientation.resolve(null, null))
    }

    @Test
    fun `orientation model owns Android system mappings`() {
        assertEquals(
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT,
            PageOrientation.toRequestedOrientation(PageOrientation.PORTRAIT),
        )
        assertEquals(
            ActivityInfo.SCREEN_ORIENTATION_USER,
            PageOrientation.toRequestedOrientation(PageOrientation.AUTO),
        )
        assertEquals(
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE,
            PageOrientation.toRequestedOrientation(PageOrientation.LANDSCAPE),
        )
    }

    @Test
    fun `serialized orientation fields remain outside published constructors`() {
        val config = Json.decodeFromString<AppConfig>(
            """{
                "app":{"pages":["pages/index"],"window":{"pageOrientation":"landscape"}},
                "modules":{"pages/index":{"pageOrientation":"auto"}}
            }""",
        )

        assertEquals(PageOrientation.LANDSCAPE, config.app.window?.pageOrientation)
        assertEquals(PageOrientation.AUTO, config.modules["pages/index"]?.pageOrientation)
        assertEquals(
            PageOrientation.AUTO,
            Utils.mergePageConfig(config.app, config.modules["pages/index"]).pageOrientation,
        )
    }

    @Test
    fun `orientation additions retain legacy JVM call shapes`() {
        assertTrue(WindowConfig::class.java.declaredConstructors.any { it.parameterCount == 6 })
        assertTrue(PageModule::class.java.declaredConstructors.any { it.parameterCount == 9 })
        assertTrue(MergedPageConfig::class.java.declaredConstructors.any { it.parameterCount == 7 })
        assertTrue(MiniApp::class.java.declaredMethods.any {
            it.name == "openApp" && it.parameterCount == 2
        })
        assertTrue(DiminaActivity.Companion::class.java.declaredMethods.any {
            it.name == "launch" && it.parameterCount == 3
        })
    }
}
