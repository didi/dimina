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
import java.util.concurrent.ConcurrentHashMap

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

        private val storageLocks = ConcurrentHashMap<String, Any>()
        private fun storageLock(appId: String): Any = storageLocks.computeIfAbsent(appId) { Any() }

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

        internal fun storageInfoResult(values: Map<String, Long>): JSONObject = JSONObject().apply {
            put("keys", JSONArray(values.keys))
            put("currentSize", (StorageWire.spaceSize(values.values) + 1023) / 1024)
            put("limitSize", 10 * 1024)
        }

        internal fun clearAllStorage(appId: String) {
            synchronized(storageLock(appId)) {
                MMKV.mmkvWithID(appId).clearAll()
                MMKV.mmkvWithID(StorageRecordCodec.storageId(appId)).clearAll()
            }
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
        val lock = storageLock(appId)
        val space = StorageSpace(lock, { collectRecords(storage, legacyStorage) }, { key ->
            val dataKey = StorageRecordCodec.dataKey(key)
            val record = if (storage.containsKey(dataKey)) StorageRecordCodec.decode(storage.decodeString(dataKey)) else null
            record ?: getLegacy(key, legacyStorage)?.let { StorageRecord(false, it) }
        }) { key, encoded ->
            storage.encode(StorageRecordCodec.dataKey(key), encoded)
        }
        return synchronized(lock) { when (apiName) {
            SET_STORAGE_SYNC -> {
                val kv = params.optJSONArray("args")
                if (kv != null && kv.length() >= 2) {
                    try {
                        space.set(kv.getString(0), kv.get(1), kv.optJSONObject(2)?.optJSONObject("__diminaStorageWire"))
                    } catch (error: IllegalStateException) {
                        return@synchronized SyncResult(JSValue.createObject(JSONObject()
                            .put("__diminaStorageError", error.message).toString()))
                    }
                }
                NoneResult()
            }

            GET_STORAGE_SYNC -> {
                val key = params.optString("key", params.optString("args"))
                SyncResult(storageSyncValue(space.get(key, params.optBoolean("__diminaStorageWire"))))
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
                val message = try {
                    if (space.set(key, data, params.optJSONObject("__diminaStorageWire"))) "$SET_STORAGE:ok" else "$SET_STORAGE:fail"
                } catch (error: IllegalStateException) { "$SET_STORAGE:fail ${error.message}" }
                AsyncResult(JSONObject().put("errMsg", message))
            }

            GET_STORAGE -> {
                val key = params.optString("key")
                val value = space.get(key, params.optBoolean("__diminaStorageWire"))
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
                SyncResult(JSValue.createObject(space.info().toString()))
            }

            GET_STORAGE_INFO -> {
                AsyncResult(space.info().apply {
                    put("errMsg", "$GET_STORAGE_INFO:ok")
                })
            }

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        } }
    }

    private fun remove(key: String, storage: MMKV) {
        storage.encode(StorageRecordCodec.dataKey(key), StorageRecordCodec.encodeDeleted())
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

    private fun collectRecords(storage: MMKV, legacyStorage: MMKV): Map<String, StorageRecord> {
        val values = linkedMapOf<String, StorageRecord>()
        storage.allKeys()?.forEach { storedKey ->
            if (storedKey.startsWith(StorageRecordCodec.DATA_PREFIX)) {
                val key = storedKey.removePrefix(StorageRecordCodec.DATA_PREFIX)
                StorageRecordCodec.decode(storage.decodeString(storedKey))?.let { values[key] = it }
            }
        }
        legacyStorage.allKeys()?.forEach { key ->
            if (!key.endsWith("_type") && key !in values) {
                getLegacy(key, legacyStorage)?.let { values[key] = StorageRecord(false, it) }
            }
        }
        return values
    }
}

internal data class StorageRecord(val deleted: Boolean, val value: Any? = null, val wire: JSONObject? = null)

internal object StorageRecordCodec {
    const val DATA_PREFIX = "data:"
    private const val VERSION = 2

    fun storageId(appId: String): String = "dimina_storage_v2_${appId.length}_$appId"

    fun dataKey(key: String): String = "$DATA_PREFIX$key"

    fun encodeDeleted(): String = JSONObject()
        .put("version", VERSION)
        .put("kind", "deleted")
        .toString()

    fun encodeValue(value: Any?, wire: JSONObject? = null): String {
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
            .apply { if (wire != null) put("__diminaStorageWire", wire) }
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
            StorageRecord(deleted = false, value = value, wire = json.optJSONObject("__diminaStorageWire"))
        }.getOrNull()
    }
}


internal object StorageWire {
    const val QUOTA_ERROR = "exceed storage max size 10Mb"
    private const val LIMIT = 10L * 1024 * 1024

