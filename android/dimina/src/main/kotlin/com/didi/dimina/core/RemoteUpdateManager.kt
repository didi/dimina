package com.didi.dimina.core

import android.content.Context
import com.didi.dimina.bean.MiniProgram
import com.didi.dimina.common.AtomicZipInstaller
import com.didi.dimina.common.LogUtils
import com.didi.dimina.common.VersionUtils
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

object RemoteUpdateManager {
    private const val TAG = "RemoteUpdateManager"
    private const val EVENT_NO_UPDATE = "noupdate"
    private const val EVENT_UPDATING = "updating"
    private const val EVENT_UPDATE_READY = "updateready"
    private const val EVENT_UPDATE_FAILED = "updatefail"

    private val requiredPackagePaths = listOf(
        "config.json",
        "main/app-config.json",
        "main/logic.js",
    )
    private val appLocks = ConcurrentHashMap<String, ReentrantLock>()
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    fun checkForUpdate(
        context: Context,
        miniProgram: MiniProgram,
        notify: (String) -> Unit,
    ) {
        lockFor(miniProgram.appId).withLock {
            checkForUpdateLocked(context, miniProgram, notify)
        }
    }

    /**
     * Installs the package described by [MiniProgram.updateManifestUrl] directly
     * into the active app directory.
     *
     * This path is only used when no runnable local package exists yet. Unlike
     * the normal update flow, the package must be activated before the service
     * and render runtimes can start.
     */
    @Throws(IOException::class)
    fun installInitialPackage(context: Context, miniProgram: MiniProgram): MiniProgram {
        return lockFor(miniProgram.appId).withLock {
            val manifestUrl = miniProgram.updateManifestUrl.trim()
            if (manifestUrl.isEmpty()) {
                throw IOException(
                    "mini program ${miniProgram.appId} has no local package or updateManifestUrl"
                )
            }

            val manifest = fetchManifest(manifestUrl)
            validateManifestAppId(manifest, miniProgram.appId)

            val zipFile = downloadPackage(context, manifest)
            installActivePackage(context, manifest, zipFile)

            miniProgram.copy(
                name = miniProgram.name.ifBlank { manifest.name },
                path = miniProgram.path ?: manifest.path,
                versionCode = manifest.versionCode,
                versionName = manifest.versionName,
            )
        }
    }

    /**
     * Promotes the downloaded package to the active directory. The current
     * runtime continues to use the old directory until this method is called.
     */
    fun activatePendingUpdate(context: Context, appId: String): Boolean {
        return lockFor(appId).withLock {
            try {
                val pendingPackage = readPendingPackage(context, appId) ?: return@withLock false
                val currentVersion = VersionUtils.getAppVersion(appId)
                if (pendingPackage.versionCode <= currentVersion) {
                    pendingPackage.directory.deleteRecursively()
                    return@withLock false
                }

                val activeDir = appDirectory(jsAppRoot(context), appId)
                AtomicZipInstaller.replaceDirectory(
                    sourceDir = pendingPackage.directory,
                    targetDir = activeDir,
                    onInstalled = {
                        VersionUtils.setAppVersion(appId, pendingPackage.versionCode)
                    },
                )
                true
            } catch (e: Exception) {
                LogUtils.e(TAG, "Failed to activate pending update for $appId: ${e.message}")
                false
            }
        }
    }

