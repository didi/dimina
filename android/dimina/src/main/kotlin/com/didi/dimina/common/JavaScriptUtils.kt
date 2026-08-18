package com.didi.dimina.common

import org.json.JSONObject

internal object JavaScriptUtils {
    private val functionNamePattern = Regex("^[A-Za-z_$][A-Za-z0-9_$]*(\\.[A-Za-z_$][A-Za-z0-9_$]*)*$")

    fun message(type: String, body: Map<String, String>): String =
        JSONObject().apply {
            put("type", type)
            put("body", JSONObject(body))
        }.toString()

    fun invokeWithJson(functionName: String, json: String): String {
        require(functionNamePattern.matches(functionName)) { "Invalid JavaScript function name" }
        // Pass the payload as a quoted string and parse it inside JavaScript.
        // JSONObject.quote handles quotes, slashes and line terminators, so data
        // can never terminate the argument and become executable source.
        return "$functionName(JSON.parse(${JSONObject.quote(json)}))"
    }
}
