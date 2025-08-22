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
    private companion object {
        const val SET_STORAGE_SYNC = "setStorageSync"
        const val GET_STORAGE_SYNC = "getStorageSync"
        const val REMOVE_STORAGE_SYNC = "removeStorageSync"
        const val CLEAR_STORAGE_SYNC = "clearStorageSync"
        const val SET_STORAGE = "setStorage"
        const val GET_STORAGE = "getStorage"
        const val REMOVE_STORAGE = "removeStorage"
        const val CLEAR_STORAGE = "clearStorage"
        const val GET_STORAGE_INFO_SYNC = "getStorageInfoSync"
        const val GET_STORAGE_INFO = "getStorageInfo"
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
        val storage = MMKV.mmkvWithID(appId)
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
                return when (val value = get(key, storage)) {
                    is String -> SyncResult(JSValue.createString(value))
                    is Int -> SyncResult(JSValue.createNumber(value.toDouble()))
                    is Double -> SyncResult(JSValue.createNumber(value))
                    is Float -> SyncResult(JSValue.createNumber(value.toDouble()))
                    is Boolean -> SyncResult(JSValue.createBoolean(value))
                    else -> SyncResult(JSValue.createNull())
                }
            }

            REMOVE_STORAGE_SYNC -> {
                val key = params.optString("args")
                if (key.isNotEmpty()) {
                    storage.removeValueForKey(key)
                }
                NoneResult()
            }

            CLEAR_STORAGE_SYNC -> {
                storage.clear()
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
                val value = get(key, storage)
                AsyncResult(JSONObject().apply {
                    put("data", value)
                    put("errMsg", "$GET_STORAGE:ok")
                })
            }

            REMOVE_STORAGE -> {
                val key = params.optString("key")
                if (key.isNotEmpty()) {
                    storage.removeValueForKey(key)
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
                AsyncResult(JSONObject().apply {
                    put("errMsg", "$CLEAR_STORAGE:ok")
                })
            }

            GET_STORAGE_INFO_SYNC -> {
                SyncResult(JSValue.createObject(JSONObject().apply {
                    put(
                        "keys", storage.allKeys()
                            ?.filter { !it.endsWith("_type") }
                    )
                    put("currentSize", storage.totalSize())
                    put("limitSize", 10 * 1024 * 1024)
                }.toString()))
            }

            GET_STORAGE_INFO -> {
                AsyncResult(JSONObject().apply {
                    put(
                        "keys", storage.allKeys()
                            ?.filter { !it.endsWith("_type") }
                    )
                    put("currentSize", storage.totalSize())
                    put("limitSize", 10 * 1024 * 1024)
                    put("errMsg", "$GET_STORAGE:ok")
                })
            }

            else ->
                super.handleAction(activity, appId, apiName, params, responseCallback)
        }
    }

    private fun set(key: String, data: Any?, storage: MMKV): Boolean {
        if (key.isNotEmpty()) {
            val typeKey = "${key}_type" // Store type info with a suffix
            when (data) {
                is Int -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "Int")
                }

                is String -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "String")
                }

                is Boolean -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "Boolean")
                }

                is Float -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "Float")
                }

                is Long -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "Long")
                }

                is Double -> {
                    storage.encode(key, data)
                    storage.encode(typeKey, "Double")
                }

                is JSONArray -> {
                    storage.encode(key, data.toString())
                    storage.encode(typeKey, "Array")
                }

                is Any -> try {
                    // For JSON-serializable objects
                    storage.encode(key, data.toString())
                    storage.encode(typeKey, "String") // Treat as String
                } catch (_: Exception) {
                    return false
                }
            }
            return true
        }
        return false
    }

    private fun get(key: String, storage: MMKV): Any? {
        if (key.isNotEmpty() && storage.containsKey(key)) {
            val typeKey = "${key}_type"
            val type = storage.decodeString(typeKey)
                ?: return storage.decodeString(key) // Fallback to String if no type info

            return when (type) {
                "Int" -> storage.decodeInt(key, 0)
                "String" -> storage.decodeString(key)
                "Boolean" -> storage.decodeBool(key, false)
                "Float" -> storage.decodeFloat(key, 0f)
                "Long" -> storage.decodeLong(key, 0L)
                "Double" -> storage.decodeDouble(key, 0.0)
                "Array" -> try {
                    JSONArray(storage.decodeString(key))
                } catch (_: Exception) {
                    storage.decodeString(key) // Fallback to String if parsing fails
                }
                else -> storage.decodeString(key) // Fallback to String for unknown types
            }
        }
        return null
    }
}