    private fun checkForUpdateLocked(
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
            validateManifestAppId(manifest, miniProgram.appId)

            val currentVersion = VersionUtils.getAppVersion(miniProgram.appId)
            if (manifest.versionCode <= currentVersion) {
                deletePendingPackage(context, miniProgram.appId)
                notify(EVENT_NO_UPDATE)
                return
            }

            updateAnnounced = true
            notify(EVENT_UPDATING)

            val pendingPackage = readPendingPackage(context, miniProgram.appId)
            if (pendingPackage != null && pendingPackage.versionCode >= manifest.versionCode) {
                notify(EVENT_UPDATE_READY)
                return
            }

            val zipFile = downloadPackage(context, manifest)
            installPendingPackage(context, manifest, zipFile)
            notify(EVENT_UPDATE_READY)
        } catch (e: Exception) {
            LogUtils.e(TAG, "Remote update failed: ${e.message}")
            notify(if (updateAnnounced) EVENT_UPDATE_FAILED else EVENT_NO_UPDATE)
        }
    }

    private fun installActivePackage(
        context: Context,
        manifest: RemoteUpdateManifest,
        zipFile: File,
    ) {
        try {
            if (!manifest.sha256.isNullOrBlank()) {
                verifySha256(zipFile, manifest.sha256)
            }
            val activeDir = appDirectory(jsAppRoot(context), manifest.appId)
            val installed = AtomicZipInstaller.install(
                inputProvider = { zipFile.inputStream() },
                targetDir = activeDir,
                requiredPaths = requiredPackagePaths,
                afterExtract = { packageDir ->
                    writeConfig(manifest, File(packageDir, "config.json"))
                },
            )
            if (!installed) {
                throw IOException("failed to extract or validate initial package")
            }
            validatePackage(activeDir, manifest.appId)
            VersionUtils.setAppVersion(manifest.appId, manifest.versionCode)
        } finally {
            zipFile.delete()
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

    private fun installPendingPackage(
        context: Context,
        manifest: RemoteUpdateManifest,
        zipFile: File,
    ) {
        val pendingDir = pendingAppDirectory(context, manifest.appId)
        try {
            if (!manifest.sha256.isNullOrBlank()) {
                verifySha256(zipFile, manifest.sha256)
            }
            val installed = AtomicZipInstaller.install(
                inputProvider = { zipFile.inputStream() },
                targetDir = pendingDir,
                requiredPaths = requiredPackagePaths,
                afterExtract = { packageDir ->
                    writeConfig(manifest, File(packageDir, "config.json"))
                },
            )
            if (!installed) {
                throw IOException("failed to extract or validate update package")
            }
            validatePackage(pendingDir, manifest.appId)
        } finally {
            zipFile.delete()
        }
    }

    private fun readPendingPackage(context: Context, appId: String): PendingPackage? {
        val pendingDir = pendingAppDirectory(context, appId)
        if (!pendingDir.exists()) {
            return null
        }

        return try {
            val versionCode = validatePackage(pendingDir, appId)
            PendingPackage(pendingDir, versionCode)
        } catch (e: Exception) {
            LogUtils.e(TAG, "Discarding invalid pending package for $appId: ${e.message}")
            pendingDir.deleteRecursively()
            null
        }
    }

    private fun deletePendingPackage(context: Context, appId: String) {
        try {
            pendingAppDirectory(context, appId).deleteRecursively()
        } catch (e: Exception) {
            LogUtils.e(TAG, "Failed to clean pending package for $appId: ${e.message}")
        }
    }

    private fun validatePackage(packageDir: File, expectedAppId: String): Int {
        val missingPath = requiredPackagePaths.firstOrNull { path ->
            !File(packageDir, path).isFile
        }
        if (missingPath != null) {
            throw IOException("package missing required file: $missingPath")
        }

        val config = JSONObject(File(packageDir, "config.json").readText())
        val appId = config.getString("appId")
        if (appId != expectedAppId) {
            throw IOException("package appId $appId does not match $expectedAppId")
        }
        return config.getInt("versionCode")
    }

    private fun validateManifestAppId(
        manifest: RemoteUpdateManifest,
        expectedAppId: String,
    ) {
        if (manifest.appId != expectedAppId) {
            throw IOException("manifest appId ${manifest.appId} does not match $expectedAppId")
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

    private fun pendingAppDirectory(context: Context, appId: String): File {
        val pendingRoot = File(jsAppRoot(context), ".pending").apply { mkdirs() }
        return appDirectory(pendingRoot, appId)
    }

    private fun jsAppRoot(context: Context): File =
        File(context.filesDir, "jsapp").apply { mkdirs() }

    private fun appDirectory(root: File, appId: String): File {
        val canonicalRoot = root.canonicalFile
        val directory = File(canonicalRoot, appId).canonicalFile
        if (directory.parentFile != canonicalRoot) {
            throw IOException("invalid appId path: $appId")
        }
        return directory
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

    private fun lockFor(appId: String): ReentrantLock =
        appLocks.computeIfAbsent(appId) { ReentrantLock() }

    private data class PendingPackage(
        val directory: File,
        val versionCode: Int,
    )

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
