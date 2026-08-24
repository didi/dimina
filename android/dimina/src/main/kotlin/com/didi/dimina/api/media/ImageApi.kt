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
import com.didi.dimina.common.MediaFileUtils
import com.didi.dimina.ui.container.DiminaActivity
import com.didi.dimina.ui.container.ImagePreviewActivity
import com.didi.dimina.ui.container.MediaPreviewActivity
import com.didi.dimina.ui.view.MediaType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
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

// Internal bridge safety ceiling, not a WeChat Canvas API limit. It bounds the
// extra native allocation and temp-file write after the data URL crosses the bridge.
internal const val MAX_CANVAS_IMAGE_BYTES = 32 * 1024 * 1024
internal const val MAX_CANVAS_BASE64_CHARS = (MAX_CANVAS_IMAGE_BYTES * 4 / 3) + 8

// 排队中的每个请求都各自持有一份 base64 副本，单次上限只约束其中一份。允许「一份在写盘、
// 一份在等」，再多就是纯堆积。预算是在把字符串交给后台协程之前判的，被拒的那份随即可回收。
internal const val MAX_IN_FLIGHT_CANVAS_EXPORTS = 2
internal const val MAX_PENDING_CANVAS_BASE64_CHARS =
    MAX_IN_FLIGHT_CANVAS_EXPORTS.toLong() * MAX_CANVAS_BASE64_CHARS

/**
 * 同一个小程序同时只做一次解码加写盘，单次解码上限已经是 32 MB。锁只约束解码与写盘阶段，
 * 排队中的每个请求仍各自持有自己那份 base64 字符串，所以这里同时按 app 记账，把还没轮到的
 * 总量也框住。预留同时绑定发起时的代次，退出途中到达的请求不会被算进新一代。
 */
internal class CanvasExportReservation internal constructor(
    val appId: String,
    val generation: Long,
    val chars: Int,
    internal val mutex: Mutex,
    internal var payload: String?,
) {
    internal var started = false
    internal var cancelled = false
    internal var job: Job? = null
}

internal object CanvasExportQueue {
    private data class AppState(
        var generation: Long = 0,
        val jobs: LinkedHashSet<CanvasExportReservation> = linkedSetOf(),
        // 锁按 appId 唯一，跨代次共用。销毁只取消还没开始的任务，已经进入临界区的旧任务会继续
        // 解码和写盘；锁一旦按代次分片，新 runtime 的任务就会拿到另一把锁，和旧任务并发各占一份位图。
        val mutex: Mutex = Mutex(),
    )

    private val monitor = Any()
    private val states = mutableMapOf<String, AppState>()

    private fun state(appId: String) = states.getOrPut(appId) { AppState() }

    /**
     * [expectedGeneration] 是调用方在请求进入容器那一刻记下的代次。记账和代次比对必须在同一个
     * monitor 里完成：调用线程与推进代次的主线程是并发的，分两次读会让退出途中到达的请求被记成
     * 新一代的，写出来的文件既不会交付也不会被清理，还白占新 runtime 的并发名额。
     */
    fun reserve(
        appId: String,
        chars: Int,
        payload: String? = null,
        expectedGeneration: Long? = null,
    ): CanvasExportReservation? = synchronized(monitor) {
        val state = state(appId)
        if (expectedGeneration != null && state.generation != expectedGeneration) return@synchronized null
        val pendingChars = state.jobs.sumOf { it.chars.toLong() }
        if (state.jobs.size >= MAX_IN_FLIGHT_CANVAS_EXPORTS
            || pendingChars + chars > MAX_PENDING_CANVAS_BASE64_CHARS) return@synchronized null
        CanvasExportReservation(
            appId = appId,
            generation = state.generation,
            chars = chars,
            mutex = state.mutex,
            payload = payload,
        ).also(state.jobs::add)
    }

    fun attach(reservation: CanvasExportReservation, job: Job) = synchronized(monitor) {
        val active = state(reservation.appId).jobs.contains(reservation) && !reservation.cancelled
        if (active) reservation.job = job else job.cancel()
    }

    private fun begin(reservation: CanvasExportReservation): String? = synchronized(monitor) {
        val active = state(reservation.appId).jobs.contains(reservation) && !reservation.cancelled
        if (!active) return@synchronized null
        reservation.started = true
        reservation.payload.also { reservation.payload = null }
    }

    suspend fun <T> run(reservation: CanvasExportReservation, block: suspend (String) -> T): T? =
        reservation.mutex.withLock {
            val payload = begin(reservation) ?: return@withLock null
            block(payload)
        }

    fun finish(reservation: CanvasExportReservation) {
        synchronized(monitor) {
            reservation.payload = null
            state(reservation.appId).jobs.remove(reservation)
        }
    }

    fun invalidate(appId: String) = synchronized(monitor) {
        val state = state(appId)
        state.generation++
        val pending = state.jobs.filterNot { it.started }
        for (reservation in pending) {
            reservation.cancelled = true
            reservation.payload = null
            reservation.job?.cancel()
            state.jobs.remove(reservation)
        }
    }

