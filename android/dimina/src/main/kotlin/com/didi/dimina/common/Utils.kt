package com.didi.dimina.common

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Environment
import android.os.Build
import android.provider.MediaStore
import android.util.TypedValue
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.didi.dimina.BuildConfig
import coil.imageLoader
import coil.request.ImageRequest
import com.didi.dimina.bean.App
import com.didi.dimina.bean.MergedPageConfig
import com.didi.dimina.bean.PageModule
import com.didi.dimina.bean.PathInfo
import com.didi.dimina.bean.WindowConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.zip.ZipInputStream
import kotlin.math.absoluteValue
import kotlin.math.roundToInt

/**
 * Author: Doslin
 */
object Utils {

    private const val TAG = "utils"

    /**
     * 解析 URL，拆分成 pagePath 和 query
     * @param url 输入的 URL 字符串，例如 "pages/index/index?id=123&name=abc"
     * @return PathInfo 包含 pagePath 和 query 的数据对象
     */
    fun queryPath(url: String): PathInfo {
        // 如果 URL 为空，返回默认值
        if (url.isEmpty()) {
            return PathInfo("", null)
        }

        // 分离路径和查询字符串。pagePath 统一去除前导斜杠：宿主直启 path（扫码/
        // 分享）与 wx.* 路由的 "/pages/x/y" 写法都归一到 app-config modules key
        // 的形态（无前导斜杠），保证 tabBar / 首页判定与页面配置查找不因写法发散
        val parts = url.split("?", limit = 2)
        val pagePath = parts[0].trim().trimStart('/')

        // 如果没有查询字符串，返回只有 pagePath 的结果
        if (parts.size == 1) {
            return PathInfo(pagePath, null)
        }

        // 解析查询字符串
        val queryString = parts[1]
        val queryMap = mutableMapOf<String, String>()

        // 分割参数并处理键值对
        queryString.split("&").forEach { param ->
            val keyValue = param.split("=", limit = 2)
            if (keyValue.size == 2 && keyValue[0].isNotEmpty()) {
                queryMap[keyValue[0].trim()] = keyValue[1].trim()
            } else if (keyValue.size == 1 && keyValue[0].isNotEmpty()) {
                queryMap[keyValue[0].trim()] = ""
            }
        }

        // 将 queryMap 转换为 JSON 字符串
        val queryJson = if (queryMap.isNotEmpty()) {
            JSONObject(queryMap)
        } else {
            null
        }

        // 返回结果
        return PathInfo(pagePath, queryJson)
    }

    /**
     * 合并页面配置
     * @param appConfig 全局应用配置
     * @param pageConfig 页面私有配置
     * @return 合并后的页面配置
     */
    fun mergePageConfig(appConfig: App, pageConfig: PageModule?): MergedPageConfig {
        val appWindowConfig = appConfig.window ?: WindowConfig()
        val pagePrivateConfig = pageConfig ?: PageModule()

        return MergedPageConfig(
            navigationBarTitleText = pagePrivateConfig.navigationBarTitleText
                ?: appWindowConfig.navigationBarTitleText ?: "",
            navigationBarBackgroundColor = pagePrivateConfig.navigationBarBackgroundColor
                ?: appWindowConfig.navigationBarBackgroundColor ?: "#000",
            navigationBarTextStyle = pagePrivateConfig.navigationBarTextStyle
                ?: appWindowConfig.navigationBarTextStyle ?: "white",
            backgroundColor = pagePrivateConfig.backgroundColor
                ?: appWindowConfig.backgroundColor ?: "#fff",
            navigationStyle = pagePrivateConfig.navigationStyle
                ?: appWindowConfig.navigationStyle ?: "default",
            homeButton = pagePrivateConfig.homeButton
                ?: appWindowConfig.homeButton ?: false,
            usingComponents = pagePrivateConfig.usingComponents ?: emptyMap()
        )
    }

    private const val CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

    /**
     * 生成指定长度的随机 UUID 字符串
     * @param len 生成的字符串长度，默认为 5
     * @return 随机字符串
     */
    fun uuid(len: Int = 5): String {
        // 生成随机字节数组
        val randomValues = ByteArray(len) { (0..255).random().toByte() } // 使用 Kotlin 的 random()

        // 将字节映射到字符集并连接成字符串
        return randomValues.joinToString("") { byte ->
            CHARACTERS[byte.toInt() and 0xFF % CHARACTERS.length].toString()
        }
    }

