package com.didi.dimina.ui.view

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.view.View
import kotlin.math.roundToInt

/**
 * Native canvas view that renders 2D drawing commands using android.graphics.Canvas.
 * Android Canvas coordinate system matches HTML5 Canvas 2D (origin top-left).
 */
class NativeCanvasView(context: Context) : View(context) {

    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = Color.BLACK
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = Color.BLACK
        strokeWidth = 1f
    }
    private val currentPath = Path()
    private val drawCommands = mutableListOf<(Canvas) -> Unit>()
    private val stateStack = mutableListOf<CanvasDrawState>()

    // Current state
    private var globalAlpha = 1f
    private var fontSize = 10f
    private var fontFamily = "sans-serif"
    private var fontWeight = "normal"
    private var fontStyle = "normal"
    private var textAlign = "start"
    private var textBaseline = "alphabetic"
    private var shadowBlur = 0f
    private var shadowColor = Color.TRANSPARENT
    private var shadowOffsetX = 0f
    private var shadowOffsetY = 0f
    private var lineDashPattern: FloatArray? = null
    private var lineDashOffset = 0f
    private var currentPathX = 0f
    private var currentPathY = 0f

    init {
        setBackgroundColor(Color.TRANSPARENT)
        setWillNotDraw(false)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        for (cmd in drawCommands) {
            cmd(canvas)
        }
    }

    fun appendCommand(cmd: (Canvas) -> Unit) {
        drawCommands.add(cmd)
    }

    fun flush() {
        invalidate()
    }

    fun setProperty(prop: String, value: Any?) {
        when (prop) {
            "fillStyle" -> {
                val color = parseCanvasColor(value)
                fillPaint.color = color
            }
            "strokeStyle" -> {
                val color = parseCanvasColor(value)
                strokePaint.color = color
            }
            "lineWidth" -> {
                strokePaint.strokeWidth = asFloat(value)
            }
            "lineCap" -> {
                strokePaint.strokeCap = when (value as? String) {
                    "round" -> Paint.Cap.ROUND
                    "square" -> Paint.Cap.SQUARE
                    else -> Paint.Cap.BUTT
                }
            }
            "lineJoin" -> {
                strokePaint.strokeJoin = when (value as? String) {
                    "round" -> Paint.Join.ROUND
                    "bevel" -> Paint.Join.BEVEL
                    else -> Paint.Join.MITER
                }
            }
            "miterLimit" -> {
                strokePaint.strokeMiter = asFloat(value)
            }
            "font" -> {
                parseFont(value as? String ?: "10px sans-serif")
            }
            "textAlign" -> {
                textAlign = value as? String ?: "start"
            }
            "textBaseline" -> {
                textBaseline = value as? String ?: "alphabetic"
            }
            "globalAlpha" -> {
                globalAlpha = asFloat(value).coerceIn(0f, 1f)
            }
            "shadowBlur" -> {
                shadowBlur = asFloat(value)
            }
            "shadowColor" -> {
                shadowColor = parseCanvasColor(value)
            }
            "shadowOffsetX" -> {
                shadowOffsetX = asFloat(value)
            }
            "shadowOffsetY" -> {
                shadowOffsetY = asFloat(value)
            }
            "lineDashOffset" -> {
                lineDashOffset = asFloat(value)
            }
        }
    }

    fun callMethod(method: String, args: List<Any?>): Any? {
        when (method) {
            // Path
            "beginPath" -> {
                currentPath.reset()
                return null
            }
            "moveTo" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                currentPath.moveTo(x, y)
                currentPathX = x; currentPathY = y
                return null
            }
            "lineTo" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                currentPath.lineTo(x, y)
                currentPathX = x; currentPathY = y
                return null
            }
            "closePath" -> {
                currentPath.close()
                return null
            }
            "arc" -> {
                val cx = asFloat(args[0]); val cy = asFloat(args[1])
                val r = asFloat(args[2])
                val startAngle = asFloat(args[3])
                val endAngle = asFloat(args[4])
                val ccw = if (args.size > 5) args[5] as? Boolean ?: false else false
                addArc(cx, cy, r, startAngle, endAngle, ccw)
                return null
            }
            "arcTo" -> {
                val x1 = asFloat(args[0]); val y1 = asFloat(args[1])
                val x2 = asFloat(args[2]); val y2 = asFloat(args[3])
                val radius = asFloat(args[4])
                currentPath.arcTo(
                    RectF(x1 - radius, y1 - radius, x1 + radius, y1 + radius),
                    0f, 90f, false
                )
                return null
            }
            "quadraticCurveTo" -> {
                currentPath.quadTo(asFloat(args[0]), asFloat(args[1]),
                    asFloat(args[2]), asFloat(args[3]))
                return null
            }
            "bezierCurveTo" -> {
                currentPath.cubicTo(
                    asFloat(args[0]), asFloat(args[1]),
                    asFloat(args[2]), asFloat(args[3]),
                    asFloat(args[4]), asFloat(args[5])
                )
                return null
            }
            "rect" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                val w = asFloat(args[2]); val h = asFloat(args[3])
                currentPath.addRect(x, y, x + w, y + h, Path.Direction.CW)
                return null
            }
            "ellipse" -> {
                val cx = asFloat(args[0]); val cy = asFloat(args[1])
                val rx = asFloat(args[2]); val ry = asFloat(args[3])
                val rotation = asFloat(args[4])
                val startAngle = asFloat(args[5]); val endAngle = asFloat(args[6])
                val ccw = if (args.size > 7) args[7] as? Boolean ?: false else false
                addEllipse(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw)
                return null
            }

            // Drawing
            "fill" -> {
                val paintSnapshot = snapshotFillPaint()
                val pathCopy = Path(currentPath)
                appendCommand { canvas ->
                    canvas.drawPath(pathCopy, paintSnapshot)
                }
                return null
            }
            "stroke" -> {
                val paintSnapshot = snapshotStrokePaint()
                val pathCopy = Path(currentPath)
                appendCommand { canvas ->
                    canvas.drawPath(pathCopy, paintSnapshot)
                }
                return null
            }
            "clip" -> {
                val pathCopy = Path(currentPath)
                appendCommand { canvas ->
                    canvas.clipPath(pathCopy)
                }
                return null
            }
            "fillRect" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                val w = asFloat(args[2]); val h = asFloat(args[3])
                val paintSnapshot = snapshotFillPaint()
                appendCommand { canvas ->
                    canvas.drawRect(x, y, x + w, y + h, paintSnapshot)
                }
                return null
            }
            "strokeRect" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                val w = asFloat(args[2]); val h = asFloat(args[3])
                val paintSnapshot = snapshotStrokePaint()
                appendCommand { canvas ->
                    canvas.drawRect(x, y, x + w, y + h, paintSnapshot)
                }
                return null
            }
            "clearRect" -> {
                val x = asFloat(args[0]); val y = asFloat(args[1])
                val w = asFloat(args[2]); val h = asFloat(args[3])
                appendCommand { canvas ->
                    val clearPaint = Paint().apply {
                        xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.CLEAR)
                    }
                    canvas.drawRect(x, y, x + w, y + h, clearPaint)
                }
                return null
            }

            // Text
            "fillText" -> {
                val text = args[0] as? String ?: ""
                val x = asFloat(args[1]); val y = asFloat(args[2])
                val paintSnapshot = snapshotTextPaint(fill = true)
                val align = textAlign
                val baseline = textBaseline
                appendCommand { canvas ->
                    val drawX = adjustTextX(x, text, paintSnapshot, align)
                    val drawY = adjustTextY(y, paintSnapshot, baseline)
                    canvas.drawText(text, drawX, drawY, paintSnapshot)
                }
                return null
            }
            "strokeText" -> {
                val text = args[0] as? String ?: ""
                val x = asFloat(args[1]); val y = asFloat(args[2])
                val paintSnapshot = snapshotTextPaint(fill = false)
                val align = textAlign
                val baseline = textBaseline
                appendCommand { canvas ->
                    val drawX = adjustTextX(x, text, paintSnapshot, align)
                    val drawY = adjustTextY(y, paintSnapshot, baseline)
                    canvas.drawText(text, drawX, drawY, paintSnapshot)
                }
                return null
            }

            // Transform
            "translate" -> {
                val tx = asFloat(args[0]); val ty = asFloat(args[1])
                appendCommand { canvas -> canvas.translate(tx, ty) }
                return null
            }
            "rotate" -> {
                val angle = asFloat(args[0])
                val degrees = Math.toDegrees(angle.toDouble()).toFloat()
                appendCommand { canvas -> canvas.rotate(degrees) }
                return null
            }
            "scale" -> {
                val sx = asFloat(args[0]); val sy = asFloat(args[1])
                appendCommand { canvas -> canvas.scale(sx, sy) }
                return null
            }
            "transform" -> {
                val a = asFloat(args[0]); val b = asFloat(args[1])
                val c = asFloat(args[2]); val d = asFloat(args[3])
                val e = asFloat(args[4]); val f = asFloat(args[5])
                val matrix = android.graphics.Matrix().apply {
                    setValues(floatArrayOf(a, c, e, b, d, f, 0f, 0f, 1f))
                }
                appendCommand { canvas -> canvas.concat(matrix) }
                return null
            }
            "setTransform" -> {
                val a = asFloat(args[0]); val b = asFloat(args[1])
                val c = asFloat(args[2]); val d = asFloat(args[3])
                val e = asFloat(args[4]); val f = asFloat(args[5])
                val matrix = android.graphics.Matrix().apply {
                    setValues(floatArrayOf(a, c, e, b, d, f, 0f, 0f, 1f))
                }
                appendCommand { canvas ->
                    canvas.setMatrix(matrix)
                }
                return null
            }
            "resetTransform" -> {
                appendCommand { canvas ->
                    canvas.setMatrix(android.graphics.Matrix())
                }
                return null
            }

            // State
            "save" -> {
                stateStack.add(captureState())
                appendCommand { canvas -> canvas.save() }
                return null
            }
            "restore" -> {
                if (stateStack.isNotEmpty()) {
                    restoreState(stateStack.removeAt(stateStack.size - 1))
                }
                appendCommand { canvas -> canvas.restore() }
                return null
            }

            // Gradients
            "createLinearGradient" -> {
                return CanvasGradient(
                    type = CanvasGradient.Type.LINEAR,
                    x0 = asFloat(args[0]), y0 = asFloat(args[1]),
                    x1 = asFloat(args[2]), y1 = asFloat(args[3])
                )
            }
            "createRadialGradient" -> {
                return CanvasGradient(
                    type = CanvasGradient.Type.RADIAL,
                    x0 = asFloat(args[0]), y0 = asFloat(args[1]),
                    r0 = asFloat(args[2]),
                    x1 = asFloat(args[3]), y1 = asFloat(args[4]),
                    r1 = asFloat(args[5])
                )
            }

            // Line dash
            "setLineDash" -> {
                val arr = args[0]
                if (arr is List<*> && arr.isNotEmpty()) {
                    lineDashPattern = FloatArray(arr.size) { asFloat(arr[it]) }
                } else {
                    lineDashPattern = null
                }
                return null
            }
            "getLineDash" -> {
                return lineDashPattern?.toList() ?: emptyList<Float>()
            }
        }

        return null
    }

    fun clearAll() {
        drawCommands.clear()
        currentPath.reset()
        stateStack.clear()
        fillPaint.color = Color.BLACK
        strokePaint.color = Color.BLACK
        strokePaint.strokeWidth = 1f
        globalAlpha = 1f
        invalidate()
    }

    // MARK: - Private Helpers

    private fun addArc(cx: Float, cy: Float, r: Float, startAngle: Float, endAngle: Float, ccw: Boolean) {
        val startDeg = Math.toDegrees(startAngle.toDouble()).toFloat()
        var sweepDeg = Math.toDegrees((endAngle - startAngle).toDouble()).toFloat()
        if (ccw) {
            if (sweepDeg > 0) sweepDeg -= 360f
        } else {
            if (sweepDeg < 0) sweepDeg += 360f
        }
        val oval = RectF(cx - r, cy - r, cx + r, cy + r)
        currentPath.arcTo(oval, startDeg, sweepDeg, false)
    }

    private fun addEllipse(cx: Float, cy: Float, rx: Float, ry: Float,
                           rotation: Float, startAngle: Float, endAngle: Float, ccw: Boolean) {
        val startDeg = Math.toDegrees(startAngle.toDouble()).toFloat()
        var sweepDeg = Math.toDegrees((endAngle - startAngle).toDouble()).toFloat()
        if (ccw) {
            if (sweepDeg > 0) sweepDeg -= 360f
        } else {
            if (sweepDeg < 0) sweepDeg += 360f
        }
        val oval = RectF(-rx, -ry, rx, ry)
        val ellipsePath = Path()
        ellipsePath.addArc(oval, startDeg, sweepDeg)
        val matrix = android.graphics.Matrix()
        matrix.postRotate(Math.toDegrees(rotation.toDouble()).toFloat())
        matrix.postTranslate(cx, cy)
        ellipsePath.transform(matrix)
        currentPath.addPath(ellipsePath)
    }

    private fun parseFont(fontString: String) {
        val parts = fontString.trim().split(Regex("\\s+"))
        var idx = 0

        if (idx < parts.size && (parts[idx] == "italic" || parts[idx] == "oblique")) {
            fontStyle = parts[idx]
            idx++
        } else {
            fontStyle = "normal"
        }
        if (idx < parts.size && (parts[idx] == "bold" || parts[idx] == "bolder" ||
                    parts[idx] == "lighter" || parts[idx].toIntOrNull() != null)) {
            fontWeight = parts[idx]
            idx++
        } else {
            fontWeight = "normal"
        }
        if (idx < parts.size) {
            fontSize = parts[idx].replace("px", "").toFloatOrNull() ?: 10f
            idx++
        }
        if (idx < parts.size) {
            fontFamily = parts.drop(idx).joinToString(" ").trim('\"', '\'')
        }
    }

    private fun resolveTypeface(): Typeface {
        val isBold = fontWeight == "bold" || fontWeight == "bolder" ||
            (fontWeight.toIntOrNull() ?: 0) >= 600
        val isItalic = fontStyle == "italic" || fontStyle == "oblique"
        return when {
            isBold && isItalic -> Typeface.create(Typeface.DEFAULT, Typeface.BOLD_ITALIC)
            isBold -> Typeface.DEFAULT_BOLD
            isItalic -> Typeface.create(Typeface.DEFAULT, Typeface.ITALIC)
            else -> Typeface.DEFAULT
        }
    }

    private fun snapshotFillPaint(): Paint {
        return Paint(fillPaint).apply {
            alpha = (globalAlpha * 255).roundToInt().coerceIn(0, 255)
            if (shadowBlur > 0 || shadowOffsetX != 0f || shadowOffsetY != 0f) {
                setShadowLayer(shadowBlur, shadowOffsetX, shadowOffsetY, shadowColor)
            }
            lineDashPattern?.let {
                if (it.isNotEmpty()) pathEffect = DashPathEffect(it, lineDashOffset)
            }
        }
    }

    private fun snapshotStrokePaint(): Paint {
        return Paint(strokePaint).apply {
            alpha = (globalAlpha * 255).roundToInt().coerceIn(0, 255)
            if (shadowBlur > 0 || shadowOffsetX != 0f || shadowOffsetY != 0f) {
                setShadowLayer(shadowBlur, shadowOffsetX, shadowOffsetY, shadowColor)
            }
            lineDashPattern?.let {
                if (it.isNotEmpty()) pathEffect = DashPathEffect(it, lineDashOffset)
            }
        }
    }

    private fun snapshotTextPaint(fill: Boolean): Paint {
        val paint = if (fill) Paint(fillPaint) else Paint(strokePaint)
        return paint.apply {
            textSize = fontSize
            typeface = resolveTypeface()
            alpha = (globalAlpha * 255).roundToInt().coerceIn(0, 255)
            if (!fill) {
                style = Paint.Style.STROKE
            }
        }
    }

    private fun adjustTextX(x: Float, text: String, paint: Paint, align: String): Float {
        return when (align) {
            "center" -> x - paint.measureText(text) / 2
            "right", "end" -> x - paint.measureText(text)
            else -> x
        }
    }

    private fun adjustTextY(y: Float, paint: Paint, baseline: String): Float {
        val metrics = paint.fontMetrics
        return when (baseline) {
            "top" -> y - metrics.top
            "middle" -> y - (metrics.ascent + metrics.descent) / 2
            "bottom" -> y - metrics.bottom
            "hanging" -> y - metrics.top
            else -> y // alphabetic — default Android behavior
        }
    }

    private fun captureState(): CanvasDrawState {
        return CanvasDrawState(
            fillColor = fillPaint.color,
            strokeColor = strokePaint.color,
            lineWidth = strokePaint.strokeWidth,
            lineCap = strokePaint.strokeCap,
            lineJoin = strokePaint.strokeJoin,
            miterLimit = strokePaint.strokeMiter,
            globalAlpha = globalAlpha,
            fontSize = fontSize,
            fontFamily = fontFamily,
            fontWeight = fontWeight,
            fontStyle = fontStyle,
            textAlign = textAlign,
            textBaseline = textBaseline,
            shadowBlur = shadowBlur,
            shadowColor = shadowColor,
            shadowOffsetX = shadowOffsetX,
            shadowOffsetY = shadowOffsetY,
            lineDashPattern = lineDashPattern?.clone(),
            lineDashOffset = lineDashOffset,
        )
    }

    private fun restoreState(state: CanvasDrawState) {
        fillPaint.color = state.fillColor
        strokePaint.color = state.strokeColor
        strokePaint.strokeWidth = state.lineWidth
        strokePaint.strokeCap = state.lineCap
        strokePaint.strokeJoin = state.lineJoin
        strokePaint.strokeMiter = state.miterLimit
        globalAlpha = state.globalAlpha
        fontSize = state.fontSize
        fontFamily = state.fontFamily
        fontWeight = state.fontWeight
        fontStyle = state.fontStyle
        textAlign = state.textAlign
        textBaseline = state.textBaseline
        shadowBlur = state.shadowBlur
        shadowColor = state.shadowColor
        shadowOffsetX = state.shadowOffsetX
        shadowOffsetY = state.shadowOffsetY
        lineDashPattern = state.lineDashPattern
        lineDashOffset = state.lineDashOffset
    }
}

