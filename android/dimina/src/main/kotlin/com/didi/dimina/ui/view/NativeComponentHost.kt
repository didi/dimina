package com.didi.dimina.ui.view

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.VideoView
import coil.imageLoader
import coil.request.ImageRequest
import com.didi.dimina.common.LogUtils
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Hosts native components as siblings of WebView and keeps their bounds aligned
 * with DOM placeholders reported from the render layer.
 */
class NativeComponentHost(
    private val activity: DiminaActivity,
    private val webView: WebView,
    private val overlay: FrameLayout,
) {
    private val components = mutableMapOf<String, NativeComponent>()
    private val imageScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        webView.setOnScrollChangeListener { _, _, _, _, _ ->
            updateNativeComponentLayouts()
        }
    }

    fun handle(apiName: String, params: JSONObject): Boolean {
        val type = params.optString("type", VIDEO_TYPE)
        if (type !in SUPPORTED_TYPES) {
            LogUtils.d(TAG, "Ignore unsupported native component: $type")
            return false
        }

        val id = params.optString("id")
        if (id.isEmpty()) {
            LogUtils.e(TAG, "Native component id is empty: $params")
            return true
        }

        activity.runOnUiThread {
            when (apiName) {
                "componentMount" -> mountComponent(type, id, params)
                "propsUpdate" -> updateComponent(type, id, params)
                "componentUnmount" -> unmountComponent(id)
                "videoContext" -> (components[id] as? NativeVideoComponent)?.handleCommand(params)
            }
        }
        return true
    }

    fun clear() {
        activity.runOnUiThread {
            webView.setOnScrollChangeListener(null)
            components.values.forEach { it.release() }
            components.clear()
            imageScope.cancel()
            overlay.removeAllViews()
        }
    }

    private fun mountComponent(type: String, id: String, params: JSONObject) {
        val existing = components[id]
        if (existing != null && existing.type != type) {
            unmountComponent(id)
        }
        val component = components.getOrPut(id) {
            createComponent(type, id).also { overlay.addView(it.view) }
        }
        component.update(params)
    }

    private fun updateComponent(type: String, id: String, params: JSONObject) {
        components[id]?.update(params) ?: mountComponent(type, id, params)
    }

    private fun unmountComponent(id: String) {
        components.remove(id)?.let { component ->
            component.release()
            overlay.removeView(component.view)
        }
    }

    private fun createComponent(type: String, id: String): NativeComponent {
        return when (type) {
            COVER_VIEW_TYPE -> NativeCoverViewComponent(id)
            COVER_IMAGE_TYPE -> NativeCoverImageComponent(id)
            else -> NativeVideoComponent(id)
        }
    }

    private fun updateNativeComponentLayouts() {
        components.values.forEach { component ->
            component.applyLastLayout()
        }
    }

    private fun calculateLayout(params: JSONObject): NativeLayout? {
        val rect = params.optJSONObject("rect") ?: return null
        val viewportWidth = rect.optDouble("viewportWidth", 0.0)
        val viewportHeight = rect.optDouble("viewportHeight", 0.0)
        val scaleX = if (viewportWidth > 0.0 && webView.width > 0) {
            webView.width / viewportWidth
        } else {
            1.0
        }
        val scaleY = if (viewportHeight > 0.0 && webView.height > 0) {
            webView.height / viewportHeight
        } else {
            scaleX
        }
        val width = (rect.optDouble("width") * scaleX).roundToInt()
        val height = (rect.optDouble("height") * scaleY).roundToInt()
        val left = if (rect.has("pageLeft")) {
            (rect.optDouble("pageLeft") * scaleX - webView.scrollX).roundToInt()
        } else {
            (rect.optDouble("left") * scaleX).roundToInt()
        }
        val top = if (rect.has("pageTop")) {
            (rect.optDouble("pageTop") * scaleY - webView.scrollY).roundToInt()
        } else {
            (rect.optDouble("top") * scaleY).roundToInt()
        }
        val hidden = params.optBoolean("hidden", false) || width <= 0 || height <= 0

        return NativeLayout(
            left = left,
            top = top,
            width = width.coerceAtLeast(1),
            height = height.coerceAtLeast(1),
            visible = !hidden,
            zIndex = params.optJSONObject("style")?.optString("zIndex")?.toFloatOrNull() ?: 0f,
        )
    }

    private fun sendEvent(eventName: String, body: JSONObject) {
        val message = JSONObject().apply {
            put("type", eventName)
            put("body", body)
        }
        webView.post { webView.postMessage(message.toString()) }
    }

    private interface NativeComponent {
        val type: String
        val view: View
        fun update(params: JSONObject)
        fun applyLastLayout()
        fun release()
    }

    private abstract inner class BaseNativeComponent(
        protected val id: String,
        override val type: String,
    ) : NativeComponent {
        protected var lastLayoutParams: JSONObject? = null
        private var lastNativeLayout: NativeLayout? = null

        override fun update(params: JSONObject) {
            lastLayoutParams = params
            applyLayout(params)
            view.isClickable = params.optBoolean("tappable", view.isClickable)
            view.setOnClickListener(
                if (params.optBoolean("tappable", false)) {
                    View.OnClickListener {
                        sendEvent("bindtap", JSONObject().apply { put("id", id) })
                    }
                } else {
                    null
                }
            )
        }

        override fun applyLastLayout() {
            lastLayoutParams?.let { applyLayout(it) }
        }

        protected fun applyLayout(params: JSONObject) {
            val layout = calculateLayout(params) ?: return
            if (layout == lastNativeLayout) {
                return
            }
            lastNativeLayout = layout
            view.visibility = if (layout.visible) View.VISIBLE else View.GONE
            view.translationZ = layout.zIndex
            val currentParams = view.layoutParams as? FrameLayout.LayoutParams
            if (
                currentParams?.width == layout.width &&
                currentParams.height == layout.height &&
                currentParams.leftMargin == layout.left &&
                currentParams.topMargin == layout.top
            ) {
                return
            }
            view.layoutParams = FrameLayout.LayoutParams(layout.width, layout.height).apply {
                leftMargin = layout.left
                topMargin = layout.top
            }
        }

        protected fun applyCommonStyle(params: JSONObject) {
            val style = params.optJSONObject("style") ?: return
            view.alpha = style.optString("opacity", "1").toFloatOrNull()?.coerceIn(0f, 1f) ?: 1f
            val borderRadius = parseCssPx(style.optString("borderRadius")).toFloat()
            val background = GradientDrawable().apply {
                setColor(parseCssColor(style.optString("backgroundColor")) ?: Color.TRANSPARENT)
                cornerRadius = borderRadius
            }
            view.background = background
            view.clipToOutline = borderRadius > 0f
        }

        override fun release() = Unit
    }

    private inner class NativeCoverViewComponent(id: String) :
        BaseNativeComponent(id, COVER_VIEW_TYPE) {
        override val view: TextView = TextView(activity).apply {
            includeFontPadding = false
            gravity = Gravity.CENTER_VERTICAL
            ellipsize = TextUtils.TruncateAt.END
        }

        override fun update(params: JSONObject) {
            super.update(params)
            applyCommonStyle(params)
            val style = params.optJSONObject("style")
            view.text = params.optString("text")
            style?.let {
                parseCssColor(it.optString("color"))?.let(view::setTextColor)
                parseCssPx(it.optString("fontSize")).takeIf { size -> size > 0 }?.let { size ->
                    view.textSize = pxToSp(size.toFloat())
                }
                view.typeface = if (isBoldFontWeight(it.optString("fontWeight"))) {
                    Typeface.DEFAULT_BOLD
                } else {
                    Typeface.DEFAULT
                }
                view.gravity = when (it.optString("textAlign")) {
                    "center" -> Gravity.CENTER
                    "right", "end" -> Gravity.END or Gravity.CENTER_VERTICAL
                    else -> Gravity.START or Gravity.CENTER_VERTICAL
                }
                val lineHeight = parseCssPx(it.optString("lineHeight"))
                if (lineHeight > 0) {
                    view.setLineSpacing(lineHeight.toFloat() - view.textSize, 1f)
                }
            }
        }
    }

    private inner class NativeCoverImageComponent(id: String) :
        BaseNativeComponent(id, COVER_IMAGE_TYPE) {
        override val view: ImageView = ImageView(activity).apply {
            scaleType = ImageView.ScaleType.FIT_CENTER
        }
        private var src = ""
        private var imageJob: Job? = null

        override fun update(params: JSONObject) {
            super.update(params)
            applyCommonStyle(params)
            view.scaleType = when (params.optString("mode")) {
                "scaleToFill" -> ImageView.ScaleType.FIT_XY
                "aspectFill" -> ImageView.ScaleType.CENTER_CROP
                "center" -> ImageView.ScaleType.CENTER
                "top" -> ImageView.ScaleType.FIT_START
                "bottom" -> ImageView.ScaleType.FIT_END
                else -> ImageView.ScaleType.FIT_CENTER
            }
            val nextSrc = params.optString("src", src)
            if (nextSrc != src) {
                src = nextSrc
                loadSource()
            }
        }

        override fun release() {
            imageJob?.cancel()
            view.setImageDrawable(null)
        }

        private fun loadSource() {
            imageJob?.cancel()
            view.setImageDrawable(null)
            if (src.isEmpty()) {
                return
            }
            imageJob = imageScope.launch {
                try {
                    val drawable = withContext(Dispatchers.IO) {
                        activity.imageLoader.execute(
                            ImageRequest.Builder(activity)
                                .data(src)
                                .allowHardware(false)
                                .build()
                        ).drawable
                    }
                    view.setImageDrawable(drawable)
                    sendEvent("bindload", JSONObject().apply { put("id", id) })
                } catch (e: Exception) {
                    LogUtils.e(TAG, "Failed to load cover-image: ${e.message}")
                    sendEvent("binderror", JSONObject().apply {
                        put("id", id)
                        put("errMsg", e.message ?: "cover-image load failed")
                    })
                }
            }
        }
    }

    private inner class NativeVideoComponent(
        private val id: String,
    ) : NativeComponent {
        override val type: String = VIDEO_TYPE
        override val view: FrameLayout = FrameLayout(activity).apply {
            setBackgroundColor(android.graphics.Color.BLACK)
            isClickable = true
            setOnClickListener { toggleControlBar() }
        }
        private val videoView: AspectRatioVideoView = AspectRatioVideoView(activity).also {
            it.isClickable = true
            it.setOnClickListener { toggleControlBar() }
            view.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER
                )
            )
        }
        private val playButton: ImageButton = ImageButton(activity).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(Color.WHITE)
            setImageResource(android.R.drawable.ic_media_play)
            setOnClickListener {
                togglePlay()
            }
        }
        private val centerPlayButton: ImageButton = ImageButton(activity).apply {
            setBackgroundColor(Color.argb(120, 0, 0, 0))
            setColorFilter(Color.WHITE)
            setImageResource(android.R.drawable.ic_media_play)
            setOnClickListener { play() }
        }.also {
            view.addView(
                it,
                FrameLayout.LayoutParams(dp(56), dp(56), Gravity.CENTER)
            )
        }
        private val seekBar: SeekBar = SeekBar(activity).apply {
            max = 1
            progress = 0
            progressTintList = ColorStateList.valueOf(Color.WHITE)
            progressBackgroundTintList = ColorStateList.valueOf(Color.argb(120, 255, 255, 255))
            thumbTintList = ColorStateList.valueOf(Color.WHITE)
            splitTrack = false
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    if (fromUser) {
                        timeText.text = formatVideoTime(progress, videoView.duration)
                    }
                }

                override fun onStartTrackingTouch(seekBar: SeekBar?) {
                    isUserSeeking = true
                }

                override fun onStopTrackingTouch(seekBar: SeekBar?) {
                    isUserSeeking = false
                    videoView.seekTo(seekBar?.progress ?: 0)
                    updateControlProgress()
                }
            })
        }
        private val timeText: TextView = TextView(activity).apply {
            setTextColor(Color.WHITE)
            textSize = 12f
            gravity = Gravity.CENTER_VERTICAL
            text = "00:00/00:00"
        }
        private val controlBar: LinearLayout = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), 0, dp(8), 0)
            setBackgroundColor(Color.argb(110, 0, 0, 0))
            addView(
                playButton,
                LinearLayout.LayoutParams(dp(40), LinearLayout.LayoutParams.MATCH_PARENT)
            )
            addView(
                seekBar,
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            )
            addView(
                timeText,
                LinearLayout.LayoutParams(dp(86), LinearLayout.LayoutParams.MATCH_PARENT)
            )
        }.also {
            view.addView(
                it,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    dp(44),
                    Gravity.BOTTOM
                )
            )
        }

        private val handler = Handler(Looper.getMainLooper())
        private var mediaPlayer: MediaPlayer? = null
        private var src: String = ""
        private var controls: Boolean = true
        private var controlsVisible: Boolean = true
        private var showProgress: Boolean = true
        private var showPlayBtn: Boolean = true
        private var showCenterPlayBtn: Boolean = true
        private var autoplay: Boolean = false
        private var loop: Boolean = false
        private var muted: Boolean = false
        private var initialTimeMs: Int = 0
        private var isPrepared: Boolean = false
        private var pendingPlay: Boolean = false
        private var timeUpdateRunning: Boolean = false
        private var isUserSeeking: Boolean = false
        private var lastLayoutParams: JSONObject? = null
        private var lastNativeLayout: NativeLayout? = null

        private val timeUpdateTask = object : Runnable {
            override fun run() {
                if (videoView.isPlaying) {
                    updateControlProgress()
                    sendEvent("bindtimeupdate", baseEventBody().apply {
                        put("currentTime", videoView.currentPosition / 1000.0)
                        put("duration", videoView.duration.coerceAtLeast(0) / 1000.0)
                    })
                }
                if (timeUpdateRunning) {
                    handler.postDelayed(this, TIME_UPDATE_INTERVAL_MS)
                }
            }
        }

        init {
            videoView.setOnPreparedListener { player ->
                mediaPlayer = player
                isPrepared = true
                videoView.setVideoSize(player.videoWidth, player.videoHeight)
                player.isLooping = loop
                applyMuted()
                val firstFrameTimeMs = if (initialTimeMs > 0) initialTimeMs else FIRST_FRAME_SEEK_MS
                if (firstFrameTimeMs > 0) {
                    player.seekTo(firstFrameTimeMs.toLong(), MediaPlayer.SEEK_CLOSEST)
                }
                sendEvent("bindloadedmetadata", baseEventBody().apply {
                    put("duration", videoView.duration.coerceAtLeast(0) / 1000.0)
                })
                updateControlProgress()
                if (autoplay || pendingPlay) {
                    pendingPlay = false
                    play()
                } else {
                    updatePlayButton()
                }
            }
            videoView.setOnCompletionListener {
                updatePlayButton()
                updateControlProgress()
                sendEvent("bindended", baseEventBody())
                if (!loop) {
                    stopTimeUpdates()
                }
            }
            videoView.setOnErrorListener { _, what, extra ->
                sendEvent("binderror", baseEventBody().apply {
                    put("errMsg", "video:error what=$what extra=$extra")
                })
                true
            }
        }

        override fun update(params: JSONObject) {
            lastLayoutParams = params
            applyLayout(params)
            controls = params.optBoolean("controls", controls)
            showProgress = params.optBoolean("showProgress", showProgress)
            showPlayBtn = params.optBoolean("showPlayBtn", showPlayBtn)
            showCenterPlayBtn = params.optBoolean("showCenterPlayBtn", showCenterPlayBtn)
            autoplay = params.optBoolean("autoplay", autoplay)
            loop = params.optBoolean("loop", loop)
            muted = params.optBoolean("muted", muted)
            initialTimeMs = (params.optDouble("initialTime", initialTimeMs / 1000.0) * 1000).roundToInt()
            applyControlsVisibility()

            mediaPlayer?.isLooping = loop
            applyMuted()

            val nextSrc = params.optString("src", src)
            if (nextSrc != src) {
                src = nextSrc
                loadSource()
            } else if (autoplay && !videoView.isPlaying) {
                play()
            }
        }

        override fun applyLastLayout() {
            lastLayoutParams?.let { applyLayout(it) }
        }

        private fun applyLayout(params: JSONObject) {
            val layout = calculateLayout(params) ?: return
            if (layout == lastNativeLayout) {
                return
            }
            lastNativeLayout = layout
            view.visibility = if (layout.visible) View.VISIBLE else View.GONE
            view.translationZ = layout.zIndex
            val currentParams = view.layoutParams as? FrameLayout.LayoutParams
            if (
                currentParams?.width == layout.width &&
                currentParams.height == layout.height &&
                currentParams.leftMargin == layout.left &&
                currentParams.topMargin == layout.top
            ) {
                return
            }
            view.layoutParams = FrameLayout.LayoutParams(layout.width, layout.height).apply {
                leftMargin = layout.left
                topMargin = layout.top
            }
        }

        fun handleCommand(params: JSONObject) {
            when (params.optString("command")) {
                "play" -> play()
                "pause" -> pause()
                "stop" -> stop()
                "seek" -> seek(params.optDouble("position", 0.0))
                "playbackRate" -> playbackRate(params.optDouble("rate", 1.0).toFloat())
                "requestFullScreen",
                "exitFullScreen",
                "requestBackgroundPlayback",
                "exitBackgroundPlayback",
                "exitPictureInPicture",
                "showStatusBar",
                "hideStatusBar",
                -> LogUtils.d(TAG, "Video command is not implemented: ${params.optString("command")}")
            }
        }

        override fun release() {
            stopTimeUpdates()
            videoView.stopPlayback()
            mediaPlayer = null
            isPrepared = false
            pendingPlay = false
        }

        private fun loadSource() {
            if (src.isEmpty()) {
                return
            }
            try {
                isPrepared = false
                mediaPlayer = null
                pendingPlay = autoplay
                videoView.setVideoURI(Uri.parse(src))
                videoView.requestFocus()
            } catch (e: Exception) {
                LogUtils.e(TAG, "Failed to load video source: ${e.message}")
                sendEvent("binderror", baseEventBody().apply {
                    put("errMsg", "video:error ${e.message}")
                })
            }
        }

        private fun togglePlay() {
            if (videoView.isPlaying) {
                pause()
            } else {
                play()
            }
        }

        private fun play() {
            if (!isPrepared || mediaPlayer == null) {
                pendingPlay = true
                updatePlayButton()
                return
            }
            videoView.start()
            pendingPlay = false
            updatePlayButton()
            updateControlProgress()
            startTimeUpdates()
            sendEvent("bindplay", baseEventBody())
        }

        private fun pause() {
            pendingPlay = false
            if (videoView.isPlaying) {
                videoView.pause()
            }
            updatePlayButton()
            updateControlProgress()
            stopTimeUpdates()
            sendEvent("bindpause", baseEventBody())
        }

        private fun stop() {
            pendingPlay = false
            if (videoView.canSeekBackward() || videoView.canSeekForward() || videoView.isPlaying) {
                videoView.pause()
                videoView.seekTo(0)
            }
            updatePlayButton()
            updateControlProgress()
            stopTimeUpdates()
            sendEvent("bindpause", baseEventBody())
        }

        private fun seek(position: Double) {
            videoView.seekTo((position * 1000).roundToInt().coerceAtLeast(0))
            updateControlProgress()
        }

        private fun playbackRate(rate: Float) {
            try {
                val player = mediaPlayer ?: return
                player.playbackParams = player.playbackParams.setSpeed(rate)
            } catch (e: Exception) {
                LogUtils.e(TAG, "Failed to set video playbackRate: ${e.message}")
            }
        }

        private fun applyMuted() {
            val volume = if (muted) 0f else 1f
            mediaPlayer?.setVolume(volume, volume)
        }

        private fun applyControlsVisibility() {
            if (!controls) {
                controlsVisible = false
            } else if (controlBar.visibility == View.GONE) {
                controlsVisible = true
            }
            controlBar.visibility = if (controls && controlsVisible) View.VISIBLE else View.GONE
            playButton.visibility = if (showPlayBtn) View.VISIBLE else View.GONE
            seekBar.visibility = if (showProgress) View.VISIBLE else View.GONE
            timeText.visibility = if (showProgress) View.VISIBLE else View.GONE
            updatePlayButton()
            updateControlProgress()
        }

        private fun toggleControlBar() {
            if (!controls) {
                return
            }
            controlsVisible = !controlsVisible
            applyControlsVisibility()
        }

        private fun updatePlayButton() {
            playButton.setImageResource(
                if (videoView.isPlaying) {
                    android.R.drawable.ic_media_pause
                } else {
                    android.R.drawable.ic_media_play
                }
            )
            centerPlayButton.visibility = if (
                controls &&
                controlsVisible &&
                showCenterPlayBtn &&
                !videoView.isPlaying &&
                !pendingPlay
            ) {
                View.VISIBLE
            } else {
                View.GONE
            }
        }

        private fun updateControlProgress() {
            if (!controls || isUserSeeking) {
                return
            }
            val duration = videoView.duration.coerceAtLeast(0)
            val position = videoView.currentPosition.coerceAtLeast(0)
            seekBar.max = duration.coerceAtLeast(1)
            seekBar.progress = position.coerceIn(0, seekBar.max)
            timeText.text = formatVideoTime(position, duration)
        }

        private fun startTimeUpdates() {
            if (timeUpdateRunning) {
                return
            }
            timeUpdateRunning = true
            handler.post(timeUpdateTask)
        }

        private fun stopTimeUpdates() {
            timeUpdateRunning = false
            handler.removeCallbacks(timeUpdateTask)
        }

        private fun baseEventBody(): JSONObject {
            return JSONObject().apply {
                put("id", id)
                put("src", src)
            }
        }
    }

    companion object {
        private const val TAG = "NativeComponentHost"
        private const val VIDEO_TYPE = "native/video"
        private const val COVER_VIEW_TYPE = "native/cover-view"
        private const val COVER_IMAGE_TYPE = "native/cover-image"
        private const val TIME_UPDATE_INTERVAL_MS = 250L
        private const val FIRST_FRAME_SEEK_MS = 1
        private val SUPPORTED_TYPES = setOf(VIDEO_TYPE, COVER_VIEW_TYPE, COVER_IMAGE_TYPE)
    }

    private fun pxToSp(px: Float): Float {
        return px / activity.resources.displayMetrics.scaledDensity
    }

    private fun dp(value: Int): Int {
        return (value * activity.resources.displayMetrics.density).roundToInt()
    }
}