    /**
     * Unzips the mini program package from assets
     * @param zipFileName The ID of the mini program to unzip
     * @param target The directory to extract the mini program to
     * @param keep Whether to keep the existing files in the target directory
     * @return true if extraction was successful, false otherwise
     */
    fun unzipAssets(context: Context, zipFileName: String, target: String, keep: Boolean = false): Boolean {
        // Create directory for the mini program if it doesn't exist
        val miniProgramDir = File(context.filesDir, target)
        if (miniProgramDir.exists()) {
            if (keep) {
                LogUtils.d(TAG, "Existing directory for mini program: $zipFileName")
                return false
            } else {
                miniProgramDir.deleteRecursively() // Clean up existing files
            }
        }
        miniProgramDir.mkdirs()

        // Get the zip file from assets
        LogUtils.d(TAG, "Extracting from assets: $zipFileName")

        try {
            // Open the zip file from assets
            context.assets.open(zipFileName).use { inputStream ->
                ZipInputStream(inputStream).use { zipInputStream ->
                    var zipEntry = zipInputStream.nextEntry
                    val buffer = ByteArray(1024)

                    // Extract all files from the zip
                    while (zipEntry != null) {
                        val entryName = zipEntry.name
                        val newFile = File(miniProgramDir, entryName)

                        // Create directories if needed
                        if (zipEntry.isDirectory) {
                            newFile.mkdirs()
                        } else {
                            // Create parent directories if they don't exist
                            newFile.parentFile?.mkdirs()

                            // Extract the file
                            FileOutputStream(newFile).use { fileOutputStream ->
                                var len: Int
                                while (zipInputStream.read(buffer).also { len = it } > 0) {
                                    fileOutputStream.write(buffer, 0, len)
                                }
                            }
                        }

                        zipInputStream.closeEntry()
                        zipEntry = zipInputStream.nextEntry
                    }
                }
            }

            return true

        } catch (e: IOException) {
            LogUtils.e(TAG, "Error extracting: ${e.message}")
            e.printStackTrace()
            return false
        } catch (e: Exception) {
            LogUtils.e(TAG, "Unexpected error: ${e.message}")
            e.printStackTrace()
            return false
        }
    }

    // Mini program system APIs expect CSS/logical px, not Android physical px.
    @SuppressLint("InternalInsetResource")
    fun getStatusBarHeight(currentActivity: Activity): Int {
        val statusBarInsetPx = ViewCompat.getRootWindowInsets(currentActivity.window.decorView)
            ?.getInsets(WindowInsetsCompat.Type.statusBars())
            ?.top
            ?: 0
        val statusBarHeightPx = listOf(
            getAndroidDimensionPixelSize(currentActivity, "status_bar_height_default"),
            getAndroidDimensionPixelSize(currentActivity, "status_bar_height"),
            statusBarInsetPx
        ).filter { it > 0 }.minOrNull() ?: 0
        return pxToDpInt(statusBarHeightPx, currentActivity)
    }

    fun getNavigationBarHeight(currentActivity: Activity): Int {
        val navigationBarInset = ViewCompat.getRootWindowInsets(currentActivity.window.decorView)
            ?.getInsets(WindowInsetsCompat.Type.navigationBars())
            ?.bottom
            ?: 0
        return pxToDpInt(navigationBarInset, currentActivity)
    }

    fun pxToDpInt(px: Int, context: Context): Int {
        val density = context.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f
        return (px / density).roundToInt()
    }

    @SuppressLint("InternalInsetResource")
    private fun getAndroidDimensionPixelSize(context: Context, name: String): Int {
        val resourceId = context.resources.getIdentifier(name, "dimen", "android")
        return if (resourceId > 0) {
            context.resources.getDimensionPixelSize(resourceId)
        } else {
            0
        }
    }

    fun getMiniProgramSystemInfo(currentActivity: Activity): JSONObject {
        val displayMetrics = currentActivity.resources.displayMetrics
        val screenWidth = pxToDpInt(displayMetrics.widthPixels, currentActivity)
        val screenHeight = pxToDpInt(displayMetrics.heightPixels, currentActivity)
        val windowBounds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            currentActivity.windowManager.currentWindowMetrics.bounds
        } else {
            null
        }
        val windowWidth = windowBounds?.width()?.let { pxToDpInt(it, currentActivity) } ?: screenWidth
        val fullWindowHeight = windowBounds?.height()?.let { pxToDpInt(it, currentActivity) } ?: screenHeight
        val statusBarHeight = getStatusBarHeight(currentActivity)
        val navigationBarHeight = getNavigationBarHeight(currentActivity)
        val safeAreaTop = statusBarHeight
        val safeAreaBottom = (fullWindowHeight - navigationBarHeight).coerceAtLeast(safeAreaTop)
        val safeAreaHeight = (safeAreaBottom - safeAreaTop).coerceAtLeast(0)

