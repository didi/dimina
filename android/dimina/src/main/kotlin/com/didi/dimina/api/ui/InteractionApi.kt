package com.didi.dimina.api.ui

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.toColorInt
import com.didi.dimina.R
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.ui.container.DiminaActivity
import kotlinx.coroutines.delay
import org.json.JSONObject

private const val MODAL_MAX_HEIGHT_FRACTION = 0.9f
private val MODAL_DIVIDER_COLOR = Color.Black.copy(alpha = 0.1f)
private val MODAL_DIVIDER_THICKNESS = 0.5.dp

/**
 * Author: Doslin
 */
class InteractionApi : BaseApiHandler() {
    private companion object {
        const val SHOW_TOAST = "showToast"
        const val SHOW_MODAL = "showModal"
        const val SHOW_LOADING = "showLoading"
        const val HIDE_TOAST = "hideToast"
        const val HIDE_LOADING = "hideLoading"
        const val SHOW_ACTION_SHEET = "showActionSheet"
    }

    override val apiNames = setOf(SHOW_TOAST, SHOW_MODAL, SHOW_LOADING, HIDE_TOAST, HIDE_LOADING, SHOW_ACTION_SHEET)

    private var handler = Handler(Looper.getMainLooper())

    // Toast management
    private var dismissToast: Runnable? = null
    private var currentToastView: ComposeView? = null
    private var currentMaskView: View? = null
    private var currentModalView: ComposeView? = null
    private var currentModalMaskView: View? = null

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SHOW_TOAST -> {
                val title = params.getString("title") // Required
                val icon = params.optString("icon", "success") // Optional, default "success"
                val duration = params.optInt("duration", 1500) // Optional, default 1500
                val mask = params.optBoolean("mask", false) // Optional, default false
                showToast(
                    context = activity,
                    title = title,
                    icon = icon,
                    duration = duration,
                    mask = mask
                )
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SHOW_TOAST:ok")
                })
            }

            SHOW_MODAL -> {
                val title = params.optString("title", "")
                val content = params.optString("content", "")
                val showCancel = params.optBoolean("showCancel", true)
                val cancelText = params.optString("cancelText", "取消")
                val cancelColor = params.optString("cancelColor", "#000000")
                val confirmText = params.optString("confirmText", "确定")
                val confirmColor = params.optString("confirmColor", "#576B95")

                activity.cancelActiveWebViewTouch()
                showModal(
                    context = activity,
                    title = title,
                    content = content,
                    showCancel = showCancel,
                    cancelText = cancelText,
                    cancelColor = cancelColor,
                    confirmText = confirmText,
                    confirmColor = confirmColor
                ) { isConfirmed ->
                    val resultData = JSONObject().apply {
                        put("confirm", isConfirmed)
                        put("cancel", !isConfirmed)
                        put("errMsg", "$SHOW_MODAL:ok")
                    }
                    ApiUtils.invokeSuccess(params, resultData, responseCallback)
                    ApiUtils.invokeComplete(params, responseCallback)
                    return@showModal
                }
                NoneResult()
            }

            SHOW_LOADING -> {
                val title = params.getString("title") // Required
                val mask = params.optBoolean("mask", false) // Optional, default false
                showToast(
                    context = activity,
                    title = title,
                    icon = "loading",
                    duration = Int.MAX_VALUE,
                    mask = mask
                )
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SHOW_LOADING:ok")
                })
            }

            HIDE_TOAST -> {
                hideToast(activity)

                AsyncResult(JSONObject().apply {
                    put("errMsg", "$HIDE_TOAST:ok")
                })
            }

            HIDE_LOADING -> {
                hideToast(activity)

                AsyncResult(JSONObject().apply {
                    put("errMsg", "$HIDE_LOADING:ok")
                })
            }

            SHOW_ACTION_SHEET-> {
                val itemColor = params.optString("itemColor", "#000000")
                val itemList = params.optJSONArray("itemList")
                val list = itemList?.let {
                    (0 until it.length()).map { index -> it.getString(index) }
                } ?: emptyList<String>()

                activity.showActionSheet(list, itemColor) { index ->
                    if (index == -1) {
                        val resultData = JSONObject().apply {
                            put("errMsg", "$SHOW_ACTION_SHEET:fail cancel")
                        }
                        ApiUtils.invokeFail(params, resultData, responseCallback)
                    } else {
                        val resultData = JSONObject().apply {
                            put("tapIndex", index)
                            put("errMsg", "$SHOW_ACTION_SHEET:ok")
                        }
                        ApiUtils.invokeSuccess(params, resultData, responseCallback)
                    }
                    ApiUtils.invokeComplete(params, responseCallback)
                }
                NoneResult()
            }

            else -> super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    /**
     * Displays a custom modal using Jetpack Compose, centered on the screen.
     */
    private fun showModal(
        context: Context,
        title: String,
        content: String,
        showCancel: Boolean,
        cancelText: String,
        cancelColor: String,
        confirmText: String,
        confirmColor: String,
        onResult: (Boolean) -> Unit,
    ) {
        handler.post {
            val rootView = (context as Activity).window.decorView.rootView as ViewGroup

            // Remove any existing modal
            currentModalView?.let {
                rootView.removeView(it)
                currentModalView = null
            }

            currentModalMaskView?.let {
                rootView.removeView(it)
                currentModalMaskView = null
            }

            // Add mask
            val maskView = View(context).apply {
                setBackgroundColor(0x80000000.toInt())
                isClickable = true
            }
            rootView.addView(
                maskView,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            currentModalMaskView = maskView

            // Add modal
            val composeView = ComposeView(context).apply {
                setContent {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .wrapContentSize(Alignment.Center)
                    ) {
                        ModalContent(
                            title = title,
                            content = content,
                            showCancel = showCancel,
                            cancelText = cancelText,
                            cancelColor = Color(cancelColor.toColorInt()),
                            confirmText = confirmText,
                            confirmColor = Color(confirmColor.toColorInt()),
                            onCancel = {
                                rootView.removeView(maskView)
                                rootView.removeView(currentModalView)
                                currentModalView = null
                                onResult(false)
                            },
                            onConfirm = {
                                rootView.removeView(maskView)
                                rootView.removeView(currentModalView)
                                currentModalView = null
                                onResult(true)
                            }
                        )
                    }
                }
            }
            rootView.addView(
                composeView,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            currentModalView = composeView
        }
    }

    /**
     * Hides the currently displayed toast.
     */
    private fun hideToast(context: Context) {
        // Serialize hide with show, including calls arriving from the service thread.
        handler.post { removeCurrentToast() }
    }

    private fun removeCurrentToast() {
        dismissToast?.let { handler.removeCallbacks(it) }
        dismissToast = null
        // The caller may now be on another Activity. Remove from the owning parent.
        currentToastView?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.disposeComposition()
        }
        currentToastView = null
        currentMaskView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        currentMaskView = null
    }

    private fun showToast(
        context: Context,
        title: String,
        icon: String? = "success",
        duration: Int = 1500,
        mask: Boolean = false,
    ) {

        handler.post {
            // Only cancel the old timeout; queued API calls must retain FIFO order.
            removeCurrentToast()
            val activity = context as Activity
            if (activity.isFinishing || activity.isDestroyed) return@post
            val rootView = activity.window.decorView.rootView as ViewGroup

            if (mask) {
                val maskView = View(context).apply {
                    setBackgroundColor(0x80000000.toInt())
                    isClickable = true
                }
                rootView.addView(
                    maskView,
                    ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                currentMaskView = maskView // Store reference

            }

            val composeView = ComposeView(context).apply {
                setContent {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .wrapContentSize(Alignment.Center)
                    ) {
                        ToastContent(
                            title = title,
                            icon = icon,
                            duration = duration.toLong()
                        )
                    }
                }
            }
            rootView.addView(
                composeView,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            currentToastView = composeView // Store reference

            // A timeout belongs to this presentation, never to a later loading/toast.
            if (duration != Int.MAX_VALUE) {
                val dismiss = Runnable {
                    if (currentToastView === composeView) removeCurrentToast()
                }
                dismissToast = dismiss
                handler.postDelayed(dismiss, duration.toLong().coerceAtLeast(0))
            }
        }
    }
}

