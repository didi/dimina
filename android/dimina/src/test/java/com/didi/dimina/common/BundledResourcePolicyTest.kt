package com.didi.dimina.common

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BundledResourcePolicyTest {
    @Test
    fun `release first launch extracts JSSDK and jsapp independently`() {
        val shouldExtractJSSdk = BundledResourcePolicy.shouldExtract(
            bundledVersion = 20,
            installedVersion = 0,
            requiredResourcePresent = false,
        )
        val shouldExtractJsApp = BundledResourcePolicy.shouldExtract(
            bundledVersion = 1,
            installedVersion = 0,
            requiredResourcePresent = false,
        )

        assertTrue(shouldExtractJSSdk)
        assertTrue(shouldExtractJsApp)
    }

    @Test
    fun `missing extracted resource forces recovery even when version is current`() {
        assertTrue(
            BundledResourcePolicy.shouldExtract(
                bundledVersion = 20,
                installedVersion = 20,
                requiredResourcePresent = false,
            )
        )
    }

    @Test
    fun `newer bundled version is extracted`() {
        assertTrue(
            BundledResourcePolicy.shouldExtract(
                bundledVersion = 21,
                installedVersion = 20,
                requiredResourcePresent = true,
            )
        )
    }

    @Test
    fun `available current or newer installed resource is preserved`() {
        assertFalse(
            BundledResourcePolicy.shouldExtract(
                bundledVersion = 20,
                installedVersion = 20,
                requiredResourcePresent = true,
            )
        )
        assertFalse(
            BundledResourcePolicy.shouldExtract(
                bundledVersion = 20,
                installedVersion = 21,
                requiredResourcePresent = true,
            )
        )
    }
}
