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

    /** Normalized `connectSocket` url: original string and lowercase scheme. */
    data class ValidatedUrl(val url: String, val scheme: String)

    /**
     * Validates the `url` param: must parse, scheme must be `wss`, no fragment.
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
        if (scheme != "wss") return Result.Fail("invalid url")
        // rawFragment 而不是 fragment.isNullOrEmpty()：`wss://host/#` 解析出来的是空字符串
        // 而不是 null，用后者会把带空 fragment 的地址放过去，iOS 和 HarmonyOS 都是拒绝的。
        if (uri.rawFragment != null) return Result.Fail("invalid url")
        if (uri.host.isNullOrEmpty()) return Result.Fail("invalid url")

        return Result.Ok(ValidatedUrl(urlStr, scheme))
    }

    /**
     * Validates `timeout`: missing -> 60000; non-finite or > 0x7fffffff -> fail "invalid timeout";
     * <= 0 -> silently 60000; else rounded to Int.
     */
    fun validateTimeout(rawTimeout: Any?): Result<Int> {
        if (rawTimeout == null) return Result.Ok(DEFAULT_TIMEOUT_MS)

        if (rawTimeout !is Number) return Result.Fail("invalid timeout")
        val asDouble = rawTimeout.toDouble()
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
     * Validates `header`. Missing -> empty map; non-object -> fail "header must be an object";
     * disallowed/blank names dropped silently; CRLF in name or value, a name that is not an RFC
     * token, or a control character in a value -> fail "invalid header";
     * null/undefined values dropped; other values stringified.
     */
    fun validateHeader(rawHeader: Any?): Result<Map<String, String>> {
        val map = LinkedHashMap<String, String>()

        if (rawHeader != null) {
            if (rawHeader !is JSONObject) return Result.Fail("header must be an object")

            val keys = rawHeader.keys()
            while (keys.hasNext()) {
                val rawName = keys.next()
                // CRLF 必须在 trim、禁用名和空值这些 continue 之前查。放在后面的话，
                // "Host\r\n" 会因为 trim 后命中禁用名而被静默丢掉，"X-Test\r\n" 配空值
                // 也会被丢掉，注入的换行反而不报错——HarmonyOS 就是先查的，三端得一致。
                if (containsCrlf(rawName)) {
                    return Result.Fail("invalid header")
                }

                val trimmedName = rawName.trim()
                if (trimmedName.isEmpty() || trimmedName.lowercase() in DISALLOWED_HEADER_NAMES) {
                    continue
                }
                // 只查 CRLF 挡不住 "Bad:Name" 这类字段名：校验会放行，success 也已经发出去，
                // 之后 OkHttp 的 Request.Builder 才同步抛错，条目就一直停在 CONNECTING，
                // 调用方要等连接超时才知道失败。这里按 RFC 的 token 规则直接拒掉。
                if (!HTTP_TOKEN_NAME.matches(trimmedName)) {
                    return Result.Fail("invalid header")
                }

                val value = rawHeader.opt(rawName)
                if (value == null || value == JSONObject.NULL) continue

                val strValue = value.toString()
                if (containsCrlf(strValue) ||
                    containsForbiddenControlChar(strValue) ||
                    containsNonAscii(strValue)
                ) {
                    return Result.Fail("invalid header")
                }

                // Store the trimmed name (matching dimina-kit's emitted header), not the raw key -
                // an untrimmed key with stray whitespace can cause the native request builder to
                // reject an otherwise-valid header.
                map[trimmedName] = strValue
            }
        }

        return Result.Ok(map)
    }

    /**
     * The container-supplied `Referer`. WeChat fixes this header and forbids the caller from
     * setting it (`https://servicewechat.com/{appid}/{version}/page-frame.html`); dimina uses its
     * own domain, matching what the `request` path already emits (see HarmonyOS
     * `DMPHttpParamsNext.addCommonHeaderParams`). A caller-supplied `referer` never reaches here -
     * it is in [DISALLOWED_HEADER_NAMES] and gets dropped during header validation.
     *
     * `appVersion` is the mini-app's `versionCode`; `0` when unknown, which is also what WeChat
     * documents for its dev/trial/review builds.
     */
    fun refererValue(appId: String, appVersion: String): String {
        val version = appVersion.ifBlank { "0" }
        return "https://servicedimina.com/$appId/$version/page-frame.html"
    }

    /**
     * Validates `closeSocket`'s `code`. Missing -> 1000. Only host numbers are accepted; the value
     * must be a finite integer that is either 1000 or inside [3000, 4999].
     */
    fun validateCloseCode(rawCode: Any?): Result<Int> {
        if (rawCode == null) return Result.Ok(1000)
        if (rawCode !is Number) return Result.Fail("invalid code")
        val doubleValue = rawCode.toDouble()

        if (doubleValue.isNaN() || doubleValue.isInfinite() || doubleValue != Math.floor(doubleValue)) {
            return Result.Fail("invalid code")
        }
        if (doubleValue < Int.MIN_VALUE.toDouble() || doubleValue > Int.MAX_VALUE.toDouble()) {
            return Result.Fail("invalid code")
        }

        val intValue = doubleValue.toInt()
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

    /**
     * RFC 7230 `token`: the only shape an HTTP field name may take. Anything else (a colon, a
     * space, a quote) is rejected up front rather than left for the platform's request builder to
     * throw on later.
     */
    private val HTTP_TOKEN_NAME = Regex("^[!#\$%&'*+\\-.^_`|~0-9A-Za-z]+\$")

    /**
     * True if [s] contains a control character that is not allowed in an HTTP field value. Values
     * may hold visible characters, space and horizontal tab; CR and LF are caught separately by
     * [containsCrlf] and report the same error.
     */
    internal fun containsForbiddenControlChar(s: String): Boolean {
        return s.any { (it.code < 0x20 && it != '\t') || it.code == 0x7F }
    }

    /**
     * True if [s] holds any character above US-ASCII. RFC 7230 deprecated obs-text (0x80-0xFF) in
     * field values, and the platforms disagree about what to do with such a value - one request
     * builder refuses the header outright while another puts it on the wire - so the same mini
     * program would connect on one device and fail on another.
     *
     * The script layer hands string values through untouched, which makes a non-ASCII value a
     * perfectly reachable input rather than a curiosity, so it is settled here, before the dial:
     * a plain `fail` beats reporting success and then contradicting it with an error event.
     *
     * This applies to header values only. A url may legitimately carry non-ASCII (CJK paths, IDN
     * hosts) and is governed by its own rules.
     */
    internal fun containsNonAscii(s: String): Boolean = s.any { it.code > 0x7F }

}