@Composable
fun ToastContent(
    title: String,
    icon: String?,
    duration: Long,
) {
    // Auto-dismiss after duration
    LaunchedEffect(Unit) {
        delay(duration)
    }

    Box(
        modifier = Modifier
            .size(120.dp, 120.dp)
            .background(Color(0xFF333333), RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            // Icon or Image
            when (icon) {
                "success" -> {
                    Icon(
                        painter = painterResource(id = R.drawable.ic_success),
                        contentDescription = "Success",
                        tint = Color.White,
                        modifier = Modifier.size(40.dp)
                    )
                }

                "error" -> {
                    Icon(
                        painter = painterResource(id = R.drawable.ic_error),
                        contentDescription = "Error",
                        tint = Color.White,
                        modifier = Modifier.size(40.dp)
                    )
                }

                "loading" -> {
                    CircularProgressIndicator(
                        color = Color.White,
                        modifier = Modifier.size(24.dp),
                        strokeWidth = 2.dp
                    )
                }

                else -> {
                    // No icon for "none" or invalid values
                }
            }

            // Title
            Text(
                text = title,
                color = Color.White,
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                maxLines = if (icon == "success" || icon == "error" || icon == "loading") 1 else 2
            )
        }
    }
}

/**
 * Composable function to define the modal UI.
 */
