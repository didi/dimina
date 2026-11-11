package com.didi.dimina.ui.container

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MiniProgramActivityRegistryTest {
    @org.junit.Test
    fun `close every app drains all owners before callbacks and preserves newly registered pages`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("a", "a-root")
        registry.register("a", "a-detail")
        registry.register("b", "b-root")
        val closed = mutableListOf<String>()
        registry.closeEveryApp {
            org.junit.Assert.assertNull(registry.lastRegistered("b"))
            closed.add(it)
            if (it == "a-root") registry.register("a", "new-root")
        }
        org.junit.Assert.assertEquals(listOf("b-root", "a-detail", "a-root"), closed)
        org.junit.Assert.assertEquals("new-root", registry.lastRegistered("a"))
        registry.closeEveryApp { closed.add(it) }
        registry.closeEveryApp { error("empty cleanup must be idempotent") }
        org.junit.Assert.assertEquals("new-root", closed.last())
    }

    @Test
    fun `lastRegistered returns the current top page without removing it`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app", "root")
        registry.register("app", "page-1")
        registry.register("app", "page-2")

        assertEquals("page-2", registry.lastRegistered("app"))

        val closed = mutableListOf<String>()
        registry.closeAll("app", closed::add)
        assertEquals(listOf("page-2", "page-1", "root"), closed)
    }

    @Test
    fun `lastRegistered returns null for an unknown or emptied mini program`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app", "root")
        registry.unregister("app", "root")

        assertNull(registry.lastRegistered("app"))
        assertNull(registry.lastRegistered("missing"))
    }

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

    @Test
    fun `navigateBack closes delta pages from top and leaves other mini programs untouched`() {
        val registry = MiniProgramActivityRegistry<String>()
        listOf("root", "page-1", "page-2", "page-3").forEach { registry.register("app", it) }
        registry.register("other", "other-root")
        val closed = mutableListOf<String>()

        assertTrue(registry.navigateBack("app", 2, closed::add))

        assertEquals(listOf("page-3", "page-2"), closed)
        assertEquals(listOf("root", "page-1"), registry.snapshot("app"))
        assertEquals(listOf("other-root"), registry.snapshot("other"))
    }

    @Test
    fun `navigateBack clamps an oversized delta and preserves the first page`() {
        val registry = MiniProgramActivityRegistry<String>()
        listOf("root", "page-1", "page-2").forEach { registry.register("app", it) }
        val closed = mutableListOf<String>()

        assertTrue(registry.navigateBack("app", Int.MAX_VALUE, closed::add))

        assertEquals(listOf("page-2", "page-1"), closed)
        assertEquals(listOf("root"), registry.snapshot("app"))
    }

    @Test
    fun `navigateBack fails at the first page without closing or hiding it`() {
        val registry = MiniProgramActivityRegistry<String>()
        registry.register("app", "root")
        val closed = mutableListOf<String>()

        org.junit.Assert.assertFalse(registry.navigateBack("app", 1, closed::add))
        org.junit.Assert.assertFalse(registry.navigateBack("missing", 1, closed::add))

        assertTrue(closed.isEmpty())
        assertEquals(listOf("root"), registry.snapshot("app"))
    }

    @Test
    fun `navigateBack removes pending destroys before closing and retains newly opened pages`() {
        val registry = MiniProgramActivityRegistry<String>()
        listOf("root", "page-1", "page-2", "page-3").forEach { registry.register("app", it) }
        val closed = mutableListOf<String>()

        assertTrue(registry.navigateBack("app", 2) { page ->
            assertEquals(listOf("root", "page-1"), registry.snapshot("app"))
            closed.add(page)
        })
        assertTrue(registry.navigateBack("app", 1) { page ->
            assertEquals(listOf("root"), registry.snapshot("app"))
            closed.add(page)
            registry.register("app", "new-page")
        })
        listOf("page-1", "page-2", "page-3").forEach { registry.unregister("app", it) }

        assertEquals(listOf("page-3", "page-2", "page-1"), closed)
        assertEquals(listOf("root", "new-page"), registry.snapshot("app"))
    }
}
