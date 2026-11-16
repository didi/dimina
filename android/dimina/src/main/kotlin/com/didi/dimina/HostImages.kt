package com.didi.dimina

import android.content.Context
import android.util.TypedValue
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

/** Explicit host image registry shared by mini programs. No files are copied into their sandboxes. */
object HostImages {
    internal const val RESOURCE_PATH = "__dimina_host_images/"
    private class Entry(val open: (String) -> Pair<String, InputStream>?)
    private val entries = ConcurrentHashMap<String, Entry>()

    @JvmStatic
    fun registerFile(id: String, file: File) {
        requireValidId(id)
        val mime = imageMimeType(file.extension)
        require(file.isFile && file.canRead()) { "Image file is not readable" }
        entries[id] = Entry { relative -> if (relative.isEmpty()) mime to file.inputStream() else null }
    }

    @JvmStatic
    fun registerAsset(id: String, context: Context, assetPath: String) {
        requireValidId(id)
        val mime = imageMimeType(assetPath.substringAfterLast('.', ""))
        val assets = context.applicationContext.assets
        assets.open(assetPath).use { }
        entries[id] = Entry { relative -> if (relative.isEmpty()) mime to assets.open(assetPath) else null }
    }

    /** Encoded drawable/raw images; Android vector XML is not a browser image format. */
    @JvmStatic
    fun registerResource(id: String, context: Context, resourceId: Int) {
        requireValidId(id)
        val resources = context.applicationContext.resources
        val value = TypedValue()
        resources.openRawResource(resourceId, value).use { }
        val mime = imageMimeType(value.string.toString().substringAfterLast('.', ""))
        entries[id] = Entry { relative -> if (relative.isEmpty()) mime to resources.openRawResource(resourceId) else null }
    }

    @JvmStatic
    fun registerAssetDirectory(id: String, context: Context, assetDirectory: String) {
        requireValidId(id)
        val root = assetDirectory.trimEnd('/')
        require(validRelativePath(root)) { "Invalid asset directory" }
        val assets = context.applicationContext.assets
        require(!assets.list(root).isNullOrEmpty()) { "Image asset directory is missing or empty" }
        entries[id] = Entry { relative ->
            if (relative.isEmpty()) null
            else imageMimeType(relative.substringAfterLast('.', "")) to assets.open("$root/$relative")
        }
    }

    @JvmStatic
    fun registerDirectory(id: String, directory: File) {
        requireValidId(id)
        val root = directory.canonicalFile
        require(root.isDirectory && root.canRead()) { "Image directory is not readable" }
        entries[id] = Entry { relative ->
            val file = File(root, relative).canonicalFile
            require(file.path.startsWith(root.path.trimEnd(File.separatorChar) + File.separator)) { "Image is outside registered directory" }
            if (relative.isEmpty() || !file.isFile) null
            else imageMimeType(file.extension) to file.inputStream()
        }
    }

    @JvmStatic
    fun unregister(id: String) { entries.remove(id) }

    internal fun open(key: String): Pair<String, InputStream>? {
        val id = key.substringBefore('/')
        if (!Regex("^[A-Za-z0-9_-]{1,128}$").matches(id)) return null
        val relative = key.substringAfter('/', "")
        if (key.contains('/') && !validRelativePath(relative)) return null
        return entries[id]?.open?.invoke(relative)
    }

    internal fun response(key: String): WebResourceResponse {
        try {
            val resource = open(key)
            if (resource != null) return WebResourceResponse(resource.first, null, resource.second)
        } catch (_: Exception) { /* Missing, invalid or unreadable host resources fail locally. */ }
        return WebResourceResponse("text/plain", "UTF-8", 404, "Image Not Found", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    }

    private fun requireValidId(id: String) {
        require(Regex("^[A-Za-z0-9_-]{1,128}$").matches(id)) { "Invalid host image ID" }
    }

    private fun validRelativePath(path: String): Boolean = path.split('/').all { part ->
        part.isNotEmpty() && part != "." && part != ".." && part.none { it == '\\' || it == '%' || it == '?' || it == '#' || it.code < 32 || it.code == 127 }
    }

    internal fun imageMimeType(extension: String): String = when (extension.lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        "gif" -> "image/gif"
        "bmp" -> "image/bmp"
        "ico" -> "image/x-icon"
        "avif" -> "image/avif"
        else -> throw IllegalArgumentException("Unsupported host image format")
    }
}
