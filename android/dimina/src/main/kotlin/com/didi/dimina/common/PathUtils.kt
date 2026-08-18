package com.didi.dimina.common

import android.content.Context
import android.net.Uri
import java.io.File

/**
 * Author: Doslin
 */
object PathUtils {
    const val WEBVIEW_ASSET_DOMAIN = "appassets.androidplatform.net"
    const val WEBVIEW_BASE_URL = "https://$WEBVIEW_ASSET_DOMAIN"
    const val WEBVIEW_JSAPP_BASE_URL = "$WEBVIEW_BASE_URL/jsapp/"
    const val WEBVIEW_JSSDK_BASE_URL = "$WEBVIEW_BASE_URL/jssdk/"
    private const val VIRTUAL_DOMAIN_URL = "difile://"
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
        File(context.filesDir, "$FILE_SYSTEM_DIR/${validatedAppId(appId)}/$USER_DIR").apply { mkdirs() }

    fun appTempRoot(context: Context, appId: String): File =
        File(context.cacheDir, "$FILE_SYSTEM_DIR/${validatedAppId(appId)}/$TEMP_DIR").apply { mkdirs() }

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

    fun pathToVirtual(file: File): String {
        return "$VIRTUAL_DOMAIN_URL${file.name}"
    }

    fun uriToTempFile(context: Context, uri: Uri, appId: String): String? {
        return try {
            val inputStream = context.contentResolver.openInputStream(uri) ?: return null
            val file = File.createTempFile("IMG_${System.currentTimeMillis()}", ".jpg", appTempRoot(context, appId))
            file.outputStream().use { output ->
                inputStream.copyTo(output)
            }
            pathToVirtual(file)
        } catch (e: Exception) {
            e.printStackTrace()
            null
        }
    }
}
