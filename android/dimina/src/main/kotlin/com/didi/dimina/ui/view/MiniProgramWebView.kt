package com.didi.dimina.ui.view

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.view.SoftwareKeyboardControllerCompat

/** Connect DOM editing focus to Android's input connection, including focus before window ready. */
@SuppressLint("ViewConstructor")
internal class MiniProgramWebView(context: Context) : WebView(context) {
    var renderBridgeCleanup: (() -> Unit)? = null

    fun clearRenderBridge() {
        renderBridgeCleanup?.invoke()
        renderBridgeCleanup = null
    }
    private var focusGeneration = 0
    private var keyboardPending = false
    var isPageActive = false
        set(value) {
            if (field == value) return
            field = value
            if (value) {
                if (isAttachedToWindow) requestFocus()
                showPendingKeyboard()
            } else {
                cancelPendingKeyboard()
            }
        }

    init {
        addJavascriptInterface(object {
            @JavascriptInterface
            fun focusChanged(editing: Boolean) {
                post {
                    focusGeneration++
                    keyboardPending = editing && isPageActive
                    showPendingKeyboard()
                }
            }
        }, "DiminaKeyboardBridge")
    }

    fun resetKeyboardFocus() = cancelPendingKeyboard()

    private val editingExpression = """
        (function () {
            var el = document.activeElement;
            return !!el && !el.disabled && !el.readOnly &&
                (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' &&
                /^(text|search|tel|url|email|password|number)$/.test(el.type)));
        })()
    """.trimIndent()

    fun installKeyboardFocusObserver() {
        evaluateJavascript("""
            (function () {
                if (window.__diminaKeyboardFocusObserver) return;
                window.__diminaKeyboardFocusObserver = true;
                function syncFocus() {
                    DiminaKeyboardBridge.focusChanged($editingExpression);
                }
                document.addEventListener('focusin', syncFocus);
                document.addEventListener('focusout', function () {
                    DiminaKeyboardBridge.focusChanged(false);
                });
                syncFocus();
            })();
        """.trimIndent(), null)
    }

    private fun cancelPendingKeyboard() {
        focusGeneration++
        keyboardPending = false
    }

    private fun showPendingKeyboard() {
        if (!keyboardPending || !isPageActive || !isAttachedToWindow || !hasWindowFocus() || !isShown) return
        val generation = focusGeneration
        // Recheck after crossing the JS/UI thread boundary: blur, unmount or navigation may have won.
        evaluateJavascript(editingExpression) { editing ->
            if (generation != focusGeneration || !keyboardPending || !isPageActive ||
                !isAttachedToWindow || !hasWindowFocus() || !isShown) return@evaluateJavascript
            keyboardPending = false
            if (editing == "true") {
                requestFocus()
                SoftwareKeyboardControllerCompat(this).show()
            }
        }
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        // Without native focus, Chromium can change activeElement without dispatching focusin.
        // Only the selected page owns focus; pooled and background tab WebViews must not take it.
        if (isPageActive) requestFocus()
        showPendingKeyboard()
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (hasWindowFocus) showPendingKeyboard()
    }

    override fun onDetachedFromWindow() {
        cancelPendingKeyboard()
        super.onDetachedFromWindow()
    }

    override fun destroy() {
        clearRenderBridge()
        cancelPendingKeyboard()
        removeJavascriptInterface("DiminaKeyboardBridge")
        super.destroy()
    }
}
