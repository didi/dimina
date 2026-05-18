package com.didi.dimina.ui.view

import android.content.Context
import android.widget.FrameLayout

/**
 * Transparent native component layer below the WebView.
 *
 * The WebView stays on top so normal HTML can cover native components. Touches
 * for native placeholders are forwarded explicitly from the render layer after
 * DOM hit testing.
 */
class NativeComponentOverlay(context: Context) : FrameLayout(context)
