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
    fun `mini program results carry the same errMsg into complete`() {
        val success = miniProgramSuccessResult("exitMiniProgram") {}
        val failure = miniProgramErrorResult("restartMiniProgram", "path is required")

        assertTrue(success.completeCarriesResult)
        assertEquals("exitMiniProgram:ok", success.value.getString("errMsg"))
        assertTrue(failure.completeCarriesResult)
        assertTrue(failure.value.getString("errMsg").startsWith("restartMiniProgram:fail"))
    }
}
