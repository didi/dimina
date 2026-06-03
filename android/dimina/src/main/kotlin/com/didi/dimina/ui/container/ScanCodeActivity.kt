package com.didi.dimina.ui.container

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import com.caverock.androidsvg.SVG
import androidx.activity.OnBackPressedCallback
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.zxing.BinaryBitmap
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors

/** 连续扫码最小间隔（毫秒），防止同码反复检测 */
private const val SCAN_DEBOUNCE_MS = 800L

/**
 * 扫码 Activity
 *
 * 根据 Android 版本使用不同的扫码引擎策略：
 * - Android 9+ (API 28+)：ML Kit Barcode Scanning
 *   （更准确，原生支持 DataMatrix、PDF417 等仓储常用格式）
 * - Android < 9 (API 26-27)：ZXing
 *   （轻量级，无 Google Play Services 依赖，支持所有常见 1D/2D 条码）
 */
class ScanCodeActivity : ComponentActivity() {

    private var isProcessing = false
    private var isScanning = true
    private var continuous = false
    private var canOpenAlbum = false
    private var previewView: PreviewView? = null

    // 连续扫码结果列表（Compose state）
    private val scanResults = mutableStateListOf<ScanResultItem>()

    // 已扫码去重（连续模式，存储规范化后的文本）
    private val scannedTexts = mutableSetOf<String>()

    // 上次扫码成功时间戳（毫秒），用于间隔控制
    private var lastScanTimeMs = 0L

    // 单次扫码结果（非连续模式，显示在底部面板待确认）
    private var singleResult by mutableStateOf<ScanResultItem?>(null)

    // UI 配置（通过 Intent 传入，可被 wx.scanCode 参数覆盖）
    private var config = ScanCodeConfig.DEFAULT

    // ML Kit 扫码器（Android 9+）
    private var mlKitScanner: BarcodeScanner? = null
    // ZXing 扫码器（Android < 9 备选方案）
    private var zxingReader: MultiFormatReader? = null

    private val cameraExecutor = Executors.newSingleThreadExecutor()

