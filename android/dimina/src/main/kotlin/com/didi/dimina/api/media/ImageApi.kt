package com.didi.dimina.api.media

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.content.Intent
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import androidx.lifecycle.lifecycleScope
import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.common.ApiUtils
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.PathUtils
import com.didi.dimina.common.Utils
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.container.ImagePreviewActivity
import com.didi.dimina.ui.view.MediaType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * canvasToTempFilePath hands the same result to success/fail and to complete: mini programs read
 * res.errMsg and res.tempFilePath inside complete, and complete without a result hands them
 * undefined.
 */
internal fun canvasTempFileFailure(reason: String): AsyncResult = AsyncResult(
    value = JSONObject().apply { put("errMsg", "canvasToTempFilePath:fail $reason") },
    completeCarriesResult = true,
)

/**
 * 同一个小程序同时只做一次解码加写盘。同步实现时主线程天然给它排队，挪到后台之后就没有这层
 * 约束了，而单次解码上限已经是 32 MB。这条锁只约束解码与写盘阶段，排队中的每个请求仍各自
 * 持有自己那份 base64 字符串。
 */
internal object CanvasExportQueue {
    private val locks = ConcurrentHashMap<String, Mutex>()

    suspend fun <T> serialized(appId: String, block: suspend () -> T): T =
        locks.computeIfAbsent(appId) { Mutex() }.withLock { block() }
}

/**
 * 按同步路径（MiniApp.invokeAPI）的契约派发结果：errMsg 以 ":ok" 结尾走 success，否则走 fail，
 * complete 无论如何都发且携带同一个 result。canvas 的写盘挪到后台后没有人再替它做这件事，
 * 所以这段是手写的，单独可测。
 */
internal fun dispatchCanvasResult(
    params: JSONObject,
    result: JSONObject,
    responseCallback: (String) -> Unit,
) {
    try {
        if (result.optString("errMsg").endsWith(":ok")) {
            ApiUtils.invokeSuccess(params, result, responseCallback)
        } else {
            ApiUtils.invokeFail(params, result, responseCallback)
        }
    } finally {
        ApiUtils.invokeComplete(params, responseCallback, result)
    }
}

internal fun canvasTempFileSuccess(tempFilePath: String): AsyncResult = AsyncResult(
    value = JSONObject().apply {
        put("tempFilePath", tempFilePath)
        put("errMsg", "canvasToTempFilePath:ok")
    },
    completeCarriesResult = true,
)

/**
 * Author: Doslin
 */
class ImageApi : BaseApiHandler() {
    private companion object {
        const val SAVE_IMAGE_TO_PHOTOS_ALBUM = "saveImageToPhotosAlbum"
        const val SAVE_CANVAS_TEMP_FILE = "saveCanvasTempFile"
        const val PREVIEW_IMAGE = "previewImage"
        const val COMPRESS_IMAGE = "compressImage"
        const val CHOOSE_IMAGE = "chooseImage"
        const val CHOOSE_MESSAGE_FILE = "chooseMessageFile"
        // Internal bridge safety ceiling, not a WeChat Canvas API limit. It bounds the
        // extra native allocation and temp-file write after the data URL crosses the bridge.
        const val MAX_CANVAS_IMAGE_BYTES = 32 * 1024 * 1024
        const val MAX_CANVAS_BASE64_CHARS = (MAX_CANVAS_IMAGE_BYTES * 4 / 3) + 8
        val SAFE_APP_ID = Regex("^[A-Za-z0-9._-]+$")
        val STRICT_BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")

        // 每个页面是自己的 DiminaActivity（navigateTo 走 startActivity），而 QuickJS 按 appId 共享。
        // 绑 activity.lifecycleScope 的话，用户在写盘途中返回上一页就会取消协程，success/fail/complete
        // 一个都不发，等 complete 的小程序永远挂住。写盘的真正归属是 JS 引擎而不是页面，所以用独立
        // scope；引擎已销毁时迟到的回调由 JsCore.postMessage 丢弃。
        // 同步路径上派发回调抛错会被 MiniApp.invokeAPI 接住转成 fail，进程照常活着。挪进协程之后
        // 没有处理器的未捕获异常会走 Thread.uncaughtExceptionHandler 直接崩宿主，所以这里补一个。
        val canvasIoScope = CoroutineScope(
            SupervisorJob() + Dispatchers.IO +
                CoroutineExceptionHandler { _, error ->
                    LogUtils.e("ImageApi", "canvas export failed: $error")
                },
        )
    }

