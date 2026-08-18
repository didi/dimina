package com.didi.dimina.api.network

import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

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

    @Test
    fun uploadFormDataReadsTheFormDataFieldInsteadOfTheMultipartName() {
        val params = JSONObject()
            .put("name", "photo")
            .put("formData", JSONObject().put("user", "alice"))

        assertEquals("alice", NetworkApi.uploadFormData(params)?.getString("user"))
    }

    @Test
    fun uploadMultipartUsesTheCallerProvidedNameAndIncludesFormData() {
        val file = File.createTempFile("dimina-upload", ".txt").apply { writeText("payload") }
        try {
            val body = NetworkApi.buildUploadMultipartBody(
                file,
                name = "photo",
                formData = JSONObject().put("user", "alice"),
                mimeType = "text/plain",
            )
            val buffer = Buffer()
            body.writeTo(buffer)
            val encoded = buffer.readUtf8()

            assertTrue(encoded.contains("name=\"photo\""))
            assertTrue(encoded.contains("name=\"user\""))
            assertTrue(encoded.contains("alice"))
            assertFalse(encoded.contains("name=\"file\""))
        } finally {
            file.delete()
        }
    }

    @Test
    fun uploadProgressUsesTheOfficialByteFieldsAndClampsPercentage() {
        val progress = NetworkApi.uploadProgress(totalBytes = 10, sentBytes = 12)

        assertEquals(100, progress.getInt("progress"))
        assertEquals(12L, progress.getLong("totalBytesSent"))
        assertEquals(10L, progress.getLong("totalBytesExpectedToSend"))
    }
}
