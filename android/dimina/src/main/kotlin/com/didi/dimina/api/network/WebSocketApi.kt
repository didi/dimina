package com.didi.dimina.api.network

import com.didi.dimina.api.APIResult
import com.didi.dimina.api.BaseApiHandler
import com.didi.dimina.api.NoneResult
import com.didi.dimina.ui.container.DiminaActivity
import org.json.JSONObject

/**
 * Bridge shell for `wx.connectSocket`/`SocketTask`.
 *
 * Pure wiring: figures out which owner (appId) is calling, whether this is a task-mode call
 * (has `socketId`) or a legacy global-mode call, refreshes the event push channel, and delegates
 * everything else to [WebSocketManager]. All 11 API names always return [NoneResult] - one-shot
 * success/fail/complete callbacks are triggered by the Manager itself via `ApiUtils`, matching
 * `NetworkApi`'s `REQUEST` path, and avoiding `MiniApp.invokeAPI`'s `AsyncResult` auto-dispatch.
 */
class WebSocketApi : BaseApiHandler() {
    companion object {
        private const val CONNECT_SOCKET = "connectSocket"
        private const val SEND_SOCKET_MESSAGE = "sendSocketMessage"
        private const val CLOSE_SOCKET = "closeSocket"
        private const val ON_SOCKET_OPEN = "onSocketOpen"
        private const val ON_SOCKET_MESSAGE = "onSocketMessage"
        private const val ON_SOCKET_ERROR = "onSocketError"
        private const val ON_SOCKET_CLOSE = "onSocketClose"
        private const val OFF_SOCKET_OPEN = "offSocketOpen"
        private const val OFF_SOCKET_MESSAGE = "offSocketMessage"
        private const val OFF_SOCKET_ERROR = "offSocketError"
        private const val OFF_SOCKET_CLOSE = "offSocketClose"
    }

    override val apiNames = setOf(
        CONNECT_SOCKET, SEND_SOCKET_MESSAGE, CLOSE_SOCKET,
        ON_SOCKET_OPEN, ON_SOCKET_MESSAGE, ON_SOCKET_ERROR, ON_SOCKET_CLOSE,
        OFF_SOCKET_OPEN, OFF_SOCKET_MESSAGE, OFF_SOCKET_ERROR, OFF_SOCKET_CLOSE,
    )

    override fun handleAction(
        activity: DiminaActivity,
        appId: String,
        apiName: String,
        params: JSONObject,
        responseCallback: (String) -> Unit,
    ): APIResult {
        val manager = WebSocketManager.shared
        // Every invocation refreshes the emitter closure so persistent events can still reach
        // this appId's service JsCore even after the invoking page/Bridge is gone.
        manager.updateEmitter(appId) { json -> responseCallback(json) }

        // The same API name carries both task-mode (has socketId) and legacy global-mode (no
        // socketId) calls; branch on params, not on a second API name.
        val hasSocketId = params.has("socketId")

        when (apiName) {
            CONNECT_SOCKET -> manager.connectSocket(
                appId,
                activity.getMiniProgram().versionCode.toString(),
                params,
                responseCallback,
            )
            SEND_SOCKET_MESSAGE -> manager.sendSocketMessage(appId, hasSocketId, params, responseCallback)
            CLOSE_SOCKET -> manager.closeSocket(appId, hasSocketId, params, responseCallback)
            ON_SOCKET_OPEN -> manager.onSocketEvent("open", appId, hasSocketId, params, apiName, responseCallback)
            ON_SOCKET_MESSAGE -> manager.onSocketEvent("message", appId, hasSocketId, params, apiName, responseCallback)
            ON_SOCKET_ERROR -> manager.onSocketEvent("error", appId, hasSocketId, params, apiName, responseCallback)
            ON_SOCKET_CLOSE -> manager.onSocketEvent("close", appId, hasSocketId, params, apiName, responseCallback)
            OFF_SOCKET_OPEN -> manager.offSocketEvent("open", appId, hasSocketId, params, apiName, responseCallback)
            OFF_SOCKET_MESSAGE -> manager.offSocketEvent("message", appId, hasSocketId, params, apiName, responseCallback)
            OFF_SOCKET_ERROR -> manager.offSocketEvent("error", appId, hasSocketId, params, apiName, responseCallback)
            OFF_SOCKET_CLOSE -> manager.offSocketEvent("close", appId, hasSocketId, params, apiName, responseCallback)
        }

        return NoneResult()
    }
}
