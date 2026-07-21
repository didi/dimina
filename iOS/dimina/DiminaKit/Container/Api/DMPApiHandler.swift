//
//  DMPApiHandler.swift
//  dimina
//

import Foundation

/// Defines how a host-provided API handles bridge calls for one mini app.
public protocol DMPApiHandler: AnyObject {
    var apiNames: Set<String> { get }

    func handle(
        name: String,
        param: DMPBridgeParam,
        env: DMPBridgeEnv,
        callback: DMPBridgeCallback?
    ) -> DMPAPIResult
}

/// Controls how a host API behaves when its name is already registered.
public enum DMPApiConflictPolicy {
    /// Keep the existing API and skip the conflicting host API name.
    case reject

    /// Let the host API replace the existing API for this mini app.
    case replace
}

/// Convenience base class for host API implementations.
open class DMPBaseApiHandler: DMPApiHandler {
    private var handlers: [String: DMPBridgeMethodHandler] = [:]

    public init() {}

    public final var apiNames: Set<String> {
        Set(handlers.keys)
    }

    public final func register(
        _ name: String,
        handler: @escaping DMPBridgeMethodHandler
    ) {
        handlers[name] = handler
    }

    public final func handle(
        name: String,
        param: DMPBridgeParam,
        env: DMPBridgeEnv,
        callback: DMPBridgeCallback?
    ) -> DMPAPIResult {
        guard let handler = handlers[name] else {
            return DMPNoneResult()
        }
        return handler(param, env, callback)
    }
}
