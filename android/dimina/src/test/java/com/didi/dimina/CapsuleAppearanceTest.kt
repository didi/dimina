package com.didi.dimina

import android.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Test

class CapsuleAppearanceTest {
    @Test
    fun defaultCapsuleFollowsPageForeground() {
        val config = Dimina.DiminaConfig.Builder().build()
        assertEquals(Color.WHITE, config.resolveCapsuleIconColor(true))
        assertEquals(0x26000000, config.resolveCapsuleBackgroundColor(true))
        assertEquals(0xFF1F1F1F.toInt(), config.resolveCapsuleIconColor(false))
        assertEquals(0x99FFFFFF.toInt(), config.resolveCapsuleBackgroundColor(false))
    }

    @Test
    fun explicitColorsIncludingLegacyDefaultsRemainHostOverrides() {
        val config = Dimina.DiminaConfig.Builder()
            .setCapsuleBackgroundColor(Color.WHITE)
            .setCapsuleIconColor(0xFF1F1F1F.toInt())
            .build()
        assertEquals(Color.WHITE, config.resolveCapsuleBackgroundColor(true))
        assertEquals(0xFF1F1F1F.toInt(), config.resolveCapsuleIconColor(true))
    }
}
