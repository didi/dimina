package com.didi.dimina.ui.view

import android.content.Context
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout

/**
 * Transparent native component layer above the WebView.
 *
 * It only consumes touches that hit visible native children, so normal WebView
 * interactions still work in empty overlay areas.
 */
class NativeComponentOverlay(context: Context) : FrameLayout(context) {
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (!hasTouchableChildAt(ev.x, ev.y)) {
            return false
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun hasTouchableChildAt(x: Float, y: Float): Boolean {
        val children = (0 until childCount)
            .map { getChildAt(it) }
            .sortedWith(compareBy<View> { it.z }.thenBy { indexOfChild(it) })
            .asReversed()
        for (child in children) {
            if (child.visibility != View.VISIBLE || !child.isClickable) {
                continue
            }
            if (
                x >= child.left &&
                x <= child.right &&
                y >= child.top &&
                y <= child.bottom
            ) {
                return true
            }
        }
        return false
    }
}
