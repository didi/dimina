package com.didi.dimina.ui.container

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniProgramActivityRegistryTest {
    @Test
    fun `closeAll closes every page of the requested mini program from top to root`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")
        registry.register("app-a", "page-2")
        registry.register("app-b", "other-app-root")

        val closed = mutableListOf<String>()
        registry.closeAll("app-a", closed::add)
        registry.closeAll("app-b", closed::add)

        assertEquals(listOf("page-2", "page-1", "root", "other-app-root"), closed)
    }

    @Test
    fun `unregistered pages are not closed`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app", "root")
        registry.register("app", "page")
        registry.unregister("app", "page")

        val closed = mutableListOf<String>()
        registry.closeAll("app", closed::add)

        assertEquals(listOf("root"), closed)
    }

    @Test
    fun `closeAllExcept closes every other page in top to root order and returns the kept page`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")
        registry.register("app-a", "page-2")
        registry.register("app-a", "page-3")

        val closed = mutableListOf<String>()
        val kept = registry.closeAllExcept("app-a", { it == "page-1" }, closed::add)

        assertEquals("page-1", kept)
        assertEquals(listOf("page-3", "page-2", "root"), closed)
    }

    @Test
    fun `closeAllExcept closes every page and returns null when no page matches keep`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")
        registry.register("app-a", "page-2")

        val closed = mutableListOf<String>()
        val kept = registry.closeAllExcept("app-a", { false }, closed::add)

        assertNull(kept)
        assertEquals(listOf("page-2", "page-1", "root"), closed)
    }

    @Test
    fun `closeAllExcept closes nothing when the only registered page matches keep`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")

        val closed = mutableListOf<String>()
        val kept = registry.closeAllExcept("app-a", { it == "root" }, closed::add)

        assertEquals("root", kept)
        assertTrue(closed.isEmpty())
    }

    @Test
    fun `closeAllExcept leaves pages registered under other appIds untouched`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")
        registry.register("app-b", "other-app-root")

        val closedA = mutableListOf<String>()
        registry.closeAllExcept("app-a", { it == "root" }, closedA::add)

        // app-b's bucket must be untouched by the app-a call: if it had been drained too,
        // this closeAll would have nothing left to invoke close() on.
        val closedB = mutableListOf<String>()
        registry.closeAll("app-b", closedB::add)

        assertEquals(listOf("page-1"), closedA)
        assertEquals(listOf("other-app-root"), closedB)
    }

    @Test
    fun `closeAllExcept keeps the matched page registered so a later closeAll still closes it`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")

        val firstClosed = mutableListOf<String>()
        val kept = registry.closeAllExcept("app-a", { it == "root" }, firstClosed::add)
        assertEquals("root", kept)
        assertEquals(listOf("page-1"), firstClosed)

        // The kept page must remain in the registry's ledger, not merely be returned by value.
        val secondClosed = mutableListOf<String>()
        registry.closeAll("app-a", secondClosed::add)
        assertEquals(listOf("root"), secondClosed)
    }

    @Test
    fun `closeAllExcept keeps the first matching page in registration order when multiple pages match keep`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app-a", "root")
        registry.register("app-a", "page-1")
        registry.register("app-a", "page-2")
        registry.register("app-a", "page-3")

        val closed = mutableListOf<String>()
        val kept = registry.closeAllExcept("app-a", { it == "page-1" || it == "page-2" }, closed::add)

        assertEquals("page-1", kept)
        assertEquals(listOf("page-3", "page-2", "root"), closed)
    }
}