private data class NativeLayout(
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int,
    val visible: Boolean,
    val zIndex: Float,
)

private fun parseCssPx(value: String?): Int {
    val token = value
        ?.trim()
        ?.split(Regex("\\s+"))
        ?.firstOrNull()
        ?.removeSuffix("px")
        ?: return 0
    return token.toFloatOrNull()?.roundToInt() ?: 0
}

private fun isBoldFontWeight(value: String?): Boolean {
    val normalized = value?.trim() ?: return false
    return normalized == "bold" || (normalized.toIntOrNull() ?: 0) >= 600
}

private fun parseCssColor(value: String?): Int? {
    val color = value?.trim()?.lowercase().orEmpty()
    if (color.isEmpty()) {
        return null
    }
    if (color == "transparent") {
        return Color.TRANSPARENT
    }
    if (color.startsWith("rgb(") || color.startsWith("rgba(")) {
        val values = color
            .substringAfter("(")
            .substringBefore(")")
            .split(",")
            .map { it.trim() }
        val red = values.getOrNull(0)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: return null
        val green = values.getOrNull(1)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: return null
        val blue = values.getOrNull(2)?.toFloatOrNull()?.roundToInt()?.coerceIn(0, 255) ?: return null
        val alpha = values.getOrNull(3)?.toFloatOrNull()?.let {
            if (it <= 1f) (it * 255).roundToInt() else it.roundToInt()
        }?.coerceIn(0, 255) ?: 255
        return Color.argb(alpha, red, green, blue)
    }
    return runCatching { Color.parseColor(color) }.getOrNull()
}