    fun currentGeneration(appId: String): Long = synchronized(monitor) { state(appId).generation }
    fun isCurrent(appId: String, generation: Long): Boolean = synchronized(monitor) {
        state(appId).generation == generation
    }
    fun pendingChars(appId: String): Long = synchronized(monitor) {
        state(appId).jobs.sumOf { it.chars.toLong() }
    }
}

/**
 * 导出发起时属于某一代 runtime。小程序退出或重启后，回调已经没有接收方，写出去的文件也不会
 * 有任何人来取，所以结算时必须按代次判断，而不是看这个 appId 现在是不是又活着。
 */
internal object CanvasExportGeneration {
    fun current(appId: String): Long = CanvasExportQueue.currentGeneration(appId)

    @androidx.annotation.MainThread
    fun invalidate(appId: String) {
        CanvasExportQueue.invalidate(appId)
    }
}

/**
 * 结算这次导出该不该交给小程序：发起它的那一代 runtime 已经不在时就不该交。
 */
internal fun shouldDeliverCanvasExport(appId: String, generation: Long): Boolean =
    CanvasExportQueue.isCurrent(appId, generation)

/**
 * 丢弃一次没有接收方的导出：已经发布的文件不会有人来取，留着就是永久占用临时目录。
 */
internal fun discardPublishedCanvasFile(tempRoot: File, result: JSONObject) {
    val publishedName = File(result.optString("tempFilePath")).name
    if (publishedName.isEmpty()) return
    // 只按文件名在临时目录里删，虚拟路径不参与拼接：结算路径不该有能被入参左右的目录跳转。
    runCatching { File(tempRoot, publishedName).delete() }
}

/**
 * 把“这一代是否仍存活”与实际回调放在同一个主线程结算点。runtime 销毁也在主线程更新代次，
 * 因而两者只能按先后完整执行，不会再出现后台检查通过、等待切主线程期间 owner 已失效的窗口。
 * dispatcher 作为参数只用于让单元测试确定性地暂停这个结算点；生产始终使用 Main.immediate。
 */