        return JSONObject().apply {
            put("brand", Build.BRAND)
            put("model", Build.MODEL)
            put("pixelRatio", displayMetrics.density)
            put("screenWidth", screenWidth)
            put("screenHeight", screenHeight)
            put("windowWidth", windowWidth)
            put("windowHeight", safeAreaHeight)
            put("statusBarHeight", statusBarHeight)
            put("screenTop", statusBarHeight)
            put("safeArea", JSONObject().apply {
                put("left", 0)
                put("right", windowWidth)
                put("top", safeAreaTop)
                put("bottom", safeAreaBottom)
                put("width", windowWidth)
                put("height", safeAreaHeight)
            })
            put("language", currentActivity.resources.configuration.locale.language)
            put("version", Build.VERSION.RELEASE)
            put("system", "Android ${Build.VERSION.RELEASE}")
            put("platform", "android")
            put("SDKVersion", BuildConfig.SDK_VERSION)
            put("deviceOrientation", currentActivity.resources.configuration.orientation.let {
                when (it) {
                    android.content.res.Configuration.ORIENTATION_PORTRAIT -> "portrait"
                    android.content.res.Configuration.ORIENTATION_LANDSCAPE -> "landscape"
                    else -> "undefined"
                }
            })
        }
    }

    fun getMenuButtonBoundingClientRect(currentActivity: Activity): JSONObject {
        val systemInfo = getMiniProgramSystemInfo(currentActivity)
        val rect = MenuButtonLayout.calculate(
            windowWidth = systemInfo.getInt("windowWidth"),
            statusBarHeight = systemInfo.getInt("statusBarHeight"),
        )

        return JSONObject().apply {
            put("width", rect.width)
            put("height", rect.height)
            put("top", rect.top)
            put("right", rect.right)
            put("bottom", rect.bottom)
            put("left", rect.left)
            put("x", rect.left)
            put("y", rect.top)
        }
    }

    fun saveImageToGallery(context: Context, url: String) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val request = ImageRequest.Builder(context)
                    .data(url)
                    .allowHardware(false)
                    .build()

                val drawable = context.imageLoader.execute(request).drawable as? BitmapDrawable
                val bitmap = drawable?.bitmap

                bitmap?.let {
                    val contentValues = ContentValues().apply {
                        put(MediaStore.Images.Media.DISPLAY_NAME, "image_${System.currentTimeMillis()}.jpg")
                        put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES) // Scoped Storage 目录
                    }

                    val uri = context.contentResolver.insert(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI, contentValues
                    )

                    uri?.let {
                        context.contentResolver.openOutputStream(it)?.use { outputStream ->
                            bitmap.compress(Bitmap.CompressFormat.JPEG, 100, outputStream)
                        }
                        withContext(Dispatchers.Main) {
                            Toast.makeText(context, "图片已保存", Toast.LENGTH_SHORT).show()
                        }
                    }
                }
            } catch (e: Exception) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(context, "保存失败: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    // Function to generate a consistent color based on the name string
    fun generateColorFromName(name: String): Long {
        // If name is empty, return a default color
        if (name.isEmpty()) {
            return 0xFF2196F3 // Material Blue
        }

        // Use the hash code of the name as a seed for color generation
        val hash = name.hashCode()

        // Generate HSV color with consistent hue based on name
        // Use a limited range of saturation and value for visually pleasing colors
        val hue = (hash.absoluteValue % 360).toFloat()
        val saturation = 0.7f + (hash % 3000) / 10000f // Range: 0.7-1.0
        val value = 0.8f + (hash % 2000) / 10000f // Range: 0.8-1.0

        // Convert HSV to RGB
        val hsv = floatArrayOf(hue, saturation, value)
        val rgbColor = android.graphics.Color.HSVToColor(hsv)

        // Add full opacity (0xFF) and convert to Long
        return 0xFF000000 or rgbColor.toLong()
    }

    fun pxToDp(px: Float, context: Context): Float {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_PX, px, context.resources.displayMetrics
        ) / context.resources.displayMetrics.density
    }

    fun dpToPx(dp: Float, context: Context): Float {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, dp, context.resources.displayMetrics
        )
    }
}
