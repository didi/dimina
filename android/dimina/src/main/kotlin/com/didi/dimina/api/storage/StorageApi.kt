package com.didi.dimina.api.storage

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.AsyncResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.api.SyncResult
import com.didi.dimina.engine.qjs.JSValue
import com.didi.dimina.ui.container.DiminaActivity
import com.tencent.mmkv.MMKV
import org.json.JSONArray
import org.json.JSONObject

/**
 * Storage API implementation
 * Author: Doslin
 *
 * Handles data storage operations like setting, getting, and removing stored data
 */
class StorageApi : BaseApiHandler() {
    companion object {
        private const val SET_STORAGE_SYNC = "setStorageSync"
        private const val GET_STORAGE_SYNC = "getStorageSync"
        private const val REMOVE_STORAGE_SYNC = "removeStorageSync"
        private const val CLEAR_STORAGE_SYNC = "clearStorageSync"
        private const val SET_STORAGE = "setStorage"
        private const val GET_STORAGE = "getStorage"
        private const val REMOVE_STORAGE = "removeStorage"
        private const val CLEAR_STORAGE = "clearStorage"
        private const val GET_STORAGE_INFO_SYNC = "getStorageInfoSync"
        private const val GET_STORAGE_INFO = "getStorageInfo"

        internal fun storageSyncValue(value: Any?): JSValue = when (value) {
            JSONObject.NULL -> JSValue.createNull()
            is String -> JSValue.createString(value)
            is Int -> JSValue.createNumber(value.toDouble())
            is Double -> JSValue.createNumber(value)
            is Float -> JSValue.createNumber(value.toDouble())
            is Long -> JSValue.createNumber(value.toDouble())
            is Boolean -> JSValue.createBoolean(value)
            is JSONArray -> JSValue.createObject(value.toString())
            is JSONObject -> JSValue.createObject(value.toString())
            else -> JSValue.createString("")
        }

        internal fun storageReadResult(value: Any?): JSONObject = JSONObject().apply {
            if (value == null) {
                put("errMsg", "$GET_STORAGE:fail data not found")
            } else {
                put("data", value)
                put("errMsg", "$GET_STORAGE:ok")
            }
        }

        internal fun storageInfoResult(values: Map<String, Int>): JSONObject = JSONObject().apply {
            put("keys", JSONArray(values.keys))
            put("currentSize", (values.values.sumOf { it.toLong() } + 1023) / 1024)
            put("limitSize", 10 * 1024)
        }

        internal fun clearAllStorage(appId: String) {
            MMKV.mmkvWithID(appId).clearAll()
            MMKV.mmkvWithID(StorageRecordCodec.storageId(appId)).clearAll()
        }
    }

    override val apiNames = setOf(
        SET_STORAGE_SYNC,
        GET_STORAGE_SYNC,
        REMOVE_STORAGE_SYNC,
        CLEAR_STORAGE_SYNC,
        SET_STORAGE,
        GET_STORAGE,
        REMOVE_STORAGE,
        CLEAR_STORAGE,
        GET_STORAGE_INFO_SYNC,
        GET_STORAGE_INFO
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val legacyStorage = MMKV.mmkvWithID(appId)
        val storage = MMKV.mmkvWithID(StorageRecordCodec.storageId(appId))
        return when (apiName) {
            SET_STORAGE_SYNC -> {
                val kv = params.optJSONArray("args")
                if (kv != null && kv.length() >= 2) {
                    set(kv.getString(0), kv.get(1), storage)
                }
                NoneResult()
            }

            GET_STORAGE_SYNC -> {
                val key = params.optString("args")
                SyncResult(storageSyncValue(get(key, storage, legacyStorage)))
            }

            REMOVE_STORAGE_SYNC -> {
                val key = params.optString("args")
                if (key.isNotEmpty()) {
                    remove(key, storage)
                }
                NoneResult()
            }

            CLEAR_STORAGE_SYNC -> {
                storage.clear()
                legacyStorage.clear()
                NoneResult()
            }

            SET_STORAGE -> {
                val key = params.optString("key")
                val data = params.opt("data")
                val res = set(key, data, storage)
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$SET_STORAGE:${if (res) "ok" else "fail"}")
                })
            }

            GET_STORAGE -> {
                val key = params.optString("key")
                val value = get(key, storage, legacyStorage)
                AsyncResult(storageReadResult(value))
            }