internal suspend fun deliverCanvasExport(
    appId: String,
    generation: Long,
    tempRoot: File?,
    result: JSONObject,
    deliveryDispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
    dispatch: (JSONObject) -> Unit,
): Boolean = withContext(deliveryDispatcher) {
    if (!shouldDeliverCanvasExport(appId, generation)) {
        tempRoot?.let { discardPublishedCanvasFile(it, result) }
        return@withContext false
    }
    dispatch(result)
    true
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
        const val GET_IMAGE_INFO = "getImageInfo"
        const val PREVIEW_MEDIA = "previewMedia"

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
            GET_IMAGE_INFO,
            PREVIEW_MEDIA,
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

            GET_IMAGE_INFO -> getImageInfo(activity, appId, params, responseCallback)

            PREVIEW_MEDIA -> {
                val sources = params.optJSONArray("sources")
                if (sources == null || sources.length() == 0) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_MEDIA:fail sources is required")
                    }, completeCarriesResult = true)
                }
                val items = ArrayList<MediaPreviewActivity.Item>()
                for (index in 0 until sources.length()) {
                    val source = sources.optJSONObject(index) ?: continue
                    val url = source.optString("url")
                    if (url.isBlank()) continue
                    val resolvedUrl = runCatching { resolvePreviewPath(activity, appId, url) }.getOrNull() ?: continue
                    val poster = source.optString("poster").let { value ->
                        runCatching { resolvePreviewPath(activity, appId, value) }.getOrDefault("")
                    }
                    items.add(MediaPreviewActivity.Item(resolvedUrl, source.optString("type", "image"), poster))
                }
                if (items.isEmpty()) {
                    return AsyncResult(JSONObject().apply {
                        put("errMsg", "$PREVIEW_MEDIA:fail invalid sources")
                    }, completeCarriesResult = true)
                }
                MediaPreviewActivity.launch(activity, items, params.optInt("current", 0))
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$PREVIEW_MEDIA:ok")
                }, completeCarriesResult = true)
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

    private fun getImageInfo(
        activity: DiminaActivity,
        appId: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val src = params.optString("src")
        if (src.isBlank()) {
            return AsyncResult(JSONObject().apply {
                put("errMsg", "$GET_IMAGE_INFO:fail src is required")
            }, completeCarriesResult = true)
        }
        activity.lifecycleScope.launch(Dispatchers.IO) {
            val outcome = runCatching {
                val resolved = MediaFileUtils.resolve(activity, appId, src)
                val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(resolved.file.absolutePath, options)
                require(options.outWidth > 0 && options.outHeight > 0) { "unsupported image" }
                val orientation = runCatching {
                    val exif = android.media.ExifInterface(resolved.file.absolutePath)
                    when (exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL)) {
                        android.media.ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> "up-mirrored"
                        android.media.ExifInterface.ORIENTATION_ROTATE_180 -> "down"
                        android.media.ExifInterface.ORIENTATION_FLIP_VERTICAL -> "down-mirrored"
                        android.media.ExifInterface.ORIENTATION_TRANSPOSE -> "left-mirrored"
                        android.media.ExifInterface.ORIENTATION_ROTATE_90 -> "right"
                        android.media.ExifInterface.ORIENTATION_TRANSVERSE -> "right-mirrored"
                        android.media.ExifInterface.ORIENTATION_ROTATE_270 -> "left"
                        else -> "up"
                    }
                }.getOrDefault("up")
                JSONObject().apply {
                    put("width", options.outWidth)
                    put("height", options.outHeight)
                    put("path", resolved.publicPath)
                    put("orientation", orientation)
                    put("type", options.outMimeType?.substringAfter('/') ?: "unknown")
                    put("errMsg", "$GET_IMAGE_INFO:ok")
                }
            }
            withContext(Dispatchers.Main) {
                outcome.fold(
                    onSuccess = { result ->
                        ApiUtils.invokeSuccess(params, result, responseCallback)
                        ApiUtils.invokeComplete(params, responseCallback, result)
                    },
                    onFailure = { error ->
                        val result = JSONObject().apply { put("errMsg", "$GET_IMAGE_INFO:fail ${error.message}") }
                        ApiUtils.invokeFail(params, result, responseCallback)
                        ApiUtils.invokeComplete(params, responseCallback, result)
                    },
                )
            }
        }
        return NoneResult()
    }

    private fun resolvePreviewPath(activity: DiminaActivity, appId: String, source: String): String {
        if (source.isBlank() || source.startsWith("http://") || source.startsWith("https://")) return source
        if (PathUtils.isLegalPath(source)) return PathUtils.pathToReal(activity, source, appId)
        val packageRoot = File(activity.filesDir, "jsapp/$appId").canonicalFile
        val relativePath = source.substringBefore('?').substringBefore('#').trimStart('/').removePrefix("$appId/")
        return listOf(relativePath, "main/$relativePath")
            .map { File(packageRoot, it).canonicalFile }
            .filter { it.path.startsWith(packageRoot.path + File.separator) }
            .firstOrNull(File::isFile)?.absolutePath
            ?: throw IllegalArgumentException("file does not exist")
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

        // 这条调用来自 render 的 WebView JavaBridge 线程（DiminaWebView.invoke → Bridge 的
        // handleApiInvocation 一路没有线程跳转），而代次推进在主线程。发起时属于哪一代必须当场
        // 记下，等校验完这最长 44 MB 的字符串再去读，中途退出的请求就会被当成新一代的。
        val generation = CanvasExportGeneration.current(appId)

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

        // 解码最多 32 MB 的 base64 再落盘是这条链上唯一的重活，放在调用线程上会占住 render 的
        // JavaBridge 线程，后面的 render 消息全部排在它后面。参数校验很便宜，留在调用线程上以
        // 保持同步失败语义。
        val context = activity.applicationContext
        // 排队中的每个请求都各自留着自己那份 base64，等轮到它才释放。预算判在启动协程之前：
        // 到了协程里再拒，这份副本已经被闭包捕获，拒绝就省不下内存了。
        val reservation = CanvasExportQueue.reserve(appId, base64Data.length, base64Data, generation)
        if (reservation == null) {
            // 拒绝已经发生，这里再查一次原因不影响记账，只为了让失败可诊断。
            return if (!CanvasExportQueue.isCurrent(appId, generation)) {
                failure("runtime unavailable")
            } else {
                failure("too many pending exports")
            }
        }
        val exportJob = canvasIoScope.launch {
            // appTempRoot 自己也做 canonicalFile 与 createDirectories，并且会对符号链接抛错。
            // 它必须留在这个 try 里：抛出去就没有人再发 complete，小程序会永远等下去。
            val tempRoot = runCatching { PathUtils.appTempRoot(context, appId) }.getOrNull()
            val result = try {
                CanvasExportQueue.run(reservation) { reservedPayload ->
                    writeCanvasTempFile(requireNotNull(tempRoot), reservedPayload, fileType)
                } ?: return@launch
            } catch (cancellation: CancellationException) {
                // 代次失效会取消排队中的任务。取消不是写盘失败，吞掉它会让协程继续往下派发
                // 一个本不该存在的结果，也会让 invokeOnCompletion 收不到取消。
                throw cancellation
            } catch (_: Exception) {
                canvasTempFileFailure("write failed").value
            }
            deliverCanvasExport(
                appId = appId,
                generation = reservation.generation,
                tempRoot = tempRoot,
                result = result,
            ) { deliveredResult ->
                dispatchCanvasResult(params, deliveredResult, responseCallback)
            }
        }
        CanvasExportQueue.attach(reservation, exportJob)
        exportJob.invokeOnCompletion { CanvasExportQueue.finish(reservation) }
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
