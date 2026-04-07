//
//  BaseAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation

/**
 * Base API implementation
 */
public class BaseAPI: DMPContainerApi {
    
    // API method names
    private static let CAN_I_USE = "canIUse"
    
    // Check if API, component, or parameter is available
    @BridgeMethod(CAN_I_USE)
    var canIUse: DMPBridgeMethodHandler = { param, env, callback in
        guard let schema = param.getMap().get("schema") as? String else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "canIUse:fail missing parameter schema")
            return DMPSyncResult(false)
        }

        let registeredMethods = DMPContainerApi.getAllRegisteredMethods()

        let isAvailable = registeredMethods.contains(schema)

        return DMPSyncResult(isAvailable)
    }
    
}
