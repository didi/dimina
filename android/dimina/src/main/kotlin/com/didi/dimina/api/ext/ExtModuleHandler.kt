package com.didi.dimina.api.ext

/**
 * 第三方扩展 bridge 模块的处理器接口。
 *
 * 宿主通过 [com.didi.dimina.Dimina.registerExtModule] 注册实现，
 * 框架在收到 extBridge / extOnBridge 调用时回调此接口。
 *
 * 示例（Kotlin）：
 * ```kotlin
 * Dimina.getInstance().registerExtModule("MyNativeModule") { event, data, callback ->
 *     when (event) {
 *         "getUserInfo" -> {
 *             // 一次性调用：执行后调用 callback.onSuccess(...)，返回 null
 *             callback.onSuccess(JSONObject().apply { put("name", "Alice") })
 *             null
 *         }
 *         "onTickEvent" -> {
 *             // 持续订阅：启动监听，返回取消函数
 *             val job = startTicking { res -> callback.onSuccess(res) }
 *             Runnable { job.cancel() }
 *         }
 *         else -> {
 *             callback.onFail(JSONObject().apply { put("errMsg", "unknown event: $event") })
 *             null
 *         }
 *     }
 * }
 * ```
 */
fun interface ExtModuleHandler {

    /**
     * 处理一次事件调用。
     *
     * @param event  事件名称（对应 service 侧 extBridge/extOnBridge 的 event 参数）
     * @param data   调用方传入的参数（对应 extBridge 的 data 字段）
     * @param callback 结果回调，用于返回 success / fail 数据
     * @return 对于持续订阅场景（extOnBridge）返回取消订阅的 [Runnable]；
     *         对于一次性调用（extBridge）返回 null
     */
    fun handle(event: String, data: org.json.JSONObject, callback: ExtCallback): Runnable?
}

/**
 * 回调接口，用于将 native 结果传回 JS 层。
 */
interface ExtCallback {
    fun onSuccess(result: org.json.JSONObject = org.json.JSONObject())
    fun onFail(error: org.json.JSONObject)
}
