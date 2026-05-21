package com.didi.dimina.core

import android.content.Context
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.VersionUtils
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

object RemoteUpdateManager {
    private const val TAG = "RemoteUpdateManager"
    private const val EVENT_NO_UPDATE = "noupdate"
    private const val EVENT_UPDATING = "updating"
    private const val EVENT_UPDATE_READY = "updateready"
    private const val EVENT_UPDATE_FAILED = "updatefail"

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    fun checkForUpdate(
        context: Context,
        miniProgram: MiniProgram,
        notify: (String) -> Unit,
    ) {
        val manifestUrl = miniProgram.updateManifestUrl.trim()
        if (manifestUrl.isEmpty()) {
            notify(EVENT_NO_UPDATE)
            return
        }

        var updateAnnounced = false
        try {
            val manifest = fetchManifest(manifestUrl)
            if (manifest.appId != miniProgram.appId) {
                throw IOException("manifest appId ${manifest.appId} does not match ${miniProgram.appId}")
            }

            val currentVersion = VersionUtils.getAppVersion(miniProgram.appId)
            if (manifest.versionCode <= currentVersion) {
                notify(EVENT_NO_UPDATE)
                return
            }

            updateAnnounced = true
            notify(EVENT_UPDATING)

            val zipFile = downloadPackage(context, manifest)
            if (!manifest.sha256.isNullOrBlank()) {
                verifySha256(zipFile, manifest.sha256)
            }

            installPackage(context, manifest, zipFile)
            VersionUtils.setAppVersion(manifest.appId, manifest.versionCode)
            notify(EVENT_UPDATE_READY)
        } catch (e: Exception) {
            LogUtils.e(TAG, "Remote update failed: ${e.message}")
            notify(if (updateAnnounced) EVENT_UPDATE_FAILED else EVENT_NO_UPDATE)
        }
    }

    private fun fetchManifest(manifestUrl: String): RemoteUpdateManifest {
        val request = Request.Builder().url(manifestUrl).get().build()
        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("manifest request failed: HTTP ${response.code}")
            }
            val body = response.body?.string().orEmpty()
            val json = JSONObject(body)
            val payload = json.optJSONObject("data") ?: json
            return RemoteUpdateManifest.fromJson(payload)
        }
    }

    private fun downloadPackage(context: Context, manifest: RemoteUpdateManifest): File {
        val updateDir = File(context.cacheDir, "dimina-updates").apply { mkdirs() }
        val targetFile = File(updateDir, "${manifest.appId}-${manifest.versionCode}.zip")
        val request = Request.Builder().url(manifest.packageUrl).get().build()

        httpClient.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("package download failed: HTTP ${response.code}")
            }
            val body = response.body ?: throw IOException("package response body is empty")
            FileOutputStream(targetFile).use { output ->
                body.byteStream().use { input ->
                    input.copyTo(output)
                }
            }
        }

        return targetFile
    }

    private fun installPackage(context: Context, manifest: RemoteUpdateManifest, zipFile: File) {
        val jsAppRoot = File(context.filesDir, "jsapp").apply { mkdirs() }
        val stagingDir = File(jsAppRoot, ".remote/${manifest.appId}-${manifest.versionCode}")
        val targetDir = File(jsAppRoot, manifest.appId)
        val backupDir = File(jsAppRoot, ".backup/${manifest.appId}-${System.currentTimeMillis()}")

        try {
            stagingDir.deleteRecursively()
            unzipFile(zipFile, stagingDir)
            writeConfig(manifest, File(stagingDir, "config.json"))
            validatePackage(stagingDir)

            backupDir.parentFile?.mkdirs()
            try {
                if (targetDir.exists()) {
                    Files.move(
                        targetDir.toPath(),
                        backupDir.toPath(),
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                }
                Files.move(
                    stagingDir.toPath(),
                    targetDir.toPath(),
                    StandardCopyOption.REPLACE_EXISTING,
                )
                backupDir.deleteRecursively()
            } catch (e: Exception) {
                if (!targetDir.exists() && backupDir.exists()) {
                    Files.move(
                        backupDir.toPath(),
                        targetDir.toPath(),
                        StandardCopyOption.REPLACE_EXISTING,
                    )
                }
                throw e
            }
        } finally {
            stagingDir.deleteRecursively()
            zipFile.delete()
        }
    }

    private fun unzipFile(zipFile: File, targetDir: File) {
        targetDir.mkdirs()
        val targetCanonical = targetDir.canonicalFile
        ZipInputStream(zipFile.inputStream()).use { zipInputStream ->
            var entry = zipInputStream.nextEntry
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)

            while (entry != null) {
                val outputFile = File(targetDir, entry.name).canonicalFile
                if (!outputFile.path.startsWith(targetCanonical.path + File.separator)) {
                    throw IOException("invalid zip entry path: ${entry.name}")
                }

                if (entry.isDirectory) {
                    outputFile.mkdirs()
                } else {
                    outputFile.parentFile?.mkdirs()
                    FileOutputStream(outputFile).use { output ->
                        var length: Int
                        while (zipInputStream.read(buffer).also { length = it } > 0) {
                            output.write(buffer, 0, length)
                        }
                    }
                }

                zipInputStream.closeEntry()
                entry = zipInputStream.nextEntry
            }
        }
    }

    private fun writeConfig(manifest: RemoteUpdateManifest, configFile: File) {
        configFile.parentFile?.mkdirs()
        configFile.writeText(JSONObject().apply {
            put("appId", manifest.appId)
            put("name", manifest.name)
            put("path", manifest.path)
            put("versionCode", manifest.versionCode)
            put("versionName", manifest.versionName)
        }.toString())
    }

    private fun validatePackage(packageDir: File) {
        val requiredFiles = listOf(
            File(packageDir, "config.json"),
            File(packageDir, "main/app-config.json"),
            File(packageDir, "main/logic.js"),
        )

        val missingFile = requiredFiles.firstOrNull { !it.isFile }
        if (missingFile != null) {
            throw IOException("package missing required file: ${missingFile.relativeTo(packageDir).path}")
        }
    }

    private fun verifySha256(file: File, expectedSha256: String) {
        val actualSha256 = sha256(file)
        if (!actualSha256.equals(expectedSha256.lowercase(Locale.US), ignoreCase = true)) {
            throw IOException("package sha256 mismatch")
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var length: Int
            while (input.read(buffer).also { length = it } > 0) {
                digest.update(buffer, 0, length)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private data class RemoteUpdateManifest(
        val appId: String,
        val name: String,
        val path: String,
        val versionCode: Int,
        val versionName: String,
        val packageUrl: String,
        val sha256: String?,
    ) {
        companion object {
            fun fromJson(json: JSONObject): RemoteUpdateManifest {
                val packageUrl = json.optString("packageUrl")
                    .ifBlank { json.optString("downloadUrl") }
                    .ifBlank { json.optString("url") }

                if (packageUrl.isBlank()) {
                    throw IOException("manifest missing packageUrl")
                }

                return RemoteUpdateManifest(
                    appId = json.getString("appId"),
                    name = json.optString("name"),
                    path = json.getString("path"),
                    versionCode = json.getInt("versionCode"),
                    versionName = json.optString("versionName"),
                    packageUrl = packageUrl,
                    sha256 = json.optString("sha256").ifBlank { null },
                )
            }
        }
    }
}