    private val albumLauncher =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null) {
                val bitmap = BitmapFactory.decodeStream(contentResolver.openInputStream(uri))
                bitmap?.let { decodeBitmap(it) }
            } else {
                finishWithCancel()
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        canOpenAlbum = intent.getBooleanExtra("canOpenAlbum", false)
        continuous = intent.getBooleanExtra("continuous", false)
        config = ScanCodeConfig.fromIntent(intent)
        initScanner()

        // 注册返回键处理（兼容 Android 13+）
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (continuous && scanResults.isNotEmpty()) {
                    finishWithBatchResults()
                } else {
                    finishWithCancel()
                }
            }
        })

        setContent {
            ScanCodeScreen(
                config = config,
                canOpenAlbum = canOpenAlbum,
                continuous = continuous,
                scanResults = scanResults,
                singleResult = singleResult,
                onConfirmClick = { result ->
                    finishWithResult(result.text, result.scanType)
                },
                onRescanClick = {
                    singleResult = null
                    isScanning = true
                },
                onFinishClick = { finishWithBatchResults() },
                onAlbumClick = { checkAlbumPermission() },
                onBackPress = {
                    if (continuous && scanResults.isNotEmpty()) {
                        finishWithBatchResults()
                    } else {
                        finishWithCancel()
                    }
                },
                onPreviewViewCreated = { pv ->
                    previewView = pv
                    startCamera()
                },
            )
        }
    }

    private fun initScanner() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Android 9+ → ML Kit
            mlKitScanner = BarcodeScanning.getClient()
        } else {
            // Android < 9 → ZXing
            zxingReader = MultiFormatReader().apply {
                val hints = HashMap<com.google.zxing.DecodeHintType, Any>()
                hints[com.google.zxing.DecodeHintType.POSSIBLE_FORMATS] = listOf(
                    com.google.zxing.BarcodeFormat.QR_CODE,
                    com.google.zxing.BarcodeFormat.CODE_128,
                    com.google.zxing.BarcodeFormat.CODE_39,
                    com.google.zxing.BarcodeFormat.CODE_93,
                    com.google.zxing.BarcodeFormat.EAN_13,
                    com.google.zxing.BarcodeFormat.EAN_8,
                    com.google.zxing.BarcodeFormat.UPC_A,
                    com.google.zxing.BarcodeFormat.UPC_E,
                    com.google.zxing.BarcodeFormat.CODABAR,
                    com.google.zxing.BarcodeFormat.ITF,
                    com.google.zxing.BarcodeFormat.DATA_MATRIX,
                    com.google.zxing.BarcodeFormat.PDF_417,
                )
                hints[com.google.zxing.DecodeHintType.TRY_HARDER] = true
                setHints(hints)
            }
        }
    }

    private fun startCamera() {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
        cameraProviderFuture.addListener({
            val cameraProvider = cameraProviderFuture.get()
            val preview = Preview.Builder().build()
            val imageAnalysis = ImageAnalysis.Builder()
                .setTargetResolution(android.util.Size(960, 1280))
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
                .also { analysis ->
                    analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                        if (!isProcessing && isScanning) {
                            processFrame(imageProxy)
                        } else {
                            imageProxy.close()
                        }
                    }
                }
            // 将 Preview 连接到 PreviewView 的输出 surface
            previewView?.let { pv ->
                preview.surfaceProvider = pv.surfaceProvider
            }

            try {
                cameraProvider.unbindAll()
                cameraProvider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_BACK_CAMERA, preview, imageAnalysis
                )
            } catch (e: Exception) {
                finishWithResult(null, "failed: camera error - ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun processFrame(imageProxy: ImageProxy) {
        isProcessing = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            processWithMLKit(imageProxy)
        } else {
            processWithZXing(imageProxy)
        }
    }

    /**
     * ML Kit 解码 — Android 9+
     */
    @androidx.annotation.RequiresApi(Build.VERSION_CODES.P)
    private fun processWithMLKit(imageProxy: ImageProxy) {
        @Suppress("DEPRECATION")
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            mlKitScanner?.process(inputImage)
                ?.addOnSuccessListener { barcodes ->
                    for (barcode in barcodes) {
                        val rawValue = barcode.rawValue
                        if (!rawValue.isNullOrBlank()) {
                            imageProxy.close()
                            if (continuous) {
                                // 连续模式：去重 + 间隔控制
                                val now = System.currentTimeMillis()
                                if (now - lastScanTimeMs >= SCAN_DEBOUNCE_MS) {
                                    val normalized = rawValue.trim()
                                    if (scannedTexts.add(normalized)) {
                                        scanResults.add(ScanResultItem(normalized, barcode.formatToScanType()))
                                    }
                                    lastScanTimeMs = now
                                }
                                isProcessing = false
                            } else {
                                // 非连续模式：暂停扫码，结果展示在底部面板，用户确认后回调
                                isScanning = false
                                isProcessing = false
                                singleResult = ScanResultItem(rawValue, barcode.formatToScanType())
                            }
                            return@addOnSuccessListener
                        }
                    }
                    isProcessing = false
                    imageProxy.close()
                }
                ?.addOnFailureListener {
                    isProcessing = false
                    imageProxy.close()
                }
        } else {
            isProcessing = false
            imageProxy.close()
        }
    }

    /**
     * ZXing 解码 — Android < 9
     */
    private fun processWithZXing(imageProxy: ImageProxy) {
        val bitmap = imageProxy.toBitmap()
        if (bitmap == null) {
            isProcessing = false
            imageProxy.close()
            return
        }
        try {
            val intArray = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(intArray, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            val source = RGBLuminanceSource(bitmap.width, bitmap.height, intArray)
            val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
            val result = zxingReader?.decodeWithState(binaryBitmap)
            if (result != null && !result.text.isNullOrBlank()) {
                imageProxy.close()
                if (continuous) {
                    val now = System.currentTimeMillis()
                    if (now - lastScanTimeMs >= SCAN_DEBOUNCE_MS) {
                        val normalized = result.text.trim()
                        if (scannedTexts.add(normalized)) {
                            scanResults.add(ScanResultItem(normalized, result.barcodeFormat.toScanType()))
                        }
                        lastScanTimeMs = now
                    }
                    isProcessing = false
                } else {
                    // 非连续模式：暂停扫码，结果展示在底部面板
                    isScanning = false
                    isProcessing = false
                    singleResult = ScanResultItem(result.text, result.barcodeFormat.toScanType())
                }
                return
            }
        } catch (_: Exception) { }
        isProcessing = false
        imageProxy.close()
    }

    /**
     * 从相册图片解码
     */
    private fun decodeBitmap(bitmap: Bitmap) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val inputImage = InputImage.fromBitmap(bitmap, 0)
            mlKitScanner?.process(inputImage)
                ?.addOnSuccessListener { barcodes ->
                    if (barcodes.isNotEmpty()) {
                        val barcode = barcodes[0]
                        val rawValue = barcode.rawValue
                        if (!rawValue.isNullOrBlank()) {
                            finishWithResult(rawValue, barcode.formatToScanType())
                            return@addOnSuccessListener
                        }
                    }
                    Toast.makeText(this, "未识别到条码", Toast.LENGTH_SHORT).show()
                }
                ?.addOnFailureListener {
                    Toast.makeText(this, "识别失败", Toast.LENGTH_SHORT).show()
                }
        } else {
            try {
                val intArray = IntArray(bitmap.width * bitmap.height)
                bitmap.getPixels(intArray, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
                val source = RGBLuminanceSource(bitmap.width, bitmap.height, intArray)
                val binaryBitmap = BinaryBitmap(HybridBinarizer(source))
                val result = zxingReader?.decodeWithState(binaryBitmap)
                if (result != null && !result.text.isNullOrBlank()) {
                    finishWithResult(result.text, result.barcodeFormat.toScanType())
                } else {
                    Toast.makeText(this, "未识别到条码", Toast.LENGTH_SHORT).show()
                }
            } catch (_: Exception) {
                Toast.makeText(this, "识别失败", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun checkAlbumPermission() {
        // 系统相册选择器（Photo Picker）无需 READ_MEDIA_IMAGES 等存储权限
        albumLauncher.launch("image/*")
    }

    private fun finishWithResult(text: String?, scanType: String?) {
        Intent().apply {
            if (text != null) {
                putExtra("result", text)
                putExtra("scanType", scanType ?: "UNKNOWN")
                putExtra("charSet", "utf-8")
                putExtra("errMsg", "scanCode:ok")
            } else {
                putExtra("errMsg", "scanCode:fail")
            }
            setResult(RESULT_OK, this)
        }
        finish()
    }

    /**
     * 连续扫码模式下，将批量结果通过 Intent 返回
     */
    private fun finishWithBatchResults() {
        val resultsArray = org.json.JSONArray()
        scanResults.forEach { item ->
            resultsArray.put(org.json.JSONObject().apply {
                put("result", item.text)
                put("scanType", item.scanType)
                put("charSet", "utf-8")
            })
        }
        Intent().apply {
            putExtra("result", resultsArray.toString())
            putExtra("scanType", "BATCH")
            putExtra("charSet", "utf-8")
            putExtra("errMsg", "scanCode:ok")
            putExtra("batch", true)
            setResult(RESULT_OK, this)
        }
        finish()
    }

    private fun finishWithCancel() {
        Intent().apply {
            putExtra("errMsg", "scanCode:fail cancel")
            setResult(RESULT_CANCELED, this)
        }
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        cameraExecutor.shutdown()
        mlKitScanner?.close()
    }

    // ===== Barcode Format 转 scanType 字符串 =====

    private fun Barcode.formatToScanType(): String = when (format) {
        Barcode.FORMAT_QR_CODE -> "QR_CODE"
        Barcode.FORMAT_CODE_128 -> "CODE_128"
        Barcode.FORMAT_CODE_39 -> "CODE_39"
        Barcode.FORMAT_CODE_93 -> "CODE_93"
        Barcode.FORMAT_CODABAR -> "CODABAR"
        Barcode.FORMAT_DATA_MATRIX -> "DATA_MATRIX"
        Barcode.FORMAT_EAN_13 -> "EAN_13"
        Barcode.FORMAT_EAN_8 -> "EAN_8"
        Barcode.FORMAT_ITF -> "ITF"
        Barcode.FORMAT_PDF417 -> "PDF417"
        Barcode.FORMAT_UPC_A -> "UPC_A"
        Barcode.FORMAT_UPC_E -> "UPC_E"
        Barcode.FORMAT_AZTEC -> "AZTEC"
        else -> "UNKNOWN"
    }

    private fun com.google.zxing.BarcodeFormat.toScanType(): String = when (this) {
        com.google.zxing.BarcodeFormat.QR_CODE -> "QR_CODE"
        com.google.zxing.BarcodeFormat.CODE_128 -> "CODE_128"
        com.google.zxing.BarcodeFormat.CODE_39 -> "CODE_39"
        com.google.zxing.BarcodeFormat.CODE_93 -> "CODE_93"
        com.google.zxing.BarcodeFormat.CODABAR -> "CODABAR"
        com.google.zxing.BarcodeFormat.DATA_MATRIX -> "DATA_MATRIX"
        com.google.zxing.BarcodeFormat.EAN_13 -> "EAN_13"
        com.google.zxing.BarcodeFormat.EAN_8 -> "EAN_8"
        com.google.zxing.BarcodeFormat.ITF -> "ITF"
        com.google.zxing.BarcodeFormat.PDF_417 -> "PDF417"
        com.google.zxing.BarcodeFormat.UPC_A -> "UPC_A"
        com.google.zxing.BarcodeFormat.UPC_E -> "UPC_E"
        com.google.zxing.BarcodeFormat.AZTEC -> "AZTEC"
        else -> "UNKNOWN"
    }

    /**
     * ImageProxy 转 Bitmap（供 ZXing 使用）
     */
    private fun ImageProxy.toBitmap(): Bitmap? {
        val buffer = planes[0].buffer ?: return null
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        val yuvImage = YuvImage(bytes, ImageFormat.NV21, width, height, null)
        val out = ByteArrayOutputStream()
        yuvImage.compressToJpeg(Rect(0, 0, width, height), 100, out)
        val jpegData = out.toByteArray()
        return BitmapFactory.decodeByteArray(jpegData, 0, jpegData.size)
    }
}

// ========================
// Compose UI
// ========================

/**
 * 扫码界面 — 上半部分相机预览（≤50%屏占比）+ 扫描框 + 下半部分结果/按钮
 *
 * 扫描框支持三种形状：
 * - square（方形）：默认，带圆角遮罩和四角装饰
 * - circle（圆形）：圆形扫描区域
 * - svg（自定义）：前端传入 SVG 字符串渲染任意形状
 */
@Composable
private fun ScanCodeScreen(
    config: ScanCodeConfig,
    canOpenAlbum: Boolean,
    continuous: Boolean = false,
    scanResults: List<ScanResultItem> = emptyList(),
    singleResult: ScanResultItem? = null,
    onConfirmClick: (ScanResultItem) -> Unit = {},
    onRescanClick: () -> Unit = {},
    onFinishClick: () -> Unit = {},
    onAlbumClick: () -> Unit,
    onBackPress: () -> Unit,
    onPreviewViewCreated: (PreviewView) -> Unit = {},
) {
    Column(modifier = Modifier.fillMaxSize().background(Color(0xFF1A1A2E))) {
        // ===== 上半部分：相机预览 + 扫描框（≤50% 屏占比） =====
        Box(modifier = Modifier.weight(1f)) {
            // 相机预览
            AndroidView(
                factory = { ctx ->
                    PreviewView(ctx).also { pv ->
                        onPreviewViewCreated(pv)
                    }
                },
                modifier = Modifier.fillMaxSize()
            )

            // 扫描框覆盖层
            Canvas(modifier = Modifier.fillMaxSize()) {
                val w = size.width
                val h = size.height
                val shape = config.frameShape

                if (shape == "svg" && config.frameSvg != null) {
                    // SVG 自定义形状
                    renderSvgFrame(config.frameSvg!!, w, h)
                } else if (shape == "circle") {
                    // 圆形扫描框
                    val cx = w / 2f
                    val cy = h / 2f
                    val r = minOf(w, h) * 0.3f
                    // 四边遮罩
                    drawRect(config.maskColor, Offset(0f, 0f), Size(w, cy - r))
                    drawRect(config.maskColor, Offset(0f, cy + r), Size(w, h - cy - r))
                    drawRect(config.maskColor, Offset(0f, cy - r), Size(cx - r, r * 2f))
                    drawRect(config.maskColor, Offset(cx + r, cy - r), Size(w - cx - r, r * 2f))
                    // 圆形边框
                    drawCircle(config.frameColor, r, Offset(cx, cy), style = Stroke(width = 3f))
                    // 四角小标记（在圆的上下左右）
                    val mk = 16f
                    drawLine(config.cornerColor, Offset(cx, cy - r), Offset(cx, cy - r + mk), strokeWidth = 4f)
                    drawLine(config.cornerColor, Offset(cx, cy + r - mk), Offset(cx, cy + r), strokeWidth = 4f)
                    drawLine(config.cornerColor, Offset(cx - r, cy), Offset(cx - r + mk, cy), strokeWidth = 4f)
                    drawLine(config.cornerColor, Offset(cx + r - mk, cy), Offset(cx + r, cy), strokeWidth = 4f)
                } else {
                    // 方形扫描框（默认）
                    val frameW = w * config.frameWidthRatio.coerceIn(0.2f, 0.95f)
                    val frameH = frameW * config.frameAspectRatio.coerceIn(0.3f, 1.5f)
                    val left = (w - frameW) / 2f
                    val top = (h - frameH) / 2f * config.frameVerticalOffset.coerceIn(0.3f, 1.7f)
                    val right = left + frameW
                    val bottom = top + frameH

                    drawRect(config.maskColor, Offset(0f, 0f), Size(w, top))
                    drawRect(config.maskColor, Offset(0f, bottom), Size(w, h - bottom))
                    drawRect(config.maskColor, Offset(0f, top), Size(left, frameH))
                    drawRect(config.maskColor, Offset(right, top), Size(w - right, frameH))

                    drawRoundRect(
                        color = config.frameColor,
                        topLeft = Offset(left, top),
                        size = Size(frameW, frameH),
                        cornerRadius = CornerRadius(8f),
                        style = Stroke(width = 3f)
                    )

                    val cl = 40f
                    drawLine(config.cornerColor, Offset(left, top), Offset(left + cl, top), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(left, top), Offset(left, top + cl), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(right, top), Offset(right - cl, top), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(right, top), Offset(right, top + cl), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(left, bottom), Offset(left + cl, bottom), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(left, bottom), Offset(left, bottom - cl), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(right, bottom), Offset(right - cl, bottom), strokeWidth = 6f)
                    drawLine(config.cornerColor, Offset(right, bottom), Offset(right, bottom - cl), strokeWidth = 6f)
                }
            }

            // 返回 + 标题
            Text(
                text = config.backText,
                color = config.backTextColor,
                fontSize = 16.sp,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = 16.dp, top = 12.dp)
                    .clickable { onBackPress() }
            )
            Text(
                text = config.title,
                color = config.titleColor,
                fontSize = 18.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 12.dp)
            )
        }

        // ===== 下半部分：结果展示 + 操作按钮（≈50% 屏占比） =====
        if (continuous) {
            // 连续模式：实时结果列表
            ContinuousPanel(
                config = config,
                scanResults = scanResults,
                canOpenAlbum = canOpenAlbum,
                onAlbumClick = onAlbumClick,
                onFinishClick = onFinishClick,
                modifier = Modifier.weight(1f),
            )
        } else {
            // 非连续模式：扫码结果 / 等待扫码
            val result = singleResult
            if (result != null) {
                // 有扫码结果 → 展示 + 确认/重扫
                ResultPanel(
                    result = result,
                    config = config,
                    canOpenAlbum = canOpenAlbum,
                    onConfirmClick = { onConfirmClick(result) },
                    onRescanClick = onRescanClick,
                    onAlbumClick = onAlbumClick,
                )
            } else {
                // 等待扫码 → 提示 + 相册
                WaitingPanel(
                    config = config,
                    canOpenAlbum = canOpenAlbum,
                    onAlbumClick = onAlbumClick,
                )
            }
        }
    }
}

// ========================
// 下半部分面板组件
// ========================

@Composable
private fun ContinuousPanel(
    config: ScanCodeConfig,
    scanResults: List<ScanResultItem>,
    canOpenAlbum: Boolean,
    onAlbumClick: () -> Unit,
    onFinishClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A2E))
            .padding(horizontal = 14.dp, vertical = 10.dp)
    ) {
        val count = scanResults.size
        // 状态提示
        Text(
            text = if (count > 0)
                config.continuousHint.replace("%d", count.toString())
            else config.hint,
            color = config.hintColor,
            fontSize = 13.sp,
        )
        // 结果列表
        if (count > 0) {
            Spacer(modifier = Modifier.height(6.dp))
            LazyColumn(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(scanResults.reversed()) { item ->
                    ScanResultRow(item, config.cornerColor)
                }
            }
        } else {
            // 无结果时占位，让按钮到底部
            Spacer(modifier = Modifier.weight(1f))
        }
        // 操作行
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (canOpenAlbum) {
                Text(
                    text = config.albumText,
                    color = config.albumTextColor,
                    fontSize = 14.sp,
                    modifier = Modifier
                        .clickable { onAlbumClick() }
                        .padding(end = 12.dp)
                )
            }
            Spacer(modifier = Modifier.weight(1f))
            Button(
                onClick = onFinishClick,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF00C853)),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.height(38.dp),
            ) {
                Text(
                    text = config.finishText.replace("%d", count.toString()),
                    fontSize = 14.sp,
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun ResultPanel(
    result: ScanResultItem,
    config: ScanCodeConfig,
    canOpenAlbum: Boolean,
    onConfirmClick: () -> Unit,
    onRescanClick: () -> Unit,
    onAlbumClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A2E))
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        // 结果卡片
        Text("✅ 扫码成功", color = config.cornerColor, fontSize = 16.sp, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Row {
            Text("类型：", color = Color.White.copy(alpha = 0.6f), fontSize = 13.sp)
            Text(result.scanType, color = config.cornerColor, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        }
        Spacer(modifier = Modifier.height(4.dp))
        Text("内容：", color = Color.White.copy(alpha = 0.6f), fontSize = 13.sp)
        Text(
            text = result.text,
            color = Color.White,
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            maxLines = 4,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .background(Color(0x1AFFFFFF), RoundedCornerShape(6.dp))
                .padding(10.dp)
        )
        Spacer(modifier = Modifier.height(10.dp))
        // 按钮行
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Button(
                onClick = onRescanClick,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF333333)),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.weight(1f).height(42.dp),
            ) { Text("重新扫码", fontSize = 15.sp, color = Color.White) }
            Button(
                onClick = onConfirmClick,
                colors = ButtonDefaults.buttonColors(containerColor = config.cornerColor),
                shape = RoundedCornerShape(20.dp),
                modifier = Modifier.weight(1f).height(42.dp),
            ) { Text("确认结果", fontSize = 15.sp, color = Color.White) }
        }
        if (canOpenAlbum) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = config.albumText,
                color = config.albumTextColor,
                fontSize = 14.sp,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .clickable { onAlbumClick() }
            )
        }
    }
}

