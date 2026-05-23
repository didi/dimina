package com.didi.dimina.api.network

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkApiTest {
    @Test
    fun parseResponseDataParsesJsonArrayWhenDataTypeIsJson() {
        val data = NetworkApi.parseResponseData(
            """[{"id":"0"},{"id":"1"}]""",
            dataType = "json",
            responseType = "text",
        )

        assertTrue(data is JSONArray)
        assertEquals("0", (data as JSONArray).getJSONObject(0).getString("id"))
    }

    @Test
    fun parseResponseDataParsesJsonObjectWhenDataTypeIsJson() {
        val data = NetworkApi.parseResponseData(
            """{"ok":true}""",
            dataType = "json",
            responseType = "text",
        )

        assertTrue(data is JSONObject)
        assertEquals(true, (data as JSONObject).getBoolean("ok"))
    }

    @Test
    fun parseResponseDataFallsBackToTextForInvalidJson() {
        val data = NetworkApi.parseResponseData(
            "not-json",
            dataType = "json",
            responseType = "text",
        )

        assertEquals("not-json", data)
    }
}
