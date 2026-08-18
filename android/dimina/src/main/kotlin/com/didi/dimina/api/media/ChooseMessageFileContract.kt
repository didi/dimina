package com.didi.dimina.api.media

internal object ChooseMessageFileContract {
    const val MAX_COUNT = 100
    val supportedTypes = setOf("all", "image", "video", "file")

    private val imageExtensions = setOf(
        "apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
    )
    private val videoExtensions = setOf(
        "3g2", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv",
    )

    fun normalizeExtension(extension: String): String =
        extension.trim().removePrefix(".").lowercase()

    fun extensionOf(name: String): String =
        name.substringAfterLast('.', "").lowercase()

    fun classify(mimeType: String?, name: String): String {
        val normalizedMime = mimeType?.lowercase().orEmpty()
        return when {
            normalizedMime.startsWith("image/") -> "image"
            normalizedMime.startsWith("video/") -> "video"
            extensionOf(name) in imageExtensions -> "image"
            extensionOf(name) in videoExtensions -> "video"
            else -> "file"
        }
    }

    fun accepts(
        requestedType: String,
        extensions: Set<String>,
        mimeType: String?,
        name: String,
    ): Boolean {
        val actualType = classify(mimeType, name)
        if (requestedType != "all" && requestedType != actualType) return false
        return requestedType != "file" || extensions.isEmpty() || extensionOf(name) in extensions
    }
}
