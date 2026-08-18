package com.didi.dimina.ui.view

import androidx.core.graphics.Insets
import org.junit.Assert.assertEquals
import org.junit.Test

class MiniProgramWindowInsetsPolicyTest {
    @Test
    fun `clears top while preserving landscape sides and bottom`() {
        val adjusted = MiniProgramWindowInsetsPolicy.withoutTopInset(
            Insets.of(12, 48, 16, 36)
        )

        assertEquals(Insets.of(12, 0, 16, 36), adjusted)
    }
}
