//
//  WebSocketAPI.swift
//  dimina
//
//  Bridge shim for wx.connectSocket / SocketTask.
//
//  This file only wires the 11 bridge method names to
//  `DMPWebSocketManager.shared`; all behavior (validation, state machine,
//  background policy, legacy binding, ...) lives in DMPWebSocketManager /
//  DMPWebSocketValidation.

import Foundation

public class WebSocketAPI: DMPContainerApi {

    private static let CONNECT_SOCKET = "connectSocket"
    private static let SEND_SOCKET_MESSAGE = "sendSocketMessage"
    private static let CLOSE_SOCKET = "closeSocket"
    private static let ON_SOCKET_OPEN = "onSocketOpen"
    private static let ON_SOCKET_MESSAGE = "onSocketMessage"
    private static let ON_SOCKET_ERROR = "onSocketError"
    private static let ON_SOCKET_CLOSE = "onSocketClose"
    private static let OFF_SOCKET_OPEN = "offSocketOpen"
    private static let OFF_SOCKET_MESSAGE = "offSocketMessage"
    private static let OFF_SOCKET_ERROR = "offSocketError"
    private static let OFF_SOCKET_CLOSE = "offSocketClose"

    @BridgeMethod(CONNECT_SOCKET)
    var connectSocket: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.connectSocket(params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(SEND_SOCKET_MESSAGE)
    var sendSocketMessage: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.sendSocketMessage(params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(CLOSE_SOCKET)
    var closeSocket: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.closeSocket(params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(ON_SOCKET_OPEN)
    var onSocketOpen: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.onSocketEvent(event: .open, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(ON_SOCKET_MESSAGE)
    var onSocketMessage: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.onSocketEvent(event: .message, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(ON_SOCKET_ERROR)
    var onSocketError: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.onSocketEvent(event: .error, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(ON_SOCKET_CLOSE)
    var onSocketClose: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.onSocketEvent(event: .close, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(OFF_SOCKET_OPEN)
    var offSocketOpen: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.offSocketEvent(event: .open, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(OFF_SOCKET_MESSAGE)
    var offSocketMessage: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.offSocketEvent(event: .message, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(OFF_SOCKET_ERROR)
    var offSocketError: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.offSocketEvent(event: .error, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }

    @BridgeMethod(OFF_SOCKET_CLOSE)
    var offSocketClose: DMPBridgeMethodHandler = { param, env, callback in
        DMPWebSocketManager.shared.offSocketEvent(event: .close, params: param.getMap(), appId: env.appId, callback: callback)
        return DMPNoneResult()
    }
}
