//
//  RouteAPI.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

import Foundation

/**
 * Navigation API implementation
 *
 * Handles all page navigation operations:
 * - navigateTo: Navigate to a new page
 * - redirectTo: Replace current page with a new one
 * - navigateBack: Navigate back to the previous page
 * - reLaunch: Close all pages and open a specific page
 */
public class RouteAPI: DMPContainerApi {

    // API method names
    private static let NAVIGATE_TO = "navigateTo"
    private static let REDIRECT_TO = "redirectTo"
    private static let NAVIGATE_BACK = "navigateBack"
    private static let RE_LAUNCH = "reLaunch"

    // Navigate to a new page
    @BridgeMethod(NAVIGATE_TO)
    var navigateTo: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let url = param.get("url") as? String, !url.isEmpty else {
            // Error handling for empty URL
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.NAVIGATE_TO):fail URL cannot be empty")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "URL cannot be empty")
            return DMPAsyncResult()
        }

        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        let urlData = DMPUtil.queryPath(path: url)
        let pagePath = urlData["pagePath"] as! String
        let query = urlData["query"] as! [String: Any]

        Task { @MainActor in
            await app?.getNavigator()?.navigateTo(to: pagePath, query: query)
        }

        let result = DMPMap()
        result.set("errMsg", "\(RouteAPI.NAVIGATE_TO):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    // Replace current page with a new one
    @BridgeMethod(REDIRECT_TO)
    var redirectTo: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let url = param.get("url") as? String, !url.isEmpty else {
            // Error handling for empty URL
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.REDIRECT_TO):fail URL cannot be empty")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "URL cannot be empty")
            return DMPAsyncResult()
        }

        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        let urlData = DMPUtil.queryPath(path: url)
        let pagePath = urlData["pagePath"] as! String
        let query = urlData["query"] as! [String: Any]

        Task { @MainActor in
            await app?.getNavigator()?.redirectTo(to: pagePath, query: query)
        }

        let result = DMPMap()
        result.set("errMsg", "\(RouteAPI.REDIRECT_TO):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    // Navigate back to the previous page
    @BridgeMethod(NAVIGATE_BACK)
    var navigateBack: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取当前应用
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        Task { @MainActor in
            app?.getNavigator()?.navigateBack(delta: param.getInt(key: "delta") ?? 1)
        }

        // 返回成功响应
        let result = DMPMap()
        result.set("errMsg", "\(RouteAPI.NAVIGATE_BACK):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    // Close all pages and open a specific page
    @BridgeMethod(RE_LAUNCH)
    var relaunch: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let url = param.get("url") as? String, !url.isEmpty else {
            // Error handling for empty URL
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.RE_LAUNCH):fail URL cannot be empty")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "URL cannot be empty")
            return DMPAsyncResult()
        }

        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        let urlData = DMPUtil.queryPath(path: url)
        let pagePath = urlData["pagePath"] as! String
        let query = urlData["query"] as! [String: Any]

        Task { @MainActor in
            await app?.getNavigator()?.relaunch(to: pagePath, query: query)
        }

        let result = DMPMap()
        result.set("errMsg", "\(RouteAPI.RE_LAUNCH):ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }
}
