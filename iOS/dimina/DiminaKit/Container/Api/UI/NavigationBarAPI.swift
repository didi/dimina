//
//  NavigationBarAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * UI - Navigation Bar API
 */
public class NavigationBarAPI: DMPContainerApi {
    
    // API method names
    private static let SET_NAVIGATION_BAR_TITLE = "setNavigationBarTitle"
    private static let SET_NAVIGATION_BAR_COLOR = "setNavigationBarColor"
    
    // Set navigation bar title
    @BridgeMethod(SET_NAVIGATION_BAR_TITLE)
    var setNavigationBarTitle: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let title = param.get("title") as? String else {
            let errorMsg = "\(SET_NAVIGATION_BAR_TITLE):fail missing parameter title"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errorMsg)
            return DMPAsyncResult()
        }
        
        
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)
        
        guard let navigationController = app?.getNavigator()?.navigationController else {
            let errorMsg = "\(SET_NAVIGATION_BAR_TITLE):fail navigation controller not found"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errorMsg)
            return DMPAsyncResult()
        }
        
        DispatchQueue.main.async {
            navigationController.topViewController?.title = title
            
            let result = DMPMap()
            result.set("errMsg", "\(SET_NAVIGATION_BAR_TITLE):ok")
            DMPContainerApi.invokeSuccess(callback: callback, param: result)
        }
        
        return DMPAsyncResult()
    }
    
    // Set navigation bar color
    @BridgeMethod(SET_NAVIGATION_BAR_COLOR)
    var setNavigationBarColor: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let frontColor = param.get("frontColor") as? String,
              let backgroundColor = param.get("backgroundColor") as? String else {
            let errorMsg = "\(SET_NAVIGATION_BAR_COLOR):fail missing required parameters"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errorMsg)
            return DMPAsyncResult()
        }
        
        guard frontColor == "#ffffff" || frontColor == "#000000" else {
            let errorMsg = "\(SET_NAVIGATION_BAR_COLOR):fail frontColor only supports #ffffff or #000000"
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errorMsg)
            return DMPAsyncResult()
        }
        
        let animation = param.getDMPMap(key: "animation")
        let duration = animation?.getInt(key: "duration") ?? 0
        let timingFunc = animation?.getString(key: "timingFunc") ?? "linear"
        
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)
        
        DispatchQueue.main.async {
            guard let navigationController = app?.getNavigator()?.navigationController,
                  let topViewController = navigationController.topViewController else {
                let errorMsg = "\(SET_NAVIGATION_BAR_COLOR):fail navigation controller not found"
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: errorMsg)
                return
            }
            
            let bgColor = DMPUtil.colorFromHexString(backgroundColor) ?? .white
            let textColor = frontColor == "#ffffff" ? UIColor.white : UIColor.black
            
            let appearance = UINavigationBarAppearance()
            appearance.configureWithOpaqueBackground()
            appearance.backgroundColor = bgColor
            appearance.titleTextAttributes = [.foregroundColor: textColor]
            
            let animationDuration = TimeInterval(duration) / 1000.0  // 毫秒转换为秒
            
            let animationOptions: UIView.AnimationOptions = {
                switch timingFunc {
                case "easeIn":
                    return .curveEaseIn
                case "easeOut":
                    return .curveEaseOut
                case "easeInOut":
                    return .curveEaseInOut
                default:
                    return .curveLinear
                }
            }()
            
            UIView.animate(withDuration: animationDuration, delay: 0, options: animationOptions) {
                // 设置特定于当前控制器的导航栏样式
                topViewController.navigationItem.standardAppearance = appearance
                topViewController.navigationItem.scrollEdgeAppearance = appearance
                topViewController.navigationItem.compactAppearance = appearance
                topViewController.navigationItem.leftBarButtonItem = app?.getNavigator()?.createBackButton(darkStyle: frontColor == "#ffffff")
                
                if #available(iOS 15.0, *) {
                    topViewController.navigationItem.compactScrollEdgeAppearance = appearance
                }
                
                // 设置导航栏按钮颜色
                navigationController.navigationBar.tintColor = textColor
                navigationController.navigationBar.setNeedsLayout()
            }
            
            // 保存样式到页面记录，以便页面恢复时使用
            if let pageRecord = app?.getNavigator()?.getTopPageRecord() {
                if pageRecord.navStyle == nil {
                    pageRecord.navStyle = [:]
                }
                var navStyle = pageRecord.navStyle!
                navStyle["navigationBarBackgroundColor"] = backgroundColor
                navStyle["navigationBarTextStyle"] = frontColor == "#ffffff" ? "white" : "black"
                pageRecord.navStyle = navStyle
            }
            
            let result = DMPMap()
            result.set("errMsg", "\(SET_NAVIGATION_BAR_COLOR):ok")
            DMPContainerApi.invokeSuccess(callback: callback, param: result)
        }
        
        return DMPAsyncResult()
    }
}
