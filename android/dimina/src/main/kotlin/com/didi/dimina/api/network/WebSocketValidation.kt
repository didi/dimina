package com.didi.dimina.api.network

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

/**
 * Pure validation helpers mirroring dimina-kit's `normalize.ts`.
 *
 * No Android dependencies on purpose - directly unit-testable on the plain JVM.
 */
object WebSocketValidation {
    /** Default `connectSocket` timeout when the caller omits it or passes <= 0. */
    const val DEFAULT_TIMEOUT_MS = 60000

    /** Max reason length accepted by `closeSocket`, in UTF-8 bytes. */
    const val MAX_REASON_UTF8_BYTES = 123

    /**
     * Request header names the caller is not allowed to set (case-insensitive).
     * Matching headers are silently dropped, not rejected.
     */
    val DISALLOWED_HEADER_NAMES: Set<String> = setOf(
        "connection", "content-length", "host", "referer",
        "sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-key",
        "sec-websocket-protocol", "sec-websocket-version", "upgrade",
    )

    /** Result of a single-field validation: either the normalized value, or a `errMsg` suffix (no `<api>:fail ` prefix). */
    sealed class Result<out T> {
        data class Ok<T>(val value: T) : Result<T>()
        data class Fail(val errMsg: String) : Result<Nothing>()
    }

    /** Normalized `connectSocket` url: original string, lowercase scheme, and computed `Origin` value. */
    data class ValidatedUrl(val url: String, val scheme: String, val origin: String)

    /**
     * Validates the `url` param: must parse, scheme must be `ws`/`wss`, no fragment.
     * Failure errMsg: "invalid url".
     */
    fun validateUrl(rawUrl: Any?): Result<ValidatedUrl> {
        val urlStr = rawUrl as? String
        if (urlStr.isNullOrEmpty()) return Result.Fail("invalid url")

        val uri = try {
            URI(urlStr)
        } catch (_: Exception) {
            return Result.Fail("invalid url")
        }

        val scheme = uri.scheme?.lowercase()
        if (scheme != "ws" && scheme != "wss") return Result.Fail("invalid url")
        if (!uri.fragment.isNullOrEmpty()) return Result.Fail("invalid url")
        if (uri.host.isNullOrEmpty()) return Result.Fail("invalid url")

        val mappedScheme = if (scheme == "wss") "https" else "http"
        val defaultPort = if (mappedScheme == "https") 443 else 80
        val port = uri.port
        val origin = if (port == -1 || port == defaultPort) {
            "$mappedScheme://${uri.host}"
        } else {
            "$mappedScheme://${uri.host}:$port"
        }

        return Result.Ok(ValidatedUrl(urlStr, scheme, origin))
    }

    /**
     * Validates `timeout`: missing -> 60000; non-finite or > 0x7fffffff -> fail "invalid timeout";
     * <= 0 -> silently 60000; else rounded to Int.
     */
    fun validateTimeout(rawTimeout: Any?): Result<Int> {
        if (rawTimeout == null) return Result.Ok(DEFAULT_TIMEOUT_MS)

        val asDouble = coerceToDouble(rawTimeout)
        if (asDouble.isNaN() || asDouble.isInfinite() || asDouble > 0x7fffffff) {
            return Result.Fail("invalid timeout")
        }
        if (asDouble <= 0) return Result.Ok(DEFAULT_TIMEOUT_MS)
        // dimina-kit's normalize.ts uses Math.floor, not round - match it for cross-platform fidelity.
        return Result.Ok(Math.floor(asDouble).toInt())
    }

    /**
     * Validates `protocols`: missing -> empty list; non-array -> fail "protocols must be an array";
     * any non-string/empty-string item -> fail "invalid protocol".
     */
    fun validateProtocols(rawProtocols: Any?): Result<List<String>> {
        if (rawProtocols == null) return Result.Ok(emptyList())
        if (rawProtocols !is JSONArray) return Result.Fail("protocols must be an array")

        val list = mutableListOf<String>()
        for (i in 0 until rawProtocols.length()) {
            val item = rawProtocols.opt(i)
            if (item !is String || item.isEmpty()) return Result.Fail("invalid protocol")
            list.add(item)
        }
        return Result.Ok(list)
    }

