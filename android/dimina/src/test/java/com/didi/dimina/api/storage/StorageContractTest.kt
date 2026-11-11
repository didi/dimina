package com.didi.dimina.api.storage

import com.didi.dimina.engine.qjs.JSValue
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class StorageContractTest {
    @Test
    fun `missing key fails instead of returning a successful empty record`() {
        val result = StorageApi.storageReadResult(null)
        assertEquals("getStorage:fail data not found", result.getString("errMsg"))
        assertFalse(result.has("data"))
    }

    @Test
    fun `stored false zero empty string and null remain successful values`() {
        listOf(false, 0, "", JSONObject.NULL).forEach { value ->
            val result = StorageApi.storageReadResult(value)
            assertEquals("getStorage:ok", result.getString("errMsg"))
            assertEquals(value, result.get("data"))
        }
    }

    @Test
    fun `synchronous reads distinguish a stored null from a missing key`() {
        assertEquals(JSValue.Type.NULL, StorageApi.storageSyncValue(JSONObject.NULL).type)
        assertEquals(JSValue.Type.STRING, StorageApi.storageSyncValue(null).type)
        assertEquals("", StorageApi.storageSyncValue(null).stringValue)
    }

    @Test
    fun `storage info reports kilobytes and rounds partial kilobytes up`() {
        val result = StorageApi.storageInfoResult(linkedMapOf("stored" to 1025L))
        assertEquals(2L, result.getLong("currentSize"))
        assertEquals(10240, result.getInt("limitSize"))
        assertEquals("stored", result.getJSONArray("keys").getString(0))
        assertEquals(1L, StorageApi.storageInfoResult(emptyMap()).getLong("currentSize"))
    }
}