            REMOVE_STORAGE -> {
                val key = params.optString("key")
                if (key.isNotEmpty()) {
                    remove(key, storage)
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$REMOVE_STORAGE:ok")
                    })
                } else {
                    AsyncResult(JSONObject().apply {
                        put("errMsg", "$REMOVE_STORAGE:fail")
                    })
                }
            }

            CLEAR_STORAGE -> {
                storage.clear()
                legacyStorage.clear()
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$CLEAR_STORAGE:ok")
                })
            }

            GET_STORAGE_INFO_SYNC -> {
                SyncResult(JSValue.createObject(storageInfo(storage, legacyStorage).toString()))
            }

            GET_STORAGE_INFO -> {
                AsyncResult(storageInfo(storage, legacyStorage).apply {
                    put("errMsg", "$GET_STORAGE_INFO:ok")
                })
            }

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    private fun set(key: String, data: Any?, storage: MMKV): Boolean {
        if (key.isEmpty()) return false
        return storage.encode(StorageRecordCodec.dataKey(key), StorageRecordCodec.encodeValue(data))
    }

    private fun remove(key: String, storage: MMKV) {
        storage.encode(StorageRecordCodec.dataKey(key), StorageRecordCodec.encodeDeleted())
    }

    private fun get(key: String, storage: MMKV, legacyStorage: MMKV): Any? {
        if (key.isEmpty()) return null
        val dataKey = StorageRecordCodec.dataKey(key)
        if (storage.containsKey(dataKey)) {
            return StorageRecordCodec.decode(storage.decodeString(dataKey))?.takeUnless { it.deleted }?.value
        }
        val legacyValue = getLegacy(key, legacyStorage) ?: return null
        set(key, legacyValue, storage)
        return legacyValue
    }

    private fun getLegacy(key: String, storage: MMKV): Any? {
        if (!storage.containsKey(key)) return null
        val type = storage.decodeString("${key}_type")
            ?: return storage.decodeString(key)
        return when (type) {
            "Int" -> storage.decodeInt(key, 0)
            "String" -> storage.decodeString(key)
            "Boolean" -> storage.decodeBool(key, false)
            "Float" -> storage.decodeFloat(key, 0f)
            "Long" -> storage.decodeLong(key, 0L)
            "Double" -> storage.decodeDouble(key, 0.0)
            "Array" -> storage.decodeString(key)?.let { raw ->
                runCatching { JSONArray(raw) }.getOrElse { raw }
            }
            "Object" -> storage.decodeString(key)?.let { raw ->
                runCatching { JSONObject(raw) }.getOrElse { raw }
            }
            else -> storage.decodeString(key)
        }
    }

    private fun storageInfo(storage: MMKV, legacyStorage: MMKV): JSONObject {
        val values = linkedMapOf<String, Int>()
        val overriddenKeys = mutableSetOf<String>()
        storage.allKeys()?.forEach { storedKey ->
            if (!storedKey.startsWith(StorageRecordCodec.DATA_PREFIX)) return@forEach
            val key = storedKey.removePrefix(StorageRecordCodec.DATA_PREFIX)
            overriddenKeys += key
            val raw = storage.decodeString(storedKey) ?: return@forEach
            val record = StorageRecordCodec.decode(raw) ?: return@forEach
            if (!record.deleted) values[key] = raw.toByteArray().size
        }
        legacyStorage.allKeys()?.forEach { legacyKey ->
            if (legacyKey.endsWith("_type") || legacyKey in overriddenKeys) return@forEach
            val value = getLegacy(legacyKey, legacyStorage) ?: return@forEach
            values[legacyKey] = value.toString().toByteArray().size
        }
        return storageInfoResult(values)
    }
}

internal data class StorageRecord(val deleted: Boolean, val value: Any? = null)

internal object StorageRecordCodec {
    const val DATA_PREFIX = "data:"
    private const val VERSION = 2

    fun storageId(appId: String): String = "dimina_storage_v2_${appId.length}_$appId"

    fun dataKey(key: String): String = "$DATA_PREFIX$key"

    fun encodeDeleted(): String = JSONObject()
        .put("version", VERSION)
        .put("kind", "deleted")
        .toString()

    fun encodeValue(value: Any?): String {
        val type = when (value) {
            null, JSONObject.NULL -> "Null"
            is Int -> "Int"
            is String -> "String"
            is Boolean -> "Boolean"
            is Float -> "Float"
            is Long -> "Long"
            is Double -> "Double"
            is JSONArray -> "Array"
            is JSONObject -> "Object"
            else -> "String"
        }
        return JSONObject()
            .put("version", VERSION)
            .put("kind", "value")
            .put("type", type)
            .put("value", when (type) {
                "Null" -> JSONObject.NULL
                "String" -> value?.toString() ?: ""
                else -> value
            })
            .toString()
    }

    fun decode(raw: String?): StorageRecord? {
        if (raw == null) return null
        return runCatching {
            val json = JSONObject(raw)
            if (json.optInt("version") != VERSION) return null
            if (json.optString("kind") == "deleted") return StorageRecord(deleted = true)
            if (json.optString("kind") != "value") return null
            val value = when (json.optString("type")) {
                "Null" -> JSONObject.NULL
                "Int" -> json.getInt("value")
                "String" -> json.getString("value")
                "Boolean" -> json.getBoolean("value")
                "Float" -> json.getDouble("value").toFloat()
                "Long" -> json.getLong("value")
                "Double" -> json.getDouble("value")
                "Array" -> json.getJSONArray("value")
                "Object" -> json.getJSONObject("value")
                else -> return null
            }
            StorageRecord(deleted = false, value = value)
        }.getOrNull()
    }
}
