//
//  KeyboardAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * Device - Keyboard API
 */
public class KeyboardAPI: DMPContainerApi {
    
    // API method names
    private static let HIDE_KEYBOARD = "hideKeyboard"
    private static let ADJUST_POSITION = "adjustPosition"
    
    // Hide keyboard
    @BridgeMethod(HIDE_KEYBOARD)
    var hideKeyboard: DMPBridgeMethodHandler = { param, env, callback in
        // 让当前第一响应者放弃响应状态来隐藏键盘
        DispatchQueue.main.async {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }

        let result = DMPMap()
        result.set("errMsg", "\(KeyboardAPI.HIDE_KEYBOARD):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    // Adjust position
    @BridgeMethod(ADJUST_POSITION)
    var adjustPosition: DMPBridgeMethodHandler = { param, env, callback in
        // Empty implementation for adjusting the keyboard position
        return DMPNoneResult()
    }
    
}
