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
 * - navigateToMiniProgram/navigateBackMiniProgram: Navigate across bundled mini programs
 * - exitMiniProgram: Close and destroy the current mini program
 * - restartMiniProgram: Cold-restart the current mini-program runtime
 */
public class RouteAPI: DMPContainerApi {

    // API method names
    private static let NAVIGATE_TO = "navigateTo"
    private static let REDIRECT_TO = "redirectTo"
    private static let NAVIGATE_BACK = "navigateBack"
    private static let RE_LAUNCH = "reLaunch"
    private static let SWITCH_TAB = "switchTab"
    private static let NAVIGATE_TO_MINI_PROGRAM = "navigateToMiniProgram"
    private static let NAVIGATE_BACK_MINI_PROGRAM = "navigateBackMiniProgram"
    private static let EXIT_MINI_PROGRAM = "exitMiniProgram"
    private static let RESTART_MINI_PROGRAM = "restartMiniProgram"

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

        if app?.getBundleAppConfig()?.isTabBarPage(pagePath: pagePath) == true {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.NAVIGATE_TO):fail can not navigateTo a tabbar page: \(url)")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "can not navigateTo a tabbar page: \(url)")
            return DMPAsyncResult()
        }

        Task { @MainActor in
            guard let navigator = RouteAPI.activeNavigator(
                api: RouteAPI.NAVIGATE_TO,
                app: app,
                callback: callback
            ) else { return }
            await navigator.navigateTo(to: pagePath, query: query)
            guard navigator.isActiveNavigationOwner() else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO,
                    callback: callback,
                    reason: "source mini program is not currently presented"
                )
                return
            }
            RouteAPI.invokeSuccess(api: RouteAPI.NAVIGATE_TO, callback: callback)
        }
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

        if app?.getBundleAppConfig()?.isTabBarPage(pagePath: pagePath) == true {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.REDIRECT_TO):fail can not redirectTo a tabbar page: \(url)")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "can not redirectTo a tabbar page: \(url)")
            return DMPAsyncResult()
        }

        Task { @MainActor in
            guard let navigator = RouteAPI.activeNavigator(
                api: RouteAPI.REDIRECT_TO,
                app: app,
                callback: callback
            ) else { return }
            await navigator.redirectTo(to: pagePath, query: query)
            guard navigator.isActiveNavigationOwner() else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.REDIRECT_TO,
                    callback: callback,
                    reason: "source mini program is not currently presented"
                )
                return
            }
            RouteAPI.invokeSuccess(api: RouteAPI.REDIRECT_TO, callback: callback)
        }
        return DMPAsyncResult()
    }

    // Navigate back to the previous page
    @BridgeMethod(NAVIGATE_BACK)
    var navigateBack: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        // 获取当前应用
        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        Task { @MainActor in
            guard let navigator = RouteAPI.activeNavigator(
                api: RouteAPI.NAVIGATE_BACK,
                app: app,
                callback: callback
            ) else { return }
            navigator.navigateBack(delta: param.getInt(key: "delta") ?? 1)
            RouteAPI.invokeSuccess(api: RouteAPI.NAVIGATE_BACK, callback: callback)
        }
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
            guard let navigator = RouteAPI.activeNavigator(
                api: RouteAPI.RE_LAUNCH,
                app: app,
                callback: callback
            ) else { return }
            await navigator.relaunch(to: pagePath, query: query)
            guard navigator.isActiveNavigationOwner() else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.RE_LAUNCH,
                    callback: callback,
                    reason: "source mini program is not currently presented"
                )
                return
            }
            RouteAPI.invokeSuccess(api: RouteAPI.RE_LAUNCH, callback: callback)
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(SWITCH_TAB)
    var switchTab: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let url = param.get("url") as? String, !url.isEmpty else {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.SWITCH_TAB):fail URL cannot be empty")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "URL cannot be empty")
            return DMPAsyncResult()
        }

        let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex)

        let urlData = DMPUtil.queryPath(path: url)
        let pagePath = urlData["pagePath"] as! String
        let query = urlData["query"] as! [String: Any]

        guard app?.getBundleAppConfig()?.isTabBarPage(pagePath: pagePath) == true else {
            let errorMap = DMPMap()
            errorMap.set("errMsg", "\(RouteAPI.SWITCH_TAB):fail can not switchTab to a non-tabbar page: \(url)")
            DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "can not switchTab to a non-tabbar page: \(url)")
            return DMPAsyncResult()
        }

        Task { @MainActor in
            guard let navigator = RouteAPI.activeNavigator(
                api: RouteAPI.SWITCH_TAB,
                app: app,
                callback: callback
            ) else { return }
            let success = await navigator.switchTab(to: pagePath, query: query)
            if success {
                let result = DMPMap()
                result.set("errMsg", "\(RouteAPI.SWITCH_TAB):ok")
                DMPContainerApi.invokeSuccess(callback: callback, param: result)
            } else {
                let errorMap = DMPMap()
                errorMap.set("errMsg", "\(RouteAPI.SWITCH_TAB):fail can not switchTab to a non-tabbar page: \(url)")
                DMPContainerApi.invokeFailure(callback: callback, param: errorMap, errMsg: "can not switchTab to a non-tabbar page: \(url)")
            }
        }

        return DMPAsyncResult()
    }

    @BridgeMethod(NAVIGATE_TO_MINI_PROGRAM)
    var navigateToMiniProgram: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        if let rawShortLink = param.get("shortLink") {
            guard let shortLink = rawShortLink as? String else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: "shortLink must be a string"
                )
                return DMPAsyncResult()
            }
            if !shortLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: "shortLink is not supported for bundled mini programs"
                )
                return DMPAsyncResult()
            }
        }
        if let rawEnvVersion = param.get("envVersion"),
           (rawEnvVersion as? String) != "release" {
            RouteAPI.invokeFailure(
                api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                callback: callback,
                reason: "envVersion must be release"
            )
            return DMPAsyncResult()
        }
        if param.get("noRelaunchIfPathUnchanged") != nil {
            guard let noRelaunch = param.getBool(key: "noRelaunchIfPathUnchanged") else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: "noRelaunchIfPathUnchanged must be a boolean"
                )
                return DMPAsyncResult()
            }
            guard !noRelaunch else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: "noRelaunchIfPathUnchanged is not supported for bundled mini programs"
                )
                return DMPAsyncResult()
            }
        }
        guard let appId = param.getString(key: "appId"),
              !appId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            RouteAPI.invokeFailure(
                api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                callback: callback,
                reason: "appId is required"
            )
            return DMPAsyncResult()
        }
        let path: String?
        if let rawPath = param.get("path") {
            guard let pathValue = rawPath as? String else {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: "path must be a string"
                )
                return DMPAsyncResult()
            }
            let trimmedPath = pathValue.trimmingCharacters(in: .whitespacesAndNewlines)
            path = trimmedPath.isEmpty ? nil : trimmedPath
        } else {
            path = nil
        }
        guard let extraData = RouteAPI.extraData(
            api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
            param: param,
            callback: callback
        ) else { return DMPAsyncResult() }
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex) else {
            RouteAPI.invokeFailure(
                api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                callback: callback,
                reason: "invalid app"
            )
            return DMPAsyncResult()
        }
        Task { @MainActor in
            do {
                try await DMPAppManager.sharedInstance().navigateToMiniProgram(
                    from: app,
                    appId: appId,
                    path: path,
                    extraData: extraData
                )
                RouteAPI.invokeSuccess(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback
                )
            } catch {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_TO_MINI_PROGRAM,
                    callback: callback,
                    reason: error.localizedDescription
                )
            }
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(NAVIGATE_BACK_MINI_PROGRAM)
    var navigateBackMiniProgram: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let extraData = RouteAPI.extraData(
            api: RouteAPI.NAVIGATE_BACK_MINI_PROGRAM,
            param: param,
            callback: callback
        ) else { return DMPAsyncResult() }
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex) else {
            RouteAPI.invokeFailure(
                api: RouteAPI.NAVIGATE_BACK_MINI_PROGRAM,
                callback: callback,
                reason: "invalid app"
            )
            return DMPAsyncResult()
        }
        Task { @MainActor in
            do {
                try await DMPAppManager.sharedInstance().navigateBackMiniProgram(
                    from: app,
                    extraData: extraData,
                    onAccepted: {
                        RouteAPI.invokeSuccess(
                            api: RouteAPI.NAVIGATE_BACK_MINI_PROGRAM,
                            callback: callback
                        )
                    }
                )
            } catch {
                RouteAPI.invokeFailure(
                    api: RouteAPI.NAVIGATE_BACK_MINI_PROGRAM,
                    callback: callback,
                    reason: error.localizedDescription
                )
            }
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(EXIT_MINI_PROGRAM)
    var exitMiniProgram: DMPBridgeMethodHandler = { _, env, callback in
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex) else {
            RouteAPI.invokeFailure(
                api: RouteAPI.EXIT_MINI_PROGRAM,
                callback: callback,
                reason: "invalid app"
            )
            return DMPAsyncResult()
        }

        Task { @MainActor in
            do {
                try await DMPAppManager.sharedInstance().exitMiniProgram(
                    app,
                    onAccepted: {
                        RouteAPI.invokeSuccess(
                            api: RouteAPI.EXIT_MINI_PROGRAM,
                            callback: callback
                        )
                    }
                )
            } catch {
                RouteAPI.invokeFailure(
                    api: RouteAPI.EXIT_MINI_PROGRAM,
                    callback: callback,
                    reason: error.localizedDescription
                )
            }
        }
        return DMPAsyncResult()
    }

    @BridgeMethod(RESTART_MINI_PROGRAM)
    var restartMiniProgram: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        guard let rawPath = param.get("path") as? String else {
            RouteAPI.invokeFailure(
                api: RouteAPI.RESTART_MINI_PROGRAM,
                callback: callback,
                reason: "path is required"
            )
            return DMPAsyncResult()
        }
        let path = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            RouteAPI.invokeFailure(
                api: RouteAPI.RESTART_MINI_PROGRAM,
                callback: callback,
                reason: "path is required"
            )
            return DMPAsyncResult()
        }
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex) else {
            RouteAPI.invokeFailure(
                api: RouteAPI.RESTART_MINI_PROGRAM,
                callback: callback,
                reason: "invalid app"
            )
            return DMPAsyncResult()
        }

        Task { @MainActor in
            var accepted = false
            do {
                let restarted = try await DMPAppManager.sharedInstance().restartMiniProgram(
                    app,
                    path: path,
                    onAccepted: {
                        accepted = true
                        RouteAPI.invokeSuccess(
                            api: RouteAPI.RESTART_MINI_PROGRAM,
                            callback: callback
                        )
                    }
                )
                if !restarted && !accepted {
                    RouteAPI.invokeFailure(
                        api: RouteAPI.RESTART_MINI_PROGRAM,
                        callback: callback,
                        reason: "unable to restart mini program"
                    )
                }
            } catch where !accepted {
                RouteAPI.invokeFailure(
                    api: RouteAPI.RESTART_MINI_PROGRAM,
                    callback: callback,
                    reason: error.localizedDescription
                )
            } catch {
                // Once the old service accepted the restart, startup failures
                // belong to the new launch chain and must not double-callback.
            }
        }
        return DMPAsyncResult()
    }

    static func invokeSuccess(api: String, callback: DMPBridgeCallback?) {
        DMPContainerApi.invokeSuccess(
            callback: callback,
            param: DMPMap(["errMsg": "\(api):ok"]),
            completeCarriesResult: true
        )
    }

    @MainActor
    private static func activeNavigator(
        api: String,
        app: DMPApp?,
        callback: DMPBridgeCallback?
    ) -> DMPNavigator? {
        guard let navigator = app?.getNavigator(),
              navigator.isActiveNavigationOwner() else {
            invokeFailure(
                api: api,
                callback: callback,
                reason: "source mini program is not currently presented"
            )
            return nil
        }
        guard !DMPAppManager.sharedInstance().isMiniProgramOperationInFlight() else {
            invokeFailure(
                api: api,
                callback: callback,
                reason: "another mini program operation is in progress"
            )
            return nil
        }
        return navigator
    }

    private static func extraData(
        api: String,
        param: DMPMap,
        callback: DMPBridgeCallback?
    ) -> [String: Any]? {
        guard param.get("extraData") != nil else { return [:] }
        guard let extraData = param.getDict(key: "extraData") else {
            invokeFailure(
                api: api,
                callback: callback,
                reason: "extraData must be an object"
            )
            return nil
        }
        return extraData
    }

    static func invokeFailure(
        api: String,
        callback: DMPBridgeCallback?,
        reason: String
    ) {
        let errMsg = "\(api):fail \(reason)"
        DMPContainerApi.invokeFailure(
            callback: callback,
            param: DMPMap(["errMsg": errMsg]),
            errMsg: errMsg,
            completeCarriesResult: true
        )
    }
}
