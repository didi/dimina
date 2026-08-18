package com.didi.dimina.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BundledMiniProgramResolverTest {
    private val config = """
        {
          "appId": "target-app",
          "name": "Target",
          "path": "pages/home/index",
          "versionCode": 7,
          "versionName": "1.2.3",
          "updateManifestUrl": "https://example.com/manifest.json"
        }
    """.trimIndent()

    @Test
    fun `uses bundled entry path when request omits path`() {
        val metadata = BundledMiniProgramResolver.parse(
            requestedAppId = "target-app",
            configJson = config,
            requestedPath = null,
        ).getOrThrow()

        assertEquals("pages/home/index", metadata.path)
        assertEquals(7, metadata.versionCode)
        assertEquals("1.2.3", metadata.versionName)
    }

    @Test
    fun `request path overrides bundled entry and retains query`() {
        val metadata = BundledMiniProgramResolver.parse(
            requestedAppId = "target-app",
            configJson = config,
            requestedPath = "pages/detail/index?id=9",
        ).getOrThrow()

        assertEquals("pages/detail/index?id=9", metadata.path)
    }

    @Test
    fun `rejects mismatched or unsafe app ids`() {
        assertTrue(
            BundledMiniProgramResolver.parse("other-app", config, null).isFailure,
        )
        assertTrue(
            BundledMiniProgramResolver.parse("../target-app", config, null).isFailure,
        )
    }
}
