package com.didi.dimina.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeMessageQueueTest {
    @Test
    fun `close runs after accepted lifecycle messages and rejects late work`() {
        val scheduled = mutableListOf<() -> Unit>()
        val events = mutableListOf<String>()
        val queue = RuntimeMessageQueue { action -> scheduled += action }

        assertTrue(queue.post { events += "pageUnload" })
        assertTrue(queue.closeAfterPending { events += "destroy" })
        assertFalse(queue.post { events += "late" })

        scheduled.forEach { it() }

        assertEquals(listOf("pageUnload", "destroy"), events)
    }

    @Test
    fun `a second close cannot bypass the queued destruction barrier`() {
        val scheduled = mutableListOf<() -> Unit>()
        val queue = RuntimeMessageQueue { action -> scheduled += action }

        assertTrue(queue.closeAfterPending {})
        assertFalse(queue.closeNow())
        assertEquals(1, scheduled.size)
    }
}
