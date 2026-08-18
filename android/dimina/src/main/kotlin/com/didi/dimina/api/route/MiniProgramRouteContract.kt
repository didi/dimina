package com.didi.dimina.api.route

import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

internal data class NavigateToMiniProgramRequest(
    val appId: String,
    val path: String?,
    val extraData: JSONObject,
    val envVersion: String,
)

/** Pure validation for the app-level navigation APIs. */
internal object MiniProgramRouteContract {
    const val SCENE_OPENED_BY_MINI_PROGRAM = 1037
    const val SCENE_RETURNED_FROM_MINI_PROGRAM = 1038
    const val RELEASE_ENVIRONMENT = "release"

    fun navigateTo(params: JSONObject, currentAppId: String): Result<NavigateToMiniProgramRequest> =
        runCatching {
            require(optionalString(params, "shortLink").isNullOrEmpty()) {
                "shortLink is not supported by bundled packages"
            }
            require(optionalBoolean(params, "noRelaunchIfPathUnchanged") != true) {
                "noRelaunchIfPathUnchanged is not supported by bundled packages"
            }

            val appId = requiredString(params, "appId")
            require(appId != currentAppId) { "target appId must differ from current appId" }

            val envVersion = optionalString(params, "envVersion")
                ?.ifBlank { RELEASE_ENVIRONMENT }
                ?: RELEASE_ENVIRONMENT
            require(envVersion == RELEASE_ENVIRONMENT) {
                "envVersion $envVersion is not available in bundled packages"
            }

            NavigateToMiniProgramRequest(
                appId = appId,
                path = optionalString(params, "path")?.takeIf(String::isNotBlank),
                extraData = extraData(params),
                envVersion = envVersion,
            )
        }

    fun navigateBackExtraData(params: JSONObject): Result<JSONObject> =
        runCatching { extraData(params) }

    fun restartPath(params: JSONObject): Result<String> =
        runCatching { requiredString(params, "path") }

    private fun requiredString(params: JSONObject, key: String): String {
        val value = params.opt(key)
        require(value is String && value.isNotBlank()) { "$key cannot be empty" }
        return value.trim()
    }

    private fun optionalString(params: JSONObject, key: String): String? {
        if (!params.has(key) || params.isNull(key)) return null
        val value = params.opt(key)
        require(value is String) { "$key must be a string" }
        return value.trim()
    }

    private fun optionalBoolean(params: JSONObject, key: String): Boolean? {
        if (!params.has(key) || params.isNull(key)) return null
        val value = params.opt(key)
        require(value is Boolean) { "$key must be a boolean" }
        return value
    }

    private fun extraData(params: JSONObject): JSONObject {
        if (!params.has("extraData") || params.isNull("extraData")) return JSONObject()
        val value = params.opt("extraData")
        require(value is JSONObject) { "extraData must be an object" }
        return JSONObject(value.toString())
    }
}

/** Serializes app-level navigation transactions until their afterComplete action commits. */
internal class MiniProgramOperationGuard {
    private val inProgress = AtomicBoolean(false)

    fun tryBegin(): Boolean = inProgress.compareAndSet(false, true)

    fun end() {
        inProgress.set(false)
    }
}
