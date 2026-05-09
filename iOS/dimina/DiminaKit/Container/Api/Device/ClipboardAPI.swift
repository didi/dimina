//
//  ClipboardAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * Device - Clipboard API
 */
public class ClipboardAPI: DMPContainerApi {
    
    // API method names
    private static let SET_CLIPBOARD_DATA = "setClipboardData"
    private static let GET_CLIPBOARD_DATA = "getClipboardData"
    
    // Set clipboard data
    @BridgeMethod(SET_CLIPBOARD_DATA)
    var setClipboardData: DMPBridgeMethodHandler = { param, env, callback in
        guard let data = param.getMap().get("data") as? String else {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(ClipboardAPI.SET_CLIPBOARD_DATA):fail data is required")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "data is required")
            return DMPAsyncResult()
        }

        // 直接设置剪贴板内容
        UIPasteboard.general.string = data

        let result = DMPMap()
        result.set("errMsg", "\(ClipboardAPI.SET_CLIPBOARD_DATA):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    // Get clipboard data
    @BridgeMethod(GET_CLIPBOARD_DATA)
    var getClipboardData: DMPBridgeMethodHandler = { param, env, callback in
        // 直接获取剪贴板内容
        let clipboardData = UIPasteboard.general.string

        let result = DMPMap()
        if let clipboardData = clipboardData {
            result.set("data", clipboardData)
        }
        result.set("errMsg", "\(ClipboardAPI.GET_CLIPBOARD_DATA):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
}
