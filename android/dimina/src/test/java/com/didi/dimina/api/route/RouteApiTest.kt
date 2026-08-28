package com.didi.dimina.api.route

import com.didi.dimina.api.ApiRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RouteApiTest {
    @Test
    fun `registers page and mini program navigation APIs`() {
        val registry = ApiRegistry()

        RouteApi().registerWith(registry)

        val names = registry.getRegisteredApiNames()
        listOf(
            "navigateTo",
            "redirectTo",
            "navigateBack",
            "reLaunch",
            "switchTab",
            "navigateToMiniProgram",
            "navigateBackMiniProgram",
            "exitMiniProgram",
            "restartMiniProgram",
        ).forEach { name ->
            assertTrue("missing $name", names.contains(name))
        }
    }

    @Test
    fun `a failed operation neither escapes the runtime queue nor holds the guard`() {
        val guard = MiniProgramOperationGuard()

        val result = miniProgramOperationResult("navigateToMiniProgram", guard) {
            throw IllegalStateException("activity refused to start")
        }
        // afterComplete runs on the JS runtime queue, where an exception has nowhere to go but
        // through the message loop.
        result.afterComplete?.invoke()

        assertEquals("navigateToMiniProgram:ok", result.value.getString("errMsg"))
        assertTrue("the guard must admit a retry", guard.tryBegin())
    }

    @Test
    fun `a second operation is rejected while one is still running`() {
        val guard = MiniProgramOperationGuard()

        val first = miniProgramOperationResult("navigateToMiniProgram", guard) {}
        val second = miniProgramOperationResult("exitMiniProgram", guard) {}

        assertEquals("navigateToMiniProgram:ok", first.value.getString("errMsg"))
        val rejection = second.value.getString("errMsg")
        assertTrue(rejection, rejection.startsWith("exitMiniProgram:fail"))
        assertTrue(rejection, rejection.contains("another mini program operation is in progress"))
    }

    @Test
    fun `mini program results carry the same errMsg into complete`() {
        val success = miniProgramSuccessResult("exitMiniProgram") {}
        val failure = miniProgramErrorResult("restartMiniProgram", "path is required")

        assertTrue(success.completeCarriesResult)
        assertEquals("exitMiniProgram:ok", success.value.getString("errMsg"))
        assertTrue(failure.completeCarriesResult)
        assertTrue(failure.value.getString("errMsg").startsWith("restartMiniProgram:fail"))
    }
}
