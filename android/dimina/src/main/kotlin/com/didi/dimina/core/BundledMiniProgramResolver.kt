package com.didi.dimina.core

import android.content.Context
import com.didi.dimina.bean.MiniProgram
import org.json.JSONObject

internal data class BundledMiniProgramMetadata(
    val appId: String,
    val name: String,
    val path: String,
    val versionCode: Int,
    val versionName: String,
    val updateManifestUrl: String,
)

/** Resolves only packages shipped under assets/jsapp/<appId>/config.json. */
internal object BundledMiniProgramResolver {
    private val safeAppId = Regex("^[A-Za-z0-9_-]+$")

    fun resolve(
        context: Context,
        appId: String,
        requestedPath: String?,
    ): Result<MiniProgram> = runCatching {
        require(safeAppId.matches(appId)) { "invalid appId" }
        val config = context.assets.open("jsapp/$appId/config.json")
            .bufferedReader()
            .use { it.readText() }
        val metadata = parse(appId, config, requestedPath).getOrThrow()
        MiniProgram(
            appId = metadata.appId,
            name = metadata.name,
            root = true,
            path = metadata.path,
            versionCode = metadata.versionCode,
            versionName = metadata.versionName,
            updateManifestUrl = metadata.updateManifestUrl,
        )
    }

    fun parse(
        requestedAppId: String,
        configJson: String,
        requestedPath: String?,
    ): Result<BundledMiniProgramMetadata> = runCatching {
        require(safeAppId.matches(requestedAppId)) { "invalid appId" }
        val config = JSONObject(configJson)
        val configAppId = config.getString("appId")
        require(configAppId == requestedAppId) { "bundled config appId does not match request" }

        val path = requestedPath?.trim()?.takeIf(String::isNotEmpty)
            ?: config.optString("path").trim()
        require(path.isNotEmpty()) { "target path cannot be resolved" }

        BundledMiniProgramMetadata(
            appId = configAppId,
            name = config.optString("name"),
            path = path,
            versionCode = config.getInt("versionCode"),
            versionName = config.optString("versionName"),
            updateManifestUrl = config.optString("updateManifestUrl"),
        )
    }
}
