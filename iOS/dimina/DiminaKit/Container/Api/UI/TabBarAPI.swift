//
//  TabBarAPI.swift
//  dimina
//
//  Created by Doslin on 2026/5/24.
//

import Foundation
import UIKit

/**
 * UI - TabBar API
 */
public class TabBarAPI: DMPContainerApi {
    private static let SET_TAB_BAR_STYLE = "setTabBarStyle"
    private static let SET_TAB_BAR_ITEM = "setTabBarItem"
    private static let SHOW_TAB_BAR = "showTabBar"
    private static let HIDE_TAB_BAR = "hideTabBar"
    private static let SET_TAB_BAR_BADGE = "setTabBarBadge"
    private static let REMOVE_TAB_BAR_BADGE = "removeTabBarBadge"
    private static let SHOW_TAB_BAR_RED_DOT = "showTabBarRedDot"
    private static let HIDE_TAB_BAR_RED_DOT = "hideTabBarRedDot"

    @BridgeMethod(SET_TAB_BAR_STYLE)
    var setTabBarStyle: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex),
              let bundleConfig = app.getBundleAppConfig(),
              var tabBarConfig = bundleConfig.tabBar
        else {
            invokeTabBarFailure(callback, SET_TAB_BAR_STYLE, "tabBar not configured")
            return DMPAsyncResult()
        }

        let color = param.getString(key: "color")
        let selectedColor = param.getString(key: "selectedColor")
        let backgroundColor = param.getString(key: "backgroundColor")
        let borderStyle = param.getString(key: "borderStyle")

        tabBarConfig.color = color ?? tabBarConfig.color
        tabBarConfig.selectedColor = selectedColor ?? tabBarConfig.selectedColor
        tabBarConfig.backgroundColor = backgroundColor ?? tabBarConfig.backgroundColor
        if borderStyle == "black" || borderStyle == "white" {
            tabBarConfig.borderStyle = borderStyle!
        }
        bundleConfig.tabBar = tabBarConfig

        DispatchQueue.main.async {
            currentTabBarController(app: app)?.setTabBarStyle(
                color: color,
                selectedColor: selectedColor,
                backgroundColor: backgroundColor,
                borderStyle: borderStyle
            )
            invokeTabBarSuccess(callback, SET_TAB_BAR_STYLE)
        }

        return DMPAsyncResult()
    }

    @BridgeMethod(SET_TAB_BAR_ITEM)
    var setTabBarItem: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex),
              let bundleConfig = app.getBundleAppConfig(),
              var tabBarConfig = bundleConfig.tabBar
        else {
            invokeTabBarFailure(callback, SET_TAB_BAR_ITEM, "tabBar not configured")
            return DMPAsyncResult()
        }

        let index = tabBarIndex(from: param)
        guard index >= 0, index < tabBarConfig.list.count else {
            invokeTabBarFailure(callback, SET_TAB_BAR_ITEM, "invalid index \(index)")
            return DMPAsyncResult()
        }

        var item = tabBarConfig.list[index]
        let text = param.getString(key: "text")
        let iconPath = param.getString(key: "iconPath")
        let selectedIconPath = param.getString(key: "selectedIconPath")
        item.text = text ?? item.text
        item.iconPath = iconPath ?? item.iconPath
        item.selectedIconPath = selectedIconPath ?? item.selectedIconPath
        tabBarConfig.list[index] = item
        bundleConfig.tabBar = tabBarConfig

        DispatchQueue.main.async {
            currentTabBarController(app: app)?.setTabBarItem(
                index: index,
                text: text,
                iconPath: iconPath,
                selectedIconPath: selectedIconPath
            )
            invokeTabBarSuccess(callback, SET_TAB_BAR_ITEM)
        }

        return DMPAsyncResult()
    }

    @BridgeMethod(SHOW_TAB_BAR)
    var showTabBar: DMPBridgeMethodHandler = { _, env, callback in
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)
        DispatchQueue.main.async {
            currentTabBarController(app: app)?.setTabBarVisible(true)
            invokeTabBarSuccess(callback, SHOW_TAB_BAR)
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(HIDE_TAB_BAR)
    var hideTabBar: DMPBridgeMethodHandler = { _, env, callback in
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)
        DispatchQueue.main.async {
            currentTabBarController(app: app)?.setTabBarVisible(false)
            invokeTabBarSuccess(callback, HIDE_TAB_BAR)
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(SET_TAB_BAR_BADGE)
    var setTabBarBadge: DMPBridgeMethodHandler = { param, env, callback in
        handleIndexedTabBarAction(
            apiName: SET_TAB_BAR_BADGE,
            param: param,
            env: env,
            callback: callback
        ) { controller, index, map in
            controller.setTabBarBadge(index: index, text: map.getString(key: "text") ?? "")
        }
    }

    @BridgeMethod(REMOVE_TAB_BAR_BADGE)
    var removeTabBarBadge: DMPBridgeMethodHandler = { param, env, callback in
        handleIndexedTabBarAction(
            apiName: REMOVE_TAB_BAR_BADGE,
            param: param,
            env: env,
            callback: callback
        ) { controller, index, _ in
            controller.removeTabBarBadge(index: index)
        }
    }

    @BridgeMethod(SHOW_TAB_BAR_RED_DOT)
    var showTabBarRedDot: DMPBridgeMethodHandler = { param, env, callback in
        handleIndexedTabBarAction(
            apiName: SHOW_TAB_BAR_RED_DOT,
            param: param,
            env: env,
            callback: callback
        ) { controller, index, _ in
            controller.showTabBarRedDot(index: index)
        }
    }

    @BridgeMethod(HIDE_TAB_BAR_RED_DOT)
    var hideTabBarRedDot: DMPBridgeMethodHandler = { param, env, callback in
        handleIndexedTabBarAction(
            apiName: HIDE_TAB_BAR_RED_DOT,
            param: param,
            env: env,
            callback: callback
        ) { controller, index, _ in
            controller.hideTabBarRedDot(index: index)
        }
    }
}

private func handleIndexedTabBarAction(
    apiName: String,
    param: DMPBridgeParam,
    env: DMPBridgeEnv,
    callback: DMPBridgeCallback?,
    action: @escaping (DMPTabBarContainerController, Int, DMPMap) -> Void
) -> DMPAPIResult {
    let map = param.getMap()
    guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex),
          let listLength = app.getBundleAppConfig()?.tabBar?.list.count,
          listLength > 0
    else {
        invokeTabBarFailure(callback, apiName, "tabBar not configured")
        return DMPAsyncResult()
    }

    let index = tabBarIndex(from: map)
    guard index >= 0, index < listLength else {
        invokeTabBarFailure(callback, apiName, "invalid index \(index)")
        return DMPAsyncResult()
    }

    DispatchQueue.main.async {
        if let controller = currentTabBarController(app: app) {
            action(controller, index, map)
        }
        invokeTabBarSuccess(callback, apiName)
    }
    return DMPAsyncResult()
}

