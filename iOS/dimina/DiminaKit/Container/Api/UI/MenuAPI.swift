//
//  MenuAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * UI - Menu API
 */
public class MenuAPI: DMPContainerApi {
    
    // API method names
    private static let GET_MENU_BUTTON_BOUNDING_CLIENT_RECT = "getMenuButtonBoundingClientRect"
    
    // Get menu button bounding client rect
    @BridgeMethod(GET_MENU_BUTTON_BOUNDING_CLIENT_RECT)
    var getMenuButtonBoundingClientRect: DMPBridgeMethodHandler = { param, env, callback in
        let menuButtonInfo = MenuAPI.getMenuButtonBoundingClientRect()
        return DMPSyncResult(menuButtonInfo.toDictionary())
    }
    
    static func getMenuButtonBoundingClientRect() -> DMPMap {
        let screenWidth = UIScreen.main.bounds.width
        
        // 菜单按钮尺寸参数
        let width: CGFloat = 87.0
        let height: CGFloat = 32.0
        
        var top: CGFloat = 0

        let statusBarHeight = DMPUIManager.shared.getStatusBarHeight()
        
        // 根据状态栏高度判断设备类型
        // 灵动岛设备状态栏高度通常为 54 或更高
        if statusBarHeight >= 54 {
            // 灵动岛设备
            top = statusBarHeight - 4
        } else if statusBarHeight > 20 {
            // 普通刘海屏设备
            top = 48.0
        } else {
            // 传统设备
            top = 24.0
        }
        
        let right: CGFloat = screenWidth - 10.0
        let left: CGFloat = right - width
        let bottom: CGFloat = top + height
        
        let menuButtonInfo = DMPMap([
            "width": width,
            "height": height,
            "top": top,
            "right": right,
            "bottom": bottom,
            "left": left
        ])
        
        return menuButtonInfo
    }
}
