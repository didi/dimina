//
//  UpdateAPI.swift
//  dimina
//

import Foundation

/**
 * Update manager container-side APIs
 */
public class UpdateAPI: DMPContainerApi {

    private static let APPLY_UPDATE = "applyUpdate"

    @BridgeMethod(APPLY_UPDATE)
    var applyUpdate: DMPBridgeMethodHandler = { param, env, callback in
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        Task { @MainActor in
            await app?.applyUpdate()

            let result = DMPMap()
            result.set("errMsg", "\(UpdateAPI.APPLY_UPDATE):ok")
            DMPContainerApi.invokeSuccess(callback: callback, param: result)
        }

        return DMPAsyncResult()
    }
}