    fun quotedLength(value: String): Long {
        var length = 2L
        var index = 0
        while (index < value.length) {
            val character = value[index]
            length += when {
                character == '"' || character == '\\' || character in "\b\u000c\n\r\t" -> 2
                character.code < 0x20 -> 6
                Character.isHighSurrogate(character) && index + 1 < value.length && Character.isLowSurrogate(value[index + 1]) -> {
                    index++
                    2
                }
                Character.isSurrogate(character) -> 6
                else -> 1
            }
            index++
        }
        return length
    }

    fun normalize(key: String, value: Any?, wire: JSONObject?): JSONObject {
        val dataType: String
        val data: String
        if (wire?.opt("data") is String && wire.opt("dataType") is String) {
            dataType = wire.getString("dataType")
            data = wire.getString("data")
        } else {
            dataType = when (value) {
                null, JSONObject.NULL -> "Null"
                is String -> "String"
                is Number -> "Number"
                is Boolean -> "Boolean"
                is JSONArray -> "Array"
                is JSONObject -> "Object"
                else -> "String"
            }
            data = when (value) {
                null, JSONObject.NULL -> "null"
                is String -> value
                is Number -> numberString(value)
                is Boolean -> value.toString()
                is JSONArray, is JSONObject -> stringify(value)
                else -> value.toString()
            }
        }
        val size = quotedLength(key) + 1 + 21 + quotedLength(data) + quotedLength(dataType)
        return JSONObject().put("data", data).put("dataType", dataType).put("entrySize", size)
    }

    fun spaceSize(sizes: Collection<Long>): Long = 2L + sizes.sum() + (sizes.size - 1).coerceAtLeast(0)

    fun check(sizes: Collection<Long>) {
        if (spaceSize(sizes) + 6 > LIMIT) throw IllegalStateException(QUOTA_ERROR)
    }

    private fun numberString(value: Number): String {
        val number = value.toDouble()
        if (!number.isFinite()) return number.toString()
        if (number == 0.0) return "0"
        val decimal = java.math.BigDecimal.valueOf(number).stripTrailingZeros()
        val absolute = kotlin.math.abs(number)
        if (absolute >= 1e-6 && absolute < 1e21) return decimal.toPlainString()
        return decimal.toString().lowercase().replace(Regex("e([+-]?)0+(\\d+)"), "e$1$2")
    }

    private fun quote(value: String): String {
        val result = StringBuilder().append('"')
        var index = 0
        while (index < value.length) {
            val character = value[index]
            when (character) {
                '"' -> result.append("\\\"")
                '\\' -> result.append("\\\\")
                '\b' -> result.append("\\b")
                '\u000c' -> result.append("\\f")
                '\n' -> result.append("\\n")
                '\r' -> result.append("\\r")
                '\t' -> result.append("\\t")
                else -> when {
                    character.code < 0x20 -> result.append("\\u%04x".format(character.code))
                    Character.isHighSurrogate(character) && index + 1 < value.length && Character.isLowSurrogate(value[index + 1]) -> {
                        result.append(character).append(value[++index])
                    }
                    Character.isSurrogate(character) -> result.append("\\u%04x".format(character.code))
                    else -> result.append(character)
                }
            }
            index++
        }
        return result.append('"').toString()
    }

    private fun stringify(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is String -> quote(value)
        is Number -> numberString(value)
        is Boolean -> value.toString()
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { stringify(value.opt(it)) }
        is JSONObject -> value.keys().asSequence().joinToString(",", "{", "}") { quote(it) + ":" + stringify(value.opt(it)) }
        else -> quote(value.toString())
    }
}

internal class StorageSpace(
    private val lock: Any,
    private val records: () -> Map<String, StorageRecord>,
    private val lookup: ((String) -> StorageRecord?)? = null,
    private val commit: (String, String) -> Boolean,
) {
    fun set(key: String, value: Any?, wire: JSONObject?): Boolean = synchronized(lock) {
        if (key.isEmpty()) return false
        val normalized = StorageWire.normalize(key, value, wire)
        val sizes = records().filterValues { !it.deleted }.mapValues { (existingKey, record) ->
            StorageWire.normalize(existingKey, record.value, record.wire).getLong("entrySize")
        }.toMutableMap()
        sizes[key] = normalized.getLong("entrySize")
        StorageWire.check(sizes.values)
        commit(key, StorageRecordCodec.encodeValue(value, normalized))
    }

    fun info(): JSONObject = synchronized(lock) {
        val sizes = records().filterValues { !it.deleted }.mapValues { (key, record) ->
            StorageWire.normalize(key, record.value, record.wire).getLong("entrySize")
        }
        StorageApi.storageInfoResult(sizes)
    }

    fun get(key: String, wire: Boolean): Any? = synchronized(lock) {
        val record = (lookup?.invoke(key) ?: if (lookup == null) records()[key] else null)
            ?.takeUnless { it.deleted } ?: return null
        if (!wire) return record.value
        JSONObject().put("__diminaStorageResult", 1).apply {
            if (record.wire != null) put("record", record.wire) else put("value", record.value ?: JSONObject.NULL)
        }
    }
}
