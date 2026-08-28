package com.didi.dimina.common

import android.content.Context
import android.net.Uri
import android.webkit.MimeTypeMap
import java.io.File
import java.nio.file.Files

/**
 * Author: Doslin
 */
object PathUtils {
    const val WEBVIEW_ASSET_DOMAIN = "appassets.androidplatform.net"
    const val WEBVIEW_BASE_URL = "https://$WEBVIEW_ASSET_DOMAIN"
    const val WEBVIEW_JSAPP_BASE_URL = "$WEBVIEW_BASE_URL/jsapp/"
    const val WEBVIEW_JSSDK_BASE_URL = "$WEBVIEW_BASE_URL/jssdk/"
    const val VIRTUAL_SCHEME = "difile"
    const val VIRTUAL_DOMAIN_URL = "$VIRTUAL_SCHEME://"
    private const val FILE_SYSTEM_DIR = "dimina-file-system"
    private const val USER_DIR = "usr"
    private const val TEMP_DIR = "tmp"

    private fun validatedAppId(appId: String): String {
        require(appId.isNotBlank()) { "appId is required for virtual file access" }
        require(appId != "." && appId != ".." && !appId.contains('/') && !appId.contains('\\') && !appId.contains('\u0000')) {
            "invalid appId"
        }
        return appId
    }

    fun appUserRoot(context: Context, appId: String): File =
        confinedStorageRoot(context.filesDir, validatedAppId(appId), USER_DIR)

    fun appTempRoot(context: Context, appId: String): File =
        confinedStorageRoot(context.cacheDir, validatedAppId(appId), TEMP_DIR)

    internal fun confinedStorageRoot(platformRoot: File, appId: String, leaf: String): File {
        val canonicalPlatformRoot = platformRoot.canonicalFile
        val directories = listOf(
            File(canonicalPlatformRoot, FILE_SYSTEM_DIR),
            File(canonicalPlatformRoot, "$FILE_SYSTEM_DIR/$appId"),
            File(canonicalPlatformRoot, "$FILE_SYSTEM_DIR/$appId/$leaf"),
        )
        directories.forEach { directory ->
            require(!Files.isSymbolicLink(directory.toPath())) { "application storage contains a symbolic link" }
            Files.createDirectories(directory.toPath())
            require(!Files.isSymbolicLink(directory.toPath())) { "application storage contains a symbolic link" }
            val canonicalDirectory = directory.canonicalFile
            require(canonicalDirectory.path.startsWith(canonicalPlatformRoot.path + File.separator)) {
                "application storage escapes platform sandbox"
            }
        }
        return directories.last().canonicalFile
    }

    fun appTempFile(context: Context, appId: String, relativePath: String): File =
        confinedFile(appTempRoot(context, appId), relativePath)

    private fun confinedFile(root: File, relativePath: String): File {
        val canonicalRoot = root.canonicalFile
        val candidate = File(canonicalRoot, relativePath).canonicalFile
        require(candidate.path == canonicalRoot.path || candidate.path.startsWith(canonicalRoot.path + File.separator)) {
            "path escapes application storage"
        }
        return candidate
    }

    fun isLegalPath(path: String): Boolean {
        return path.startsWith(VIRTUAL_DOMAIN_URL)
    }

    fun pathToReal(context: Context, path: String): String {
        return pathToReal(context, path, "")
    }

    fun pathToReal(context: Context, path: String, appId: String): String {
        if (!isLegalPath(path) && appId.isEmpty()) return path

        val userRoot = appUserRoot(context, appId)
        val tempRoot = appTempRoot(context, appId)
        val target = if (isLegalPath(path)) {
            val relative = path.substring(VIRTUAL_DOMAIN_URL.length).trimStart('/')
            when {
                relative == USER_DIR -> userRoot
                relative.startsWith("$USER_DIR/") -> confinedFile(userRoot, relative.removePrefix("$USER_DIR/"))
                relative == TEMP_DIR -> tempRoot
                relative.startsWith("$TEMP_DIR/") -> confinedFile(tempRoot, relative.removePrefix("$TEMP_DIR/"))
                else -> confinedFile(tempRoot, relative)
            }
        } else {
            File(path).canonicalFile
        }

        val canonical = target.canonicalFile
        val allowedRoots = listOf(userRoot.canonicalFile, tempRoot.canonicalFile)
        require(allowedRoots.any { canonical.path == it.path || canonical.path.startsWith(it.path + File.separator) }) {
            "path is outside application storage"
        }
        return canonical.path
    }

    /**
     * Resolves a local media source owned by one mini program. In addition to
     * difile user/temp files, packaged resources are allowed; raw file paths
     * are accepted only when their canonical target remains under one of
     * those three roots.
     */
    fun pathToAppResource(context: Context, path: String, appId: String): String {
        val safeAppId = validatedAppId(appId)
        if (isLegalPath(path)) {
            return pathToReal(context, path, safeAppId)
        }

        val parsed = Uri.parse(path)
        val scheme = parsed.scheme?.lowercase()
        require(scheme == null || scheme == "file") { "unsupported local file scheme" }
        if (scheme == "file") {
            require(parsed.host.isNullOrEmpty()) { "remote file URI is not allowed" }
        }
        val rawPath = if (scheme == "file") {
            requireNotNull(parsed.path) { "invalid file URI" }
        } else {
            path
        }

        val packageRoot = File(context.filesDir, "jsapp/$safeAppId").canonicalFile
        val userRoot = appUserRoot(context, safeAppId).canonicalFile
        val tempRoot = appTempRoot(context, safeAppId).canonicalFile
        val appPathPrefix = "/$safeAppId/"
        val packageRelativePath = when {
            rawPath.startsWith(appPathPrefix) -> rawPath.removePrefix(appPathPrefix)
            !rawPath.startsWith('/') -> rawPath
            else -> null
        }
        val target = if (packageRelativePath != null) {
            require(!packageRelativePath.contains('\\') && !packageRelativePath.contains('\u0000')) {
                "invalid package path"
            }
            require(packageRelativePath.split('/').none { it == ".." }) { "invalid package path" }
            val direct = confinedFile(packageRoot, packageRelativePath)
            if (direct.exists()) direct else confinedFile(packageRoot, "main/$packageRelativePath")
        } else {
            File(rawPath).canonicalFile
        }
        val canonical = target.canonicalFile
        val allowedRoots = listOf(packageRoot, userRoot, tempRoot)
        require(allowedRoots.any { canonical.path == it.path || canonical.path.startsWith(it.path + File.separator) }) {
            "path is outside mini program storage"
        }
        return canonical.path
    }

    fun pathToVirtual(file: File): String {
        return "$VIRTUAL_DOMAIN_URL${file.name}"
    }

    fun uriToTempFile(context: Context, uri: Uri, appId: String): String? {
        return try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null
            val mimeType = context.contentResolver.getType(uri)
            val extension = mimeType?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
                ?: MimeTypeMap.getFileExtensionFromUrl(uri.toString()).takeIf { it.isNotBlank() }
                ?: "tmp"
            val file = File.createTempFile("MEDIA_${System.currentTimeMillis()}", ".$extension", appTempRoot(context, appId))
            inputStream.use { input ->
                file.outputStream().use { output -> input.copyTo(output) }
            }
            pathToVirtual(file)
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
