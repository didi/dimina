package com.didi.dimina.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateCheckRegistryTest {
    @Test
    fun `starts once per app until reset`() {
        val registry = UpdateCheckRegistry()

        assertTrue(registry.begin("app-a"))
        assertFalse(registry.begin("app-a"))
        assertTrue(registry.begin("app-b"))

        registry.reset("app-a")

        assertTrue(registry.begin("app-a"))
        assertFalse(registry.begin("app-b"))
    }

    @Test
    fun `reset all allows every app to start again`() {
        val registry = UpdateCheckRegistry()
        registry.begin("app-a")
        registry.begin("app-b")

        registry.resetAll()

        assertTrue(registry.begin("app-a"))
        assertTrue(registry.begin("app-b"))
    }
}
