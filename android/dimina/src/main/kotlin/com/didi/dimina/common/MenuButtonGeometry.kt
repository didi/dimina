package com.didi.dimina.common

data class MenuButtonRect(
    val width: Int,
    val height: Int,
    val top: Int,
    val right: Int,
    val bottom: Int,
    val left: Int,
)

object MenuButtonLayout {
    const val WIDTH_DP = 87
    const val HEIGHT_DP = 32
    const val TRAILING_SPACING_DP = 10
    const val NAVIGATION_BAR_CONTENT_HEIGHT_DP = 64
    const val TRAILING_OCCUPIED_WIDTH_DP = WIDTH_DP + TRAILING_SPACING_DP

    fun calculate(windowWidth: Int, statusBarHeight: Int): MenuButtonRect {
        val right = (windowWidth - TRAILING_SPACING_DP).coerceAtLeast(WIDTH_DP)
        val top = statusBarHeight + (NAVIGATION_BAR_CONTENT_HEIGHT_DP - HEIGHT_DP) / 2
        return MenuButtonRect(
            width = WIDTH_DP,
            height = HEIGHT_DP,
            top = top,
            right = right,
            bottom = top + HEIGHT_DP,
            left = right - WIDTH_DP,
        )
    }
}