private fun formatVideoTime(positionMs: Int, durationMs: Int): String {
    return "${formatVideoTimePart(positionMs)}/${formatVideoTimePart(durationMs.coerceAtLeast(0))}"
}

private fun formatVideoTimePart(timeMs: Int): String {
    val totalSeconds = (timeMs / 1000).coerceAtLeast(0)
    val minutes = totalSeconds / 60
    val seconds = totalSeconds % 60
    return "${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}"
}

private class AspectRatioVideoView(context: android.content.Context) : VideoView(context) {
    private var videoWidth = 0
    private var videoHeight = 0

    fun setVideoSize(width: Int, height: Int) {
        videoWidth = width
        videoHeight = height
        requestLayout()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val parentWidth = View.MeasureSpec.getSize(widthMeasureSpec)
        val parentHeight = View.MeasureSpec.getSize(heightMeasureSpec)
        if (videoWidth <= 0 || videoHeight <= 0 || parentWidth <= 0 || parentHeight <= 0) {
            setMeasuredDimension(parentWidth, parentHeight)
            return
        }

        val parentRatio = parentWidth.toFloat() / parentHeight.toFloat()
        val videoRatio = videoWidth.toFloat() / videoHeight.toFloat()
        val measuredWidth: Int
        val measuredHeight: Int
        if (videoRatio > parentRatio) {
            measuredWidth = parentWidth
            measuredHeight = (parentWidth / videoRatio).roundToInt()
        } else {
            measuredHeight = parentHeight
            measuredWidth = (parentHeight * videoRatio).roundToInt()
        }
        setMeasuredDimension(measuredWidth, measuredHeight)
    }
}
