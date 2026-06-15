package com.didi.dimina.ui.container

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.didi.dimina.api.device.ScanCodeFormats
import com.didi.dimina.api.device.ScanCodeOptions
import com.didi.dimina.api.device.ScanCodePayload
import com.google.zxing.BarcodeFormat
import com.google.zxing.ResultPoint
import com.journeyapps.barcodescanner.BarcodeView
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import kotlin.math.roundToInt

class ScanCodeActivity : ComponentActivity() {
    private lateinit var barcodeView: BarcodeView
    private var finished = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val formats = resolveFormats()
        if (formats.isEmpty()) {
            finishWithCancel("invalid scanType")
            return
        }

        barcodeView = BarcodeView(this).apply {
            decoderFactory = DefaultDecoderFactory(formats)
            decodeContinuous(scanCallback)
        }

        setContentView(createContentView())
    }

    override fun onResume() {
        super.onResume()
        if (::barcodeView.isInitialized) {
            barcodeView.resume()
        }
    }

    override fun onPause() {
        if (::barcodeView.isInitialized) {
            barcodeView.pause()
        }
        super.onPause()
    }

    private fun createContentView(): FrameLayout {
        val root = FrameLayout(this)
        root.addView(
            barcodeView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        val closeButton = CloseButtonView(this).apply {
            setOnClickListener { finishWithCancel("cancel") }
        }
        root.addView(
            closeButton,
            FrameLayout.LayoutParams(
                CLOSE_BUTTON_SIZE_DP.dp(),
                CLOSE_BUTTON_SIZE_DP.dp(),
                Gravity.TOP or Gravity.START,
            ).apply {
                leftMargin = CLOSE_BUTTON_SIDE_MARGIN_DP.dp()
                topMargin = statusBarInset() + CLOSE_BUTTON_TOP_MARGIN_DP.dp()
            },
        )

        return root
    }

    private fun resolveFormats(): Collection<BarcodeFormat> {
        val names = intent.getStringArrayListExtra(EXTRA_FORMAT_NAMES)?.toSet().orEmpty()
        return names.mapNotNull { name ->
            runCatching { BarcodeFormat.valueOf(name) }.getOrNull()
        }
    }

    private val scanCallback = object : BarcodeCallback {
        override fun barcodeResult(result: BarcodeResult?) {
            if (finished || result == null || result.text.isNullOrEmpty()) {
                return
            }

            finished = true
            barcodeView.pause()

            val payload = ScanCodePayload.fromText(
                text = result.text,
                scanType = result.barcodeFormat.name,
                rawBytes = result.rawBytes,
            ).toJson(API_NAME)
            setResult(
                Activity.RESULT_OK,
                Intent().putExtra(EXTRA_RESULT_JSON, payload.toString()),
            )
            finish()
        }

        override fun possibleResultPoints(resultPoints: List<ResultPoint>) = Unit
    }

    private fun finishWithCancel(message: String) {
        if (finished) {
            return
        }
        finished = true
        setResult(
            Activity.RESULT_CANCELED,
            Intent().putExtra(EXTRA_ERROR_MESSAGE, message),
        )
        finish()
    }

    private fun Int.dp(): Int {
        return (this * resources.displayMetrics.density).roundToInt()
    }

    private fun statusBarInset(): Int {
        return ViewCompat.getRootWindowInsets(window.decorView)
            ?.getInsets(WindowInsetsCompat.Type.statusBars())
            ?.top ?: 0
    }

    companion object {
        const val EXTRA_FORMAT_NAMES = "com.didi.dimina.extra.SCAN_FORMAT_NAMES"
        const val EXTRA_RESULT_JSON = "com.didi.dimina.extra.SCAN_RESULT_JSON"
        const val EXTRA_ERROR_MESSAGE = "com.didi.dimina.extra.SCAN_ERROR_MESSAGE"
        private const val API_NAME = "scanCode"
        private const val CLOSE_BUTTON_SIZE_DP = 44
        private const val CLOSE_BUTTON_SIDE_MARGIN_DP = 16
        private const val CLOSE_BUTTON_TOP_MARGIN_DP = 32

        fun createIntent(context: Context, options: ScanCodeOptions): Intent {
            return Intent(context, ScanCodeActivity::class.java).putStringArrayListExtra(
                EXTRA_FORMAT_NAMES,
                ArrayList(ScanCodeFormats.zxingFormatNamesFor(options.scanTypes).sorted()),
            )
        }
    }
}

private class CloseButtonView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        strokeWidth = 2f * resources.displayMetrics.density
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val iconSize = 14f * resources.displayMetrics.density
        val centerX = width / 2f
        val centerY = height / 2f
        val half = iconSize / 2f
        canvas.drawLine(centerX - half, centerY - half, centerX + half, centerY + half, paint)
        canvas.drawLine(centerX + half, centerY - half, centerX - half, centerY + half, paint)
    }
}