    /**
     * Validates `header` and injects `Origin` if absent (case-insensitive check).
     * Missing -> just {Origin}; non-object -> fail "header must be an object";
     * disallowed/blank names dropped silently; CRLF in name or value -> fail "invalid header";
     * null/undefined values dropped; other values stringified.
     */
    fun validateHeader(rawHeader: Any?, origin: String): Result<Map<String, String>> {
        val map = LinkedHashMap<String, String>()

        if (rawHeader != null) {
            if (rawHeader !is JSONObject) return Result.Fail("header must be an object")

            val keys = rawHeader.keys()
            while (keys.hasNext()) {
                val rawName = keys.next()
                val trimmedName = rawName.trim()
                if (trimmedName.isEmpty() || trimmedName.lowercase() in DISALLOWED_HEADER_NAMES) {
                    continue
                }

                val value = rawHeader.opt(rawName)
                if (value == null || value == JSONObject.NULL) continue

                val strValue = value.toString()
                if (containsCrlf(rawName) || containsCrlf(strValue)) {
                    return Result.Fail("invalid header")
                }

                // Store the trimmed name (matching dimina-kit's emitted header), not the raw key -
                // an untrimmed key with stray whitespace can cause the native request builder to
                // reject an otherwise-valid header.
                map[trimmedName] = strValue
            }
        }

        val hasOrigin = map.keys.any { it.equals("origin", ignoreCase = true) }
        if (!hasOrigin) {
            map["Origin"] = origin
        }
        return Result.Ok(map)
    }

    /**
     * Validates `closeSocket`'s `code`: missing -> 1000; non-integer or not(1000 or in [3000,4999]) -> fail "invalid code".
     */
    fun validateCloseCode(rawCode: Any?): Result<Int> {
        if (rawCode == null) return Result.Ok(1000)

        val intValue: Int = when (rawCode) {
            is Int -> rawCode
            is Long -> {
                if (rawCode < Int.MIN_VALUE || rawCode > Int.MAX_VALUE) return Result.Fail("invalid code")
                rawCode.toInt()
            }
            is Double -> {
                if (rawCode.isNaN() || rawCode.isInfinite() || rawCode != Math.floor(rawCode)) {
                    return Result.Fail("invalid code")
                }
                rawCode.toInt()
            }
            is Float -> {
                val d = rawCode.toDouble()
                if (d.isNaN() || d.isInfinite() || d != Math.floor(d)) return Result.Fail("invalid code")
                rawCode.toInt()
            }
            is String -> rawCode.trim().toIntOrNull() ?: return Result.Fail("invalid code")
            else -> return Result.Fail("invalid code")
        }

        return if (intValue == 1000 || intValue in 3000..4999) {
            Result.Ok(intValue)
        } else {
            Result.Fail("invalid code")
        }
    }

    /**
     * Validates `closeSocket`'s `reason`: missing -> ""; non-string -> fail "reason must be a string";
     * > 123 UTF-8 bytes -> fail "reason must not exceed 123 UTF-8 bytes".
     */
    fun validateReason(rawReason: Any?): Result<String> {
        if (rawReason == null) return Result.Ok("")
        if (rawReason !is String) return Result.Fail("reason must be a string")

        val byteLength = rawReason.toByteArray(Charsets.UTF_8).size
        if (byteLength > MAX_REASON_UTF8_BYTES) {
            return Result.Fail("reason must not exceed 123 UTF-8 bytes")
        }
        return Result.Ok(rawReason)
    }

    /** True if [s] contains a bare CR or LF (header injection guard). */
    internal fun containsCrlf(s: String): Boolean {
        return s.contains('\r') || s.contains('\n')
    }

    /** JS-`Number()`-ish coercion used by [validateTimeout]; non-coercible input yields NaN. */
    private fun coerceToDouble(raw: Any): Double {
        return when (raw) {
            is Int -> raw.toDouble()
            is Long -> raw.toDouble()
            is Double -> raw
            is Float -> raw.toDouble()
            is Boolean -> if (raw) 1.0 else 0.0
            is String -> {
                val trimmed = raw.trim()
                if (trimmed.isEmpty()) 0.0 else trimmed.toDoubleOrNull() ?: Double.NaN
            }
            else -> Double.NaN
        }
    }
}