    override val apiNames =
        setOf(
            SAVE_IMAGE_TO_PHOTOS_ALBUM,
            SAVE_CANVAS_TEMP_FILE,
            PREVIEW_IMAGE,
            COMPRESS_IMAGE,
            CHOOSE_IMAGE,
            CHOOSE_MESSAGE_FILE,
        )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        return when (apiName) {
            SAVE_CANVAS_TEMP_FILE -> saveCanvasTempFile(activity, appId, params, responseCallback)

            SAVE_IMAGE_TO_PHOTOS_ALBUM -> {
                val filePath = params.optString("filePath")
                if (PathUtils.isLegalPath(filePath)) {
                    Utils.saveImageToGallery(activity, PathUtils.pathToReal(activity, filePath, appId))
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$SAVE_IMAGE_TO_PHOTOS_ALBUM:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$SAVE_IMAGE_TO_PHOTOS_ALBUM:fail invalid file path")
                    })
                }
            }

            PREVIEW_IMAGE -> {
                val urls = params.optJSONArray("urls")
                if (urls != null && urls.length() > 0) {
                    var current = params.optString("current", urls.getString(0))
                    var showMenu = params.optBoolean("showmenu", true) // 是否显示长按菜单
                    val urlList = mutableListOf<String>()
                    for (i in 0 until urls.length()) {
                        urlList.add(urls.optString(i))
                    }
                    ImagePreviewActivity.launch(activity, urlList, current, showMenu)
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_IMAGE:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_IMAGE:fail invalid url")
                    })
                }
            }

            COMPRESS_IMAGE -> {
                val src = params.optString("src")
                if (PathUtils.isLegalPath(src)) {
                    val quality = params.optInt("quality", 80)
                    val bitmap = BitmapFactory.decodeFile(PathUtils.pathToReal(activity, src, appId))
                    val compressedFile = File.createTempFile(
                        "IMG_${System.currentTimeMillis()}",
                        ".jpg",
                        PathUtils.appTempRoot(activity, appId)
                    )
                    val outputStream = FileOutputStream(compressedFile)
                    bitmap.compress(Bitmap.CompressFormat.JPEG, quality, outputStream)
                    outputStream.flush()
                    outputStream.close()
                    val virtualPath = PathUtils.pathToVirtual(compressedFile)
                    AsyncResult(JSONObject().apply {
                        put("tempFilePath", virtualPath)
                        put("errMsg", "$COMPRESS_IMAGE:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$COMPRESS_IMAGE:fail")
                    })
                }
            }

            CHOOSE_IMAGE -> {
                val count = params.optInt("count", 9)  // 获取图片数量，默认9张
                val sizeType = params.optJSONArray("sizeType") ?: JSONArray().apply {
                    put("original")
                    put("compressed")
                } // TODO: 是否压缩所选文件

                val sourceType = params.optJSONArray("sourceType") ?: JSONArray().apply {
                    put("album")
                    put("camera")
                }

                // 检查是否允许从相册或相机选择
                val allowAlbum =
                    (0 until sourceType.length()).any { sourceType.getString(it) == "album" }
                val allowCamera =
                    (0 until sourceType.length()).any { sourceType.getString(it) == "camera" }

                if (!allowAlbum && !allowCamera) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$CHOOSE_IMAGE:fail invalid sourceType")
                    })
                }
                activity.handleChooseMedia(
                    type = MediaType.IMAGE,
                    count = count,
                    allowAlbum = allowAlbum,
                    allowCamera = allowCamera
                ) { imagePaths ->
                    val tempFilePaths = JSONArray()
                    val tempFiles = JSONArray()

                    imagePaths.take(count).forEach { path ->
                        val file = File(PathUtils.pathToReal(activity, path, appId))
                        tempFilePaths.put(path)
                        tempFiles.put(JSONObject().apply {
                            put("path", path)
                            put("size", file.length())
                        })
                    }
                    val result = JSONObject().apply {
                        put("errMsg", "$CHOOSE_IMAGE:ok")
                        put("tempFilePaths", tempFilePaths)
                        put("tempFiles", tempFiles)
                    }
                    ApiUtils.invokeSuccess(params, result, responseCallback)
                    ApiUtils.invokeComplete(params, responseCallback)
                }
                NoneResult()
            }

            CHOOSE_MESSAGE_FILE -> chooseMessageFile(activity, appId, params, responseCallback)

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    private fun chooseMessageFile(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val countValue = params.opt("count") as? Number
        if (countValue == null || countValue.toDouble() % 1.0 != 0.0) {
            return completeMessageFileFailure(params, responseCallback, "invalid count")
        }
        val count = countValue.toInt()
        if (count !in 0..ChooseMessageFileContract.MAX_COUNT) {
            return completeMessageFileFailure(params, responseCallback, "invalid count")
        }

        val requestedType = params.optString("type", "all")
        if (requestedType !in ChooseMessageFileContract.supportedTypes) {
            return completeMessageFileFailure(params, responseCallback, "invalid type")
        }

        val extensionValues = params.optJSONArray("extension")
        val extensions = mutableSetOf<String>()
        if (requestedType == "file" && params.has("extension") && extensionValues == null) {
            return completeMessageFileFailure(params, responseCallback, "invalid extension")
        }
        if (requestedType == "file" && extensionValues != null) {
            for (index in 0 until extensionValues.length()) {
                val rawExtension = extensionValues.opt(index) as? String
                    ?: return completeMessageFileFailure(params, responseCallback, "invalid extension")
                val extension = ChooseMessageFileContract.normalizeExtension(rawExtension)
                if (extension.isEmpty()) {
                    return completeMessageFileFailure(params, responseCallback, "invalid extension")
                }
                extensions.add(extension)
            }
        }

        if (count == 0) {
            return completeMessageFileSuccess(params, responseCallback, JSONArray())
        }

        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = when (requestedType) {
                "image" -> "image/*"
                "video" -> "video/*"
                else -> "*/*"
            }
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, count > 1)

            if (requestedType == "file" && extensions.isNotEmpty()) {
                val mimeTypes = extensions.mapNotNull { extension ->
                    MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                }.distinct()
                if (mimeTypes.isNotEmpty()) {
                    putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes.toTypedArray())
                }
            }
        }

        val launched = activity.handleChooseMessageFile(intent) { selected, uris ->
            if (!selected) {
                completeMessageFileFailure(params, responseCallback, "cancel")
                return@handleChooseMessageFile
            }

            activity.lifecycleScope.launch(Dispatchers.IO) {
                val copiedFiles = mutableListOf<File>()
                val outcome = runCatching {
                    val tempFiles = JSONArray()
                    uris.take(count).forEach { uri ->
                        val metadata = queryMessageFileMetadata(activity, uri)
                        if (!ChooseMessageFileContract.accepts(requestedType, extensions, metadata.mimeType, metadata.name)) {
                            return@forEach
                        }

                        val extension = ChooseMessageFileContract.extensionOf(metadata.name)
                            .take(20)
                            .takeIf(String::isNotEmpty)
                            ?.let { ".$it" }
                            .orEmpty()
                        val destination = File(
                            PathUtils.appTempRoot(activity, appId),
                            "${UUID.randomUUID()}$extension",
                        )
                        activity.contentResolver.openInputStream(uri).use { input ->
                            requireNotNull(input) { "cannot open selected file" }
                            destination.outputStream().use { output -> input.copyTo(output) }
                        }
                        copiedFiles.add(destination)

                        tempFiles.put(JSONObject().apply {
                            put("name", metadata.name)
                            put("path", PathUtils.pathToVirtual(destination))
                            put("size", destination.length())
                            put("time", metadata.timeSeconds)
                            put("type", ChooseMessageFileContract.classify(metadata.mimeType, metadata.name))
                        })
                    }
                    require(tempFiles.length() > 0) { "no supported file selected" }
                    tempFiles
                }

                withContext(Dispatchers.Main) {
                    outcome.fold(
                        onSuccess = { tempFiles -> completeMessageFileSuccess(params, responseCallback, tempFiles) },
                        onFailure = { error ->
                            copiedFiles.forEach(File::delete)
                            completeMessageFileFailure(
                                params,
                                responseCallback,
                                error.message ?: "cannot read selected file",
                            )
                        },
                    )
                }
            }
        }

        if (!launched) {
            return completeMessageFileFailure(params, responseCallback, "picker is busy")
        }
        return NoneResult()
    }

    private data class MessageFileMetadata(
        val name: String,
        val mimeType: String?,
        val timeSeconds: Long,
    )

    private fun queryMessageFileMetadata(activity: DiminaActivity, uri: android.net.Uri): MessageFileMetadata {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var lastModifiedMillis = 0L
        activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { index ->
                    name = cursor.getString(index) ?: name
                }
                cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED).takeIf { it >= 0 }?.let { index ->
                    lastModifiedMillis = cursor.getLong(index)
                }
            }
        }
        val timeSeconds = if (lastModifiedMillis > 0) {
            lastModifiedMillis / 1000
        } else {
            System.currentTimeMillis() / 1000
        }
        return MessageFileMetadata(name, activity.contentResolver.getType(uri), timeSeconds)
    }

    private fun completeMessageFileSuccess(
        params: JSONObject,
        responseCallback: (String) -> Unit,
        tempFiles: JSONArray,
    ): NoneResult {
        val result = JSONObject().apply {
            put("tempFiles", tempFiles)
            put("errMsg", "$CHOOSE_MESSAGE_FILE:ok")
        }
        ApiUtils.invokeSuccess(params, result, responseCallback)
        ApiUtils.invokeComplete(params, responseCallback, result)
        return NoneResult()
    }

    private fun completeMessageFileFailure(
        params: JSONObject,
        responseCallback: (String) -> Unit,
        message: String,
    ): NoneResult {
        val result = JSONObject().apply {
            put("errMsg", "$CHOOSE_MESSAGE_FILE:fail $message")
        }
        ApiUtils.invokeFail(params, result, responseCallback)
        ApiUtils.invokeComplete(params, responseCallback, result)
        return NoneResult()
    }


    private fun saveCanvasTempFile(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        fun failure(reason: String) = canvasTempFileFailure(reason)

        val dataURL = params.optString("dataURL")
        if (dataURL.isEmpty()) return failure("dataURL is required")
        val fileType = params.optString("fileType", "png")
        if (fileType != "png" && fileType != "jpg") return failure("invalid file type")
        if (!isValidCanvasAppId(appId)) return failure("invalid appId")

        val prefix = Regex("^data:image/(png|jpeg|jpg);base64,").find(dataURL)
        if (dataURL.startsWith("data:") && prefix == null) return failure("invalid dataURL")
        val declaredType = prefix?.groupValues?.get(1)
        if (declaredType != null && declaredType != fileType && !(declaredType == "jpeg" && fileType == "jpg")) {
            return failure("file type mismatch")
        }
        val base64Data = prefix?.let { dataURL.substring(it.range.last + 1) } ?: dataURL
        if (base64Data.isEmpty() || base64Data.length > MAX_CANVAS_BASE64_CHARS
            || base64Data.length % 4 != 0 || !STRICT_BASE64.matches(base64Data)) {
            return failure(if (base64Data.length > MAX_CANVAS_BASE64_CHARS) "data too large" else "base64 decode failed")
        }

        // 解码最多 32 MB 的 base64 再落盘是这条链上唯一的重活，而 handleAction 跑在主线程上
        // （JsCore 把 QuickJS 的每次 evaluate 都 post 到主 Looper），同步做会卡住画面。
        // 参数校验很便宜，留在调用线程上以保持同步失败语义。
        val context = activity.applicationContext
        canvasIoScope.launch {
            // appTempRoot 自己也做 canonicalFile 与 createDirectories，并且会对符号链接抛错。
            // 它必须留在这个 try 里：抛出去就没有人再发 complete，小程序会永远等下去。
            val result = try {
                CanvasExportQueue.serialized(appId) {
                    writeCanvasTempFile(PathUtils.appTempRoot(context, appId), base64Data, fileType)
                }
            } catch (_: Exception) {
                canvasTempFileFailure("write failed").value
            }
            // responseCallback 会一路回到 QuickJS，而 QuickJS 只在主线程上执行。
            withContext(Dispatchers.Main) {
                dispatchCanvasResult(params, result, responseCallback)
            }
        }
        return NoneResult()
    }

    /**
     * Decodes the canvas data URL payload and publishes it into the app temp directory. Returns the
     * same result shape the synchronous validation failures use, so both paths reach the mini
     * program identically.
     */
    internal fun writeCanvasTempFile(tempRoot: File, base64Data: String, fileType: String): JSONObject {
        val imageBytes = try {
            Base64.getDecoder().decode(base64Data)
        } catch (_: IllegalArgumentException) {
            return canvasTempFileFailure("base64 decode failed").value
        }
        if (imageBytes.isEmpty() || imageBytes.size > MAX_CANVAS_IMAGE_BYTES || !matchesImageType(imageBytes, fileType)) {
            return canvasTempFileFailure(
                if (imageBytes.size > MAX_CANVAS_IMAGE_BYTES) "data too large" else "invalid image data"
            ).value
        }

        var cleanupFile: File? = null
        return try {
            val stagingFile = File.createTempFile(".canvas_", ".tmp", tempRoot)
            cleanupFile = stagingFile
            stagingFile.outputStream().use { it.write(imageBytes) }
            val publishedFile = File(tempRoot, "canvas_${UUID.randomUUID()}.$fileType")
            Files.move(stagingFile.toPath(), publishedFile.toPath(), StandardCopyOption.ATOMIC_MOVE)
            cleanupFile = publishedFile
            canvasTempFileSuccess(PathUtils.pathToVirtual(publishedFile)).value
        } catch (_: Exception) {
            cleanupFile?.delete()
            canvasTempFileFailure("write failed").value
        }
    }


    internal fun isValidCanvasAppId(appId: String): Boolean =
        SAFE_APP_ID.matches(appId) && appId != "." && appId != ".."

    internal fun matchesImageType(bytes: ByteArray, fileType: String): Boolean = when (fileType) {
        "png" -> bytes.size >= 8 && bytes.copyOfRange(0, 8).contentEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        )
        "jpg" -> bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte()
        else -> false
    }
}