@Composable
private fun WaitingPanel(
    config: ScanCodeConfig,
    canOpenAlbum: Boolean,
    onAlbumClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF1A1A2E))
            .padding(vertical = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(text = config.hint, color = config.hintColor, fontSize = 14.sp)
        if (canOpenAlbum) {
            Spacer(modifier = Modifier.height(14.dp))
            Text(
                text = config.albumText,
                color = config.albumTextColor,
                fontSize = 16.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.clickable { onAlbumClick() }
            )
        }
    }
}

@Composable
private fun ScanResultRow(item: ScanResultItem, accentColor: Color) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0x26FFFFFF), RoundedCornerShape(6.dp))
            .padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .background(accentColor, RoundedCornerShape(4.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp)
        ) {
            Text(
                text = item.scanType.takeWhile { it != '_' }.ifEmpty { "?" },
                color = Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(modifier = Modifier.width(8.dp))
        Text(
            text = item.text,
            color = Color.White,
            fontSize = 13.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/**
 * 在 Canvas 上渲染 SVG 扫描框
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.renderSvgFrame(svgStr: String, w: Float, h: Float) {
    try {
        val svg = SVG.getFromString(svgStr)
        svg.documentWidth = w
        svg.documentHeight = h
        val bmp = Bitmap.createBitmap(w.toInt(), h.toInt(), Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        svg.renderToCanvas(c)
        drawImage(bmp.asImageBitmap(), Offset.Zero)
    } catch (_: Exception) { }
}

/**
 * 单次扫码结果
 */
data class ScanResultItem(val text: String, val scanType: String, val timestamp: Long = System.currentTimeMillis())

/**
 * 扫码界面 UI 配置
 *
 * 可通过 wx.scanCode 的参数自定义，例如：
 * ```js
 * wx.scanCode({
 *   title: '仓储扫码',
 *   hint: '请对准条码',
 *   cornerColor: '#FF5722',
 *   albumText: '从相册选取条码图片',
 * })
 * ```
 *
 * @property title 顶部标题文字（默认 "扫码"）
 * @property titleColor 标题颜色
 * @property hint 底部提示文字（默认 "将条码/二维码放入框内自动扫描"）
 * @property hintColor 提示文字颜色
 * @property frameColor 扫描框边框颜色
 * @property cornerColor 四角色彩
 * @property maskColor 遮罩颜色
 * @property frameShape 扫描框形状：square（方形）/ circle（圆形）/ svg（自定义SVG）
 * @property frameSvg 自定义 SVG 扫描框（frameShape=svg 时生效）
 * @property albumText 相册选图按钮文字（默认 "从相册选择"）
 * @property albumTextColor 相册按钮文字颜色
 * @property backText 返回按钮文字（默认 "← 返回"）
 * @property backTextColor 返回按钮文字颜色
 */
data class ScanCodeConfig(
    val title: String,
    val titleColor: Color,
    val hint: String,
    val hintColor: Color,
    val frameColor: Color,
    val cornerColor: Color,
    val maskColor: Color,
    val frameShape: String = "square",
    val frameSvg: String? = null,
    val albumText: String,
    val albumTextColor: Color,
    val backText: String,
    val backTextColor: Color,
    val continuous: Boolean = false,
    val continuousHint: String = "已识别 %d 个，继续扫码中…",
    val finishText: String = "完成 (%d)",
    /** 扫描框宽度占屏幕宽度的比例 0.0~1.0，默认 0.75 */
    val frameWidthRatio: Float = 0.75f,
    /** 扫描框高宽比，默认 0.7（即高度为宽度的 70%） */
    val frameAspectRatio: Float = 0.7f,
    /** 扫描框垂直位置偏移系数，1.0=正中间，<1.0=偏上，>1.0=偏下，默认 0.8 */
    val frameVerticalOffset: Float = 0.8f,
) {
    companion object {
        /** 默认配置 */
        val DEFAULT = ScanCodeConfig(
            title = "扫码",
            titleColor = Color.White,
            hint = "将条码/二维码放入框内自动扫描",
            hintColor = Color.White.copy(alpha = 0.8f),
            frameColor = Color.White,
            cornerColor = Color(0xFF00C853),
            maskColor = Color(0xFF000000),
            frameSvg = null,
            albumText = "从相册选择",
            albumTextColor = Color(0xFF00C853),
            backText = "← 返回",
            backTextColor = Color.White,
        )

        /** 从 Intent 解析，使用默认值兜底 */
        fun fromIntent(intent: Intent): ScanCodeConfig {
            return ScanCodeConfig(
                title = intent.getStringExtra("cfg_title") ?: DEFAULT.title,
                titleColor = parseColor(intent.getStringExtra("cfg_titleColor"), DEFAULT.titleColor),
                hint = intent.getStringExtra("cfg_hint") ?: DEFAULT.hint,
                hintColor = parseColor(intent.getStringExtra("cfg_hintColor"), DEFAULT.hintColor),
                frameColor = parseColor(intent.getStringExtra("cfg_frameColor"), DEFAULT.frameColor),
                cornerColor = parseColor(intent.getStringExtra("cfg_cornerColor"), DEFAULT.cornerColor),
                maskColor = DEFAULT.maskColor,
                frameShape = intent.getStringExtra("cfg_frameShape") ?: DEFAULT.frameShape,
                frameSvg = intent.getStringExtra("cfg_frameSvg"),
                albumText = intent.getStringExtra("cfg_albumText") ?: DEFAULT.albumText,
                albumTextColor = parseColor(intent.getStringExtra("cfg_albumTextColor"), DEFAULT.albumTextColor),
                backText = intent.getStringExtra("cfg_backText") ?: DEFAULT.backText,
                backTextColor = parseColor(intent.getStringExtra("cfg_backTextColor"), DEFAULT.backTextColor),
                frameWidthRatio = intent.getFloatExtra("cfg_frameWidthRatio", DEFAULT.frameWidthRatio),
                frameAspectRatio = intent.getFloatExtra("cfg_frameAspectRatio", DEFAULT.frameAspectRatio),
                frameVerticalOffset = intent.getFloatExtra("cfg_frameVerticalOffset", DEFAULT.frameVerticalOffset),
            )
        }

        /** 将 UI 配置写入 Intent */
        fun putToIntent(intent: Intent, config: ScanCodeConfig) {
            intent.putExtra("cfg_title", config.title)
            intent.putExtra("cfg_titleColor", config.titleColor.toHexString())
            intent.putExtra("cfg_hint", config.hint)
            intent.putExtra("cfg_hintColor", config.hintColor.toHexString())
            intent.putExtra("cfg_frameColor", config.frameColor.toHexString())
            intent.putExtra("cfg_cornerColor", config.cornerColor.toHexString())
            intent.putExtra("cfg_albumText", config.albumText)
            intent.putExtra("cfg_albumTextColor", config.albumTextColor.toHexString())
            intent.putExtra("cfg_frameShape", config.frameShape)
            if (config.frameSvg != null) intent.putExtra("cfg_frameSvg", config.frameSvg)
            intent.putExtra("cfg_backText", config.backText)
            intent.putExtra("cfg_backTextColor", config.backTextColor.toHexString())
            intent.putExtra("continuous", config.continuous)
            if (config.continuousHint.isNotEmpty()) intent.putExtra("cfg_continuousHint", config.continuousHint)
            if (config.finishText.isNotEmpty()) intent.putExtra("cfg_finishText", config.finishText)
            intent.putExtra("cfg_frameWidthRatio", config.frameWidthRatio)
            intent.putExtra("cfg_frameAspectRatio", config.frameAspectRatio)
            intent.putExtra("cfg_frameVerticalOffset", config.frameVerticalOffset)
        }

        /**
         * 从 JSONObject 解析 UI 配置
         * 与 wx.scanCode 的参数映射 —— 在 ScanApi 中调用
         */
        fun fromJson(params: JSONObject?): ScanCodeConfig {
            if (params == null) return DEFAULT
            val continuous = params.optBoolean("continuous", false)
            return ScanCodeConfig(
                title = params.optString("title", DEFAULT.title),
                titleColor = parseColor(params.optString("titleColor"), DEFAULT.titleColor),
                hint = if (continuous) params.optString("hint",
                    "连续扫码中，识别后自动继续") else params.optString("hint", DEFAULT.hint),
                hintColor = parseColor(params.optString("hintColor"), DEFAULT.hintColor).copy(alpha = 0.8f),
                frameColor = parseColor(params.optString("frameColor"), DEFAULT.frameColor),
                cornerColor = parseColor(params.optString("cornerColor"), DEFAULT.cornerColor),
                maskColor = DEFAULT.maskColor,
                frameShape = params.optString("frameShape", DEFAULT.frameShape),
                frameSvg = params.optString("frameSvg", "").ifEmpty { null },
                albumText = params.optString("albumText", DEFAULT.albumText),
                albumTextColor = parseColor(params.optString("albumTextColor"), DEFAULT.albumTextColor),
                backText = params.optString("backText", DEFAULT.backText),
                backTextColor = parseColor(params.optString("backTextColor"), DEFAULT.backTextColor),
                continuous = continuous,
                continuousHint = params.optString("continuousHint", "已识别 %d 个，继续扫码中…"),
                finishText = params.optString("finishText", "完成 (%d)"),
                frameWidthRatio = params.optDouble("frameWidthRatio", DEFAULT.frameWidthRatio.toDouble()).toFloat(),
                frameAspectRatio = params.optDouble("frameAspectRatio", DEFAULT.frameAspectRatio.toDouble()).toFloat(),
                frameVerticalOffset = params.optDouble("frameVerticalOffset", DEFAULT.frameVerticalOffset.toDouble()).toFloat(),
            )
        }

        /** 解析 #RRGGBB / #AARRGGBB 颜色字符串 */
        private fun parseColor(hex: String?, fallback: Color): Color {
            if (hex == null) return fallback
            return try {
                val clean = hex.removePrefix("#")
                val argb = when (clean.length) {
                    6 -> (0xFF000000 or clean.toLong(16))
                    8 -> clean.toLong(16)
                    else -> return fallback
                }
                Color(argb.toInt())
            } catch (_: Exception) { fallback }
        }
    }
}

/** Compose Color 转 #AARRGGBB 字符串 */
private fun Color.toHexString(): String {
    val r = (red * 255).toInt()
    val g = (green * 255).toInt()
    val b = (blue * 255).toInt()
    val a = (alpha * 255).toInt()
    return String.format("#%02X%02X%02X%02X", a, r, g, b)
}