private func currentTabBarController(app: DMPApp?) -> DMPTabBarContainerController? {
    guard let navigationController = app?.getNavigator()?.navigationController else {
        return nil
    }

    if let controller = navigationController.topViewController as? DMPTabBarContainerController {
        return controller
    }

    return navigationController.viewControllers.reversed().first {
        $0 is DMPTabBarContainerController
    } as? DMPTabBarContainerController
}

private func invokeTabBarSuccess(_ callback: DMPBridgeCallback?, _ apiName: String) {
    let result = DMPMap()
    result.set("errMsg", "\(apiName):ok")
    DMPContainerApi.invokeSuccess(callback: callback, param: result)
}

private func invokeTabBarFailure(_ callback: DMPBridgeCallback?, _ apiName: String, _ message: String) {
    DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(apiName):fail \(message)")
}

private func tabBarIndex(from map: DMPMap) -> Int {
    return intValue(map.get("index")) ?? -1
}

private func intValue(_ value: Any?) -> Int? {
    if let intValue = value as? Int {
        return intValue
    }
    if let numberValue = value as? NSNumber {
        let doubleValue = numberValue.doubleValue
        return doubleValue.rounded(.towardZero) == doubleValue ? numberValue.intValue : nil
    }
    if let doubleValue = value as? Double {
        return doubleValue.rounded(.towardZero) == doubleValue ? Int(doubleValue) : nil
    }
    if let stringValue = value as? String {
        return Int(stringValue)
    }
    return nil
}
