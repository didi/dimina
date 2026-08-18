package com.didi.dimina.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MenuButtonGeometryTest {
    @Test
    fun `calculates rect in the mini program window coordinate space`() {
        val rect = MenuButtonLayout.calculate(windowWidth = 409, statusBarHeight = 48)

        assertEquals(399, rect.right)
        assertEquals(312, rect.left)
        assertEquals(64, rect.top)
        assertEquals(rect.right, rect.left + rect.width)
        assertEquals(rect.bottom, rect.top + rect.height)
    }

    @Test
    fun `keeps geometry inside a compact window`() {
        val rect = MenuButtonLayout.calculate(windowWidth = 90, statusBarHeight = 20)

        assertEquals(0, rect.left)
        assertTrue(rect.right <= 90)
    }
}
