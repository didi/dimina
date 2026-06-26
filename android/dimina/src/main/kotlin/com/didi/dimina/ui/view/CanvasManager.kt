package com.didi.dimina.ui.view

import com.didi.dimina.common.LogUtils
import com.didi.dimina.core.Bridge
import org.json.JSONObject

/**
 * Manages native canvas components and dispatches canvas drawing operations.
 * Mirrors the Harmony DMPCanvasManager.ets logic.
 */
class CanvasManager {

    // componentId → NativeCanvasView
    private val canvasViews = mutableMapOf<String, NativeCanvasView>()

    // contextId → componentId
    private val contextIdMap = mutableMapOf<String, String>()

    // resourceId → Any (gradient, etc.)
    private val resources = mutableMapOf<String, Any>()

    fun register(componentId: String, view: NativeCanvasView) {
        canvasViews[componentId] = view
    }

    fun unregister(componentId: String) {
        canvasViews.remove(componentId)
        contextIdMap.entries.removeAll { it.value == componentId }
    }

    fun handleMessage(msg: String, bridge: Bridge) {
        try {
            val json = JSONObject(msg)
            val body = json.optJSONObject("body") ?: return
            val name = body.optString("name")
            val params = body.optJSONObject("params") ?: return
            val bridgeId = body.opt("bridgeId")

            when (name) {
                "canvasNodeFlush" -> handleFlush(params, bridge, bridgeId)
                "canvasNodeRequestAnimationFrame" -> handleRequestAnimationFrame(params, bridge, bridgeId)
            }
        } catch (e: Exception) {
            LogUtils.e(TAG, "CanvasManager handleMessage error: ${e.message}")
        }
    }

    private fun handleFlush(params: JSONObject, bridge: Bridge, bridgeId: Any?) {
        val nodeId = params.optString("nodeId")
        val operations = params.optJSONArray("operations") ?: return
        if (nodeId.isEmpty()) return

        val view = canvasViews[nodeId] ?: return

        for (i in 0 until operations.length()) {
            val operation = operations.optJSONObject(i) ?: continue
            executeOperation(view, operation, bridge, bridgeId, nodeId)
        }

        // Flush after all operations
        view.post { view.flush() }
    }

    private fun handleRequestAnimationFrame(params: JSONObject, bridge: Bridge, bridgeId: Any?) {
        val callbackId = params.optString("callback")
        if (callbackId.isEmpty()) return
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            val timestamp = System.currentTimeMillis()
            triggerCallback(bridge, bridgeId, callbackId, timestamp)
        }, 16) // ~60fps
    }

    private fun executeOperation(
        view: NativeCanvasView,
        operation: JSONObject,
        bridge: Bridge,
        bridgeId: Any?,
        nodeId: String,
    ) {
        val op = operation.optString("op")

        when (op) {
            "getContext" -> {
                val contextId = operation.optString("contextId")
                if (contextId.isNotEmpty()) {
                    contextIdMap[contextId] = nodeId
                }
            }

            "contextSetProperty" -> {
                val prop = operation.optString("prop")
                val value = resolveArg(operation.opt("value"))
                view.post { view.setProperty(prop, value) }
            }

            "contextCall" -> {
                val method = operation.optString("method")
                val rawArgs = operation.optJSONArray("args")
                val args = mutableListOf<Any?>()
                if (rawArgs != null) {
                    for (i in 0 until rawArgs.length()) {
                        args.add(resolveArg(rawArgs.opt(i)))
                    }
                }
                val resultId = operation.optString("resultId")
                view.post {
                    val result = view.callMethod(method, args)
                    if (resultId.isNotEmpty() && result != null) {
                        resources[resultId] = result
                    }
                }
            }

            "resourceCall" -> {
                val resourceId = operation.optString("resourceId")
                val resource = resources[resourceId] ?: return
                val method = operation.optString("method")
                val rawArgs = operation.optJSONArray("args")
                val args = mutableListOf<Any?>()
                if (rawArgs != null) {
                    for (i in 0 until rawArgs.length()) {
                        args.add(resolveArg(rawArgs.opt(i)))
                    }
                }

                if (resource is CanvasGradient && method == "addColorStop") {
                    val offset = (args.getOrNull(0) as? Number)?.toFloat() ?: 0f
                    val color = parseCanvasColor(args.getOrNull(1))
                    resource.addColorStop(offset, color)
                }
            }

            "setCanvasProperty" -> {
                // Canvas size changes — handled by overlay layout
            }

            "createImage" -> {
                // Will be handled when imageSetSrc is called
            }

            "imageSetSrc" -> {
                // Phase 2 feature
            }
        }
    }

    private fun resolveArg(value: Any?): Any? {
        if (value == null || value == JSONObject.NULL) return null

        if (value is org.json.JSONArray) {
            val list = mutableListOf<Any?>()
            for (i in 0 until value.length()) {
                list.add(resolveArg(value.opt(i)))
            }
            return list
        }

        if (value is JSONObject) {
            val resourceId = value.optString("__canvasResourceId", "")
            if (resourceId.isNotEmpty()) {
                return resources[resourceId] ?: value
            }

            // Recursively resolve plain objects
            val result = mutableMapOf<String, Any?>()
            for (key in value.keys()) {
                result[key] = resolveArg(value.opt(key))
            }
            return result
        }

        return value
    }

    private fun triggerCallback(bridge: Bridge, bridgeId: Any?, callbackId: String, args: Any) {
        val body = JSONObject().apply {
            put("id", callbackId)
            put("args", args)
            if (bridgeId != null) put("bridgeId", bridgeId)
        }
        val msg = JSONObject().apply {
            put("type", "triggerCallback")
            put("body", body)
        }
        bridge.options.jscore.postMessage(msg.toString())
    }

    companion object {
        private const val TAG = "CanvasManager"
        val instance = CanvasManager()

        fun shouldIntercept(msg: String): Boolean {
            return msg.contains("\"canvasNodeFlush\"") ||
                msg.contains("\"canvasNodeRequestAnimationFrame\"")
        }
    }
}