private data class CanvasDrawState(
    val fillColor: Int,
    val strokeColor: Int,
    val lineWidth: Float,
    val lineCap: Paint.Cap,
    val lineJoin: Paint.Join,
    val miterLimit: Float,
    val globalAlpha: Float,
    val fontSize: Float,
    val fontFamily: String,
    val fontWeight: String,
    val fontStyle: String,
    val textAlign: String,
    val textBaseline: String,
    val shadowBlur: Float,
    val shadowColor: Int,
    val shadowOffsetX: Float,
    val shadowOffsetY: Float,
    val lineDashPattern: FloatArray?,
    val lineDashOffset: Float,
)

/**
 * Canvas gradient object, mirrors CanvasGradient in HTML5 Canvas 2D.
 */
class CanvasGradient(
    val type: Type,
    val x0: Float = 0f, val y0: Float = 0f,
    val x1: Float = 0f, val y1: Float = 0f,
    val r0: Float = 0f, val r1: Float = 0f,
) {
    enum class Type { LINEAR, RADIAL }

    private val stops = mutableListOf<Pair<Float, Int>>()

    fun addColorStop(offset: Float, color: Int) {
        stops.add(offset to color)
        stops.sortBy { it.first }
    }

    fun toShader(): Shader? {
        if (stops.size < 2) return null
        val colors = stops.map { it.second }.toIntArray()
        val positions = stops.map { it.first }.toFloatArray()
        return when (type) {
            Type.LINEAR -> LinearGradient(x0, y0, x1, y1, colors, positions, Shader.TileMode.CLAMP)
            Type.RADIAL -> RadialGradient(x1, y1, r1.coerceAtLeast(0.001f), colors, positions, Shader.TileMode.CLAMP)
        }
    }
}

// MARK: - Utility

private fun asFloat(value: Any?): Float {
    return when (value) {
        is Number -> value.toFloat()
        is String -> value.toFloatOrNull() ?: 0f
        else -> 0f
    }
}

internal fun parseCanvasColor(value: Any?): Int {
    if (value == null) return Color.BLACK
    val str = (value as? String) ?: return Color.BLACK
    val color = str.trim().lowercase()
    if (color == "transparent") return Color.TRANSPARENT
    if (color.startsWith("rgba(") || color.startsWith("rgb(")) {
        return parseRgbCanvasColor(color)
    }
    return try {
        Color.parseColor(color)
    } catch (_: Exception) {
        Color.BLACK
    }
}

private fun parseRgbCanvasColor(color: String): Int {
    val values = color
        .substringAfter("(")
        .substringBefore(")")
        .split(",")
        .map { it.trim() }
    val r = values.getOrNull(0)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: 0
    val g = values.getOrNull(1)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: 0
    val b = values.getOrNull(2)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: 0
    val a = values.getOrNull(3)?.toFloatOrNull()?.let {
        if (it <= 1f) (it * 255).roundToInt() else it.roundToInt()
    }?.coerceIn(0, 255) ?: 255
    return Color.argb(a, r, g, b)
}
