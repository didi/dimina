package com.didi.dimina.api.route

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniProgramRouteContractTest {
    @Test
    fun `navigateTo defaults to release and lets bundled config choose the path`() {
        val result = MiniProgramRouteContract.navigateTo(
            JSONObject().apply {
                put("appId", "target-app")
                put("extraData", JSONObject().put("ticket", 42))
            },
            currentAppId = "opener-app",
        ).getOrThrow()

        assertEquals("target-app", result.appId)
        assertNull(result.path)
        assertEquals("release", result.envVersion)
        assertEquals(42, result.extraData.getInt("ticket"))
    }

    @Test
    fun `navigateTo rejects unsupported environments and recursive app ids`() {
        val trial = MiniProgramRouteContract.navigateTo(
            JSONObject().put("appId", "target").put("envVersion", "trial"),
            currentAppId = "current",
        )
        val recursive = MiniProgramRouteContract.navigateTo(
            JSONObject().put("appId", "current"),
            currentAppId = "current",
        )

        assertTrue(trial.isFailure)
        assertTrue(recursive.isFailure)
    }

    @Test
    fun `navigateTo rejects unsupported short links`() {
        val result = MiniProgramRouteContract.navigateTo(
            JSONObject()
                .put("shortLink", "#小程序://example"),
            currentAppId = "current",
        )

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message?.contains("shortLink") == true)
    }

    @Test
    fun `navigateTo rejects unsupported no relaunch behavior instead of ignoring it`() {
        val result = MiniProgramRouteContract.navigateTo(
            JSONObject()
                .put("appId", "target")
                .put("noRelaunchIfPathUnchanged", true),
            currentAppId = "current",
        )

        assertTrue(result.isFailure)
    }

    @Test
    fun `extraData must be an object`() {
        val result = MiniProgramRouteContract.navigateTo(
            JSONObject().put("appId", "target").put("extraData", "not-an-object"),
            currentAppId = "current",
        )

        assertTrue(result.isFailure)
    }

    @Test
    fun `restart requires a nonempty path`() {
        assertEquals(
            "pages/result/index?from=restart",
            MiniProgramRouteContract.restartPath(
                JSONObject().put("path", " pages/result/index?from=restart "),
            ).getOrThrow(),
        )
        assertTrue(MiniProgramRouteContract.restartPath(JSONObject()).isFailure)
        assertTrue(
            MiniProgramRouteContract.restartPath(JSONObject().put("path", "  ")).isFailure,
        )
    }

    @Test
    fun `mini program operation guard rejects overlap and can be reused after completion`() {
        val guard = MiniProgramOperationGuard()

        assertTrue(guard.tryBegin())
        assertTrue(!guard.tryBegin())
        guard.end()
        assertTrue(guard.tryBegin())
    }
}