@Composable
fun ModalContent(
    title: String,
    content: String,
    showCancel: Boolean,
    cancelText: String,
    cancelColor: Color,
    confirmText: String,
    confirmColor: Color,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
) {
    BoxWithConstraints {
        val contentScrollState = rememberScrollState()
        Column(
            modifier = Modifier
                .fillMaxWidth(0.8f)
                .heightIn(max = maxHeight * MODAL_MAX_HEIGHT_FRACTION)
                .background(Color.White, RoundedCornerShape(12.dp))
                .clip(RoundedCornerShape(12.dp))
                .padding(top = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // Title
            if (title.isNotEmpty()) {
                Text(
                    text = title,
                    color = Color.Black.copy(alpha = 0.9f),
                    fontSize = 17.sp,
                    lineHeight = 23.8.sp,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 24.dp, end = 24.dp, bottom = 16.dp)
                )
            }

            // Content
            if (content.isNotEmpty()) {
                Box(
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .fillMaxWidth()
                        .verticalScroll(contentScrollState)
                        .padding(
                            start = 24.dp,
                            top = if (title.isEmpty()) 16.dp else 0.dp,
                            end = 24.dp,
                            bottom = 32.dp
                        )
                ) {
                    Text(
                        text = content,
                        color = Color.Black.copy(alpha = 0.5f),
                        fontSize = 17.sp,
                        lineHeight = 23.8.sp,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            }

            HorizontalDivider(
                modifier = Modifier.fillMaxWidth(),
                thickness = MODAL_DIVIDER_THICKNESS,
                color = MODAL_DIVIDER_COLOR
            )

            // Buttons
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                if (showCancel) {
                    TextButton(
                        onClick = onCancel,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxHeight()
                    ) {
                        Text(
                            text = cancelText.take(4),
                            color = cancelColor,
                            fontSize = 17.sp,
                            fontWeight = FontWeight.Bold
                        )
                    }

                    VerticalDivider(
                        modifier = Modifier.fillMaxHeight(),
                        thickness = MODAL_DIVIDER_THICKNESS,
                        color = MODAL_DIVIDER_COLOR
                    )
                }

                TextButton(
                    onClick = onConfirm,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                ) {
                    Text(
                        text = confirmText.take(4),
                        color = confirmColor,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }
    }
}
