package com.didi.dimina.ui.view

import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.didi.dimina.common.PathUtils
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.IOException

internal const val LOCAL_MEDIA_PATH = "/__dimina_media"
internal const val LOCAL_MEDIA_URL = PathUtils.WEBVIEW_BASE_URL + LOCAL_MEDIA_PATH

internal fun loadLocalMedia(context: Context, appId: String, request: WebResourceRequest): WebResourceResponse {
    val source = request.url.getQueryParameter("source")
    if (source.isNullOrEmpty() || request.isForMainFrame) return missingMedia()

    return try {
        val file = File(PathUtils.pathToAppResource(context, source, appId))
        if (!file.isFile) return missingMedia()
        val mimeType = resolveWebResourceMimeType(file.extension)
        val size = file.length()
        val rangeHeader = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
        val range = rangeHeader?.let { parseMediaRange(it, size) }
        if (rangeHeader != null && range == null) {
            return WebResourceResponse(
                mimeType, null, 416, "Range Not Satisfiable",
                mapOf("Content-Range" to "bytes */$size"), null
            )
        }
        val headers = mutableMapOf("Accept-Ranges" to "bytes")
        if (range == null) {
            headers["Content-Length"] = size.toString()
            WebResourceResponse(mimeType, null, 200, "OK", headers, file.inputStream())
        } else {
            val count = range.last - range.first + 1
            headers["Content-Length"] = count.toString()
            headers["Content-Range"] = "bytes ${range.first}-${range.last}/$size"
            WebResourceResponse(mimeType, null, 206, "Partial Content", headers, MediaRangeStream(file, range.first, count))
        }
    } catch (_: IllegalArgumentException) {
        missingMedia()
    } catch (_: IOException) {
        missingMedia()
    }
}

private fun missingMedia() =
    WebResourceResponse("text/plain", null, 404, "Not Found", emptyMap(), null)

internal fun parseMediaRange(header: String, size: Long): LongRange? {
    if (!header.startsWith("bytes=", ignoreCase = true) || size == 0L) return null
    val bounds = header.substring(6).trim().split('-')
    if (bounds.size != 2) return null
    if (bounds[0].isEmpty()) {
        val count = bounds[1].toLongOrNull()?.takeIf { it > 0 } ?: return null
        return (size - minOf(count, size)) until size
    }
    val start = bounds[0].toLongOrNull()?.takeIf { it in 0 until size } ?: return null
    if (bounds[1].isEmpty()) return start until size
    val end = bounds[1].toLongOrNull()?.takeIf { it >= start } ?: return null
    return start..minOf(end, size - 1)
}

private class MediaRangeStream(file: File, start: Long, private var remaining: Long) : InputStream() {
    private val stream = FileInputStream(file)

    init {
        try {
            stream.channel.position(start)
        } catch (error: IOException) {
            stream.close()
            throw error
        }
    }

    override fun read(): Int {
        if (remaining == 0L) return -1
        val byte = stream.read()
        if (byte >= 0) remaining--
        return byte
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return -1
        val count = stream.read(buffer, offset, minOf(remaining, length.toLong()).toInt())
        if (count > 0) remaining -= count
        return count
    }

    override fun close() = stream.close()
}
