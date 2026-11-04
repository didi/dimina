package com.didi.dimina

import android.content.Context
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/** Host-owned font files. Registration makes a resource available, but does not activate it. */
object HostFonts {
    internal const val RESOURCE_PATH = "__dimina_host_fonts/"
    private data class Entry(val mimeType: String, val open: () -> InputStream)
    private val entries = ConcurrentHashMap<String, Entry>()

    @JvmStatic
    fun registerFile(id: String, file: File) {
        requireValidId(id)
        require(file.isFile && file.canRead()) { "Font file is not readable" }
        val mime = fontMimeType(file.extension)
        entries[id] = Entry(mime) { file.inputStream() }
    }

    @JvmStatic
    fun registerAsset(id: String, context: Context, assetPath: String) {
        requireValidId(id)
        val mime = fontMimeType(assetPath.substringAfterLast('.', ""))
        val assets = context.applicationContext.assets
        assets.open(assetPath).use { /* Validate without retaining font bytes. */ }
        entries[id] = Entry(mime) { assets.open(assetPath) }
    }

    @JvmStatic
    fun unregister(id: String) { entries.remove(id) }

    internal fun requireValidId(id: String) {
        require(Regex("^[A-Za-z0-9_-]{1,128}$").matches(id)) { "Invalid host font ID" }
    }

    internal fun fontMimeType(extension: String): String = when (extension.lowercase()) {
        "ttf" -> "font/ttf"
        "otf" -> "font/otf"
        "woff" -> "font/woff"
        "woff2" -> "font/woff2"
        else -> throw IllegalArgumentException("Supported font formats: ttf, otf, woff, woff2")
    }

    internal fun response(id: String): WebResourceResponse {
        try {
            val font = open(id)
            if (font != null) return WebResourceResponse(font.first, null, font.second)
        } catch (_: java.io.IOException) { /* Return a local failure, never a network fallback. */ }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Font Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    }

    internal fun open(id: String): Pair<String, InputStream>? = entries[id]?.let { it.mimeType to it.open() }
}
