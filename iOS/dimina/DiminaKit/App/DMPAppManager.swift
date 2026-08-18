//
//  DMPAppManager.swift
//  dimina
//
//  Created by Lehem on 2025/4/28.
//

import Foundation

enum DMPMiniProgramNavigationError: LocalizedError {
    case invalidAppId
    case sourceUnavailable
    case cannotOpenSelf
    case targetNotBundled(String)
    case targetAlreadyRunning(String)
    case navigationControllerUnavailable
    case targetLaunchFailed(String)
    case notOpenedByMiniProgram
    case openerUnavailable
    case operationInProgress
    case sourceNotPresented

    var errorDescription: String? {
        switch self {
        case .invalidAppId:
            return "appId is required"
        case .sourceUnavailable:
            return "source mini program is unavailable"
        case .cannotOpenSelf:
            return "cannot navigate to the current mini program"
        case .targetNotBundled(let appId):
            return "mini program \(appId) is not bundled"
        case .targetAlreadyRunning(let appId):
            return "mini program \(appId) is already running"
        case .navigationControllerUnavailable:
            return "navigation controller is unavailable"
        case .targetLaunchFailed(let appId):
            return "failed to launch mini program \(appId)"
        case .notOpenedByMiniProgram:
            return "current mini program was not opened by another mini program"
        case .openerUnavailable:
            return "opener mini program is unavailable"
        case .operationInProgress:
            return "another mini program operation is in progress"
        case .sourceNotPresented:
            return "source mini program is not currently presented"
        }
    }
}

public class DMPAppManager {
    private static let instance = DMPAppManager()

    private let stateLock = NSLock()
    private var appPools: [Int: DMPApp] = [:]
    private var appIndex: Int = 0
    public private(set) var apiNamespaces: [String] = []

    private struct MiniProgramOpenerContext {
        let openerAppIndex: Int
        let targetAppId: String
    }

    /// Keyed by target app index. A relation exists only while that target was
    /// entered through navigateToMiniProgram and can therefore navigate back.
    private var miniProgramOpeners: [Int: MiniProgramOpenerContext] = [:]

    /// Cross-app operations all mutate the same presentation stack and app
    /// pool. Main-actor serialization alone is insufficient because each
    /// operation suspends across await points, so reject overlapping
    /// navigate/back/exit/restart transactions explicitly.
    @MainActor private var isMiniProgramOperationInProgress = false

    private init() {}

    public static func sharedInstance() -> DMPAppManager {
        return instance
    }

    public func setup(apiNamespaces: [String] = []) {
        self.apiNamespaces = apiNamespaces
    }

    private func withStateLock<T>(_ body: () -> T) -> T {
        stateLock.lock()
        defer { stateLock.unlock() }
        return body()
    }
    
    func getApp(appIndex: Int) -> DMPApp? {
        return withStateLock { appPools[appIndex] }
    }
    
    func newAppWithConfig(appConfig: DMPAppConfig) -> DMPApp {
        let newApp = withStateLock {
            appIndex += 1
            let app = DMPApp(appConfig: appConfig, appIndex: appIndex)
            appPools[appIndex] = app
            return app
        }
        applyPendingExtModules(to: newApp)
        return newApp
    }
    
    public func appWithConfig(appConfig: DMPAppConfig) -> DMPApp {
        DMPLogger.debug("appWithConfig config=\(appConfig)")
        var created = false
        let app = withStateLock {
            if let existingApp = appPools.values.first(where: {
                $0.getAppId() == appConfig.appId
            }) {
                return existingApp
            }
            appIndex += 1
            let newApp = DMPApp(appConfig: appConfig, appIndex: appIndex)
            appPools[appIndex] = newApp
            created = true
            return newApp
        }
        if !created {
            DMPLogger.debug("appWithConfig return exist DMPApp")
        } else {
            DMPLogger.debug("appWithConfig create DMPApp")
            // 自动注入已提前注册的 ext 模块
            applyPendingExtModules(to: app)
        }
        return app
    }

    func existApp(appId: String) -> DMPApp? {
        return withStateLock {
            appPools.values.first(where: { $0.getAppId() == appId })
        }
    }
    
    func removeApp(appId: String) {
        let openerContext: MiniProgramOpenerContext? = withStateLock {
            guard let key = appPools.first(where: {
                $0.value.getAppId() == appId
            })?.key else { return nil }
            appPools.removeValue(forKey: key)
            let openerContext = miniProgramOpeners.removeValue(forKey: key)
            miniProgramOpeners = miniProgramOpeners.filter {
                $0.value.openerAppIndex != key
            }
            return openerContext
        }

        // Direct host destroy paths still restore a suspended opener when the
        // closed app came from another mini program.
        if let openerContext {
            Task { @MainActor [weak self] in
                self?.restoreOpener(openerContext, extraData: nil)
            }
        }
    }

    private func openerContext(for targetAppIndex: Int) -> MiniProgramOpenerContext? {
        return withStateLock { miniProgramOpeners[targetAppIndex] }
    }

    private func setOpenerContext(
        _ context: MiniProgramOpenerContext,
        for targetAppIndex: Int
    ) {
        withStateLock {
            miniProgramOpeners[targetAppIndex] = context
        }
    }

    @discardableResult
    private func removeOpenerContext(for targetAppIndex: Int) -> MiniProgramOpenerContext? {
        return withStateLock {
            miniProgramOpeners.removeValue(forKey: targetAppIndex)
        }
    }

    // MARK: - Mini Program Navigation

    @MainActor
    func withMiniProgramOperation<T>(
        _ operation: @MainActor () async throws -> T
    ) async throws -> T {
        guard !isMiniProgramOperationInProgress else {
            throw DMPMiniProgramNavigationError.operationInProgress
        }
        isMiniProgramOperationInProgress = true
        defer {
            isMiniProgramOperationInProgress = false
        }
        return try await operation()
    }

    @MainActor
    func isMiniProgramOperationInFlight() -> Bool {
        return isMiniProgramOperationInProgress
    }

    @MainActor
    func navigateToMiniProgram(
        from opener: DMPApp,
        appId rawAppId: String,
        path rawPath: String?,
        extraData: [String: Any]
    ) async throws {
        try await withMiniProgramOperation {
            let appId = rawAppId.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !appId.isEmpty else {
                throw DMPMiniProgramNavigationError.invalidAppId
            }
            guard getApp(appIndex: opener.getAppIndex()) === opener else {
                throw DMPMiniProgramNavigationError.sourceUnavailable
            }
            guard opener.getNavigator()?.isActiveNavigationOwner() == true else {
                throw DMPMiniProgramNavigationError.sourceNotPresented
            }
            guard opener.getNavigator()?.hasPageRouteOperationInProgress() != true else {
                throw DMPMiniProgramNavigationError.operationInProgress
            }
            guard appId != opener.getAppId() else {
                throw DMPMiniProgramNavigationError.cannotOpenSelf
            }
            guard let targetConfig = DMPResourceManager.getDMPAppConfig(appId: appId) else {
                throw DMPMiniProgramNavigationError.targetNotBundled(appId)
            }
            guard existApp(appId: appId) == nil else {
                throw DMPMiniProgramNavigationError.targetAlreadyRunning(appId)
            }
            guard let openerNavigator = opener.getNavigator(),
                  let navigationController = openerNavigator.navigationController else {
                throw DMPMiniProgramNavigationError.navigationControllerUnavailable
            }

            let hasRequestedPath = !(
                rawPath?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
            )
            let launchPath = (hasRequestedPath ? rawPath : targetConfig.path) ?? ""
            let urlData = DMPUtil.queryPath(path: launchPath)
            guard let pagePath = urlData["pagePath"] as? String, !pagePath.isEmpty else {
                throw DMPMiniProgramNavigationError.targetLaunchFailed(appId)
            }
            let query = urlData["query"] as? [String: Any]
            let preservedViewControllers = navigationController.viewControllers

            openerNavigator.suspendForMiniProgramNavigation()

            let target = appWithConfig(appConfig: targetConfig)
            target.getNavigator()?.setup(
                navigationController: navigationController,
                preserving: preservedViewControllers
            )

            let launchConfig = DMPLaunchConfig(
                appEntryPath: pagePath,
                query: query,
                launchAnimated: true,
                scene: DMPScene.fromMiniProgram.rawValue,
                referrerInfo: [
                    "appId": opener.getAppId(),
                    "extraData": extraData,
                ]
            )
            let launched = await target.launchForMiniProgramNavigation(
                launchConfig: launchConfig
            )
            guard launched else {
                target.destroy()
                opener.notifyAppShow()
                openerNavigator.reactivate()
                openerNavigator.resumeAfterMiniProgramNavigation()
                throw DMPMiniProgramNavigationError.targetLaunchFailed(appId)
            }

            setOpenerContext(
                MiniProgramOpenerContext(
                    openerAppIndex: opener.getAppIndex(),
                    targetAppId: target.getAppId()
                ),
                for: target.getAppIndex()
            )
        }
    }

    @MainActor
    func navigateBackMiniProgram(
        from target: DMPApp,
        extraData: [String: Any],
        onAccepted: () -> Void
    ) async throws {
        try await withMiniProgramOperation {
            guard let openerContext = openerContext(for: target.getAppIndex()) else {
                throw DMPMiniProgramNavigationError.notOpenedByMiniProgram
            }
            guard target.getNavigator()?.isActiveNavigationOwner() == true else {
                throw DMPMiniProgramNavigationError.sourceNotPresented
            }
            guard target.getNavigator()?.hasPageRouteOperationInProgress() != true else {
                throw DMPMiniProgramNavigationError.operationInProgress
            }
            guard getApp(appIndex: openerContext.openerAppIndex) != nil else {
                removeOpenerContext(for: target.getAppIndex())
                throw DMPMiniProgramNavigationError.openerUnavailable
            }

            removeOpenerContext(for: target.getAppIndex())
            // success + complete must cross the target service before teardown.
            // DMPService preserves enqueue order, so they also precede appHide.
            onAccepted()
            await closeMiniProgram(target)
            await target.service?.drainPendingContainerMessages()
            target.destroy()
            restoreOpener(openerContext, extraData: extraData)
        }
    }

    @MainActor
    func exitMiniProgram(
        _ app: DMPApp,
        onAccepted: () -> Void
    ) async throws {
        try await withMiniProgramOperation {
            guard getApp(appIndex: app.getAppIndex()) === app else {
                throw DMPMiniProgramNavigationError.sourceUnavailable
            }
            guard app.getNavigator()?.isActiveNavigationOwner() == true else {
                throw DMPMiniProgramNavigationError.sourceNotPresented
            }
            guard app.getNavigator()?.hasPageRouteOperationInProgress() != true else {
                throw DMPMiniProgramNavigationError.operationInProgress
            }
            let openerContext = removeOpenerContext(for: app.getAppIndex())
            // success + complete must reach the current service before appHide and
            // close/destroy tear down its callback registry.
            onAccepted()
            await closeMiniProgram(app)
            await app.service?.drainPendingContainerMessages()
            app.destroy()
            if let openerContext {
                // exit exposes the opener like a 1038 return, but unlike
                // navigateBackMiniProgram it carries no extraData field.
                restoreOpener(openerContext, extraData: nil)
            }
        }
    }

    @MainActor
    func restartMiniProgram(
        _ app: DMPApp,
        path: String,
        onAccepted: @escaping () -> Void
    ) async throws -> Bool {
        return try await withMiniProgramOperation {
            try validatePresentedSource(app)
            guard let launchConfig = app.makeRestartLaunchConfig(path: path) else {
                return false
            }
            return await app.restartRuntime(
                launchConfig: launchConfig,
                onAccepted: onAccepted
            )
        }
    }

    @MainActor
    func restartMiniProgramRuntime(
        _ app: DMPApp,
        launchConfig: DMPLaunchConfig,
        onAccepted: @escaping () -> Void
    ) async throws -> Bool {
        return try await withMiniProgramOperation {
            try validatePresentedSource(app)
            return await app.restartRuntime(
                launchConfig: launchConfig,
                onAccepted: onAccepted
            )
        }
    }

    @MainActor
    private func validatePresentedSource(_ app: DMPApp) throws {
        guard getApp(appIndex: app.getAppIndex()) === app else {
            throw DMPMiniProgramNavigationError.sourceUnavailable
        }
        guard app.getNavigator()?.isActiveNavigationOwner() == true else {
            throw DMPMiniProgramNavigationError.sourceNotPresented
        }
        guard app.getNavigator()?.hasPageRouteOperationInProgress() != true else {
            throw DMPMiniProgramNavigationError.operationInProgress
        }
    }

    @MainActor
    private func closeMiniProgram(_ app: DMPApp) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            guard let navigator = app.getNavigator() else {
                continuation.resume()
                return
            }
            navigator.closeMiniProgram {
                continuation.resume()
            }
        }
    }

    @MainActor
    private func restoreOpener(
        _ context: MiniProgramOpenerContext,
        extraData: [String: Any]?
    ) {
        guard let opener = notifyOpenerReturn(context, extraData: extraData),
              let openerNavigator = opener.getNavigator() else { return }
        openerNavigator.reactivate()
        openerNavigator.resumeAfterMiniProgramNavigation()
    }

    @MainActor
    @discardableResult
    private func notifyOpenerReturn(
        _ context: MiniProgramOpenerContext,
        extraData: [String: Any]?
    ) -> DMPApp? {
        guard let opener = getApp(appIndex: context.openerAppIndex) else { return nil }
        var referrerInfo: [String: Any] = ["appId": context.targetAppId]
        if let extraData {
            referrerInfo["extraData"] = extraData
        }
        opener.notifyAppShow(
            scene: DMPScene.fromMiniProgramBack.rawValue,
            referrerInfo: referrerInfo
        )
        return opener
    }

    // MARK: - Ext Module Registration

    /// 注册第三方扩展 bridge 模块（全局注册，对所有小程序生效）。
    ///
    /// 小程序通过 `wx.extBridge` / `wx.extOnBridge` / `wx.extOffBridge` 与 native 模块通信，
    /// 宿主在初始化后、启动小程序前调用此方法注册对应处理器。
    ///
    /// 示例：
    /// ```swift
    /// DMPAppManager.sharedInstance().registerExtModule("MyModule") { event, data, callback in
    ///     switch event {
    ///     case "getUserInfo":
    ///         callback.onSuccess(DMPMap(["name": "Alice"]))
    ///         return nil
    ///     case "onDataChange":
    ///         let token = startObserving { res in callback.onSuccess(res) }
    ///         return { stopObserving(token) }
    ///     default:
    ///         callback.onFail(DMPMap(["errMsg": "unknown event: \(event)"]))
    ///         return nil
    ///     }
    /// }
    /// ```
    ///
    /// - Parameters:
    ///   - moduleName: 模块名，与小程序侧 `module` 参数一致
    ///   - handler:    处理器，详见 `DMPExtModuleHandler`
    public func registerExtModule(_ moduleName: String, handler: @escaping DMPExtModuleHandler) {
        let apps = withStateLock {
            // 缓存起来，供后续新建的 App 初始化时使用
            pendingExtModules[moduleName] = handler
            return Array(appPools.values)
        }
        // 注册到所有已创建的 App 实例；不要持锁调用外部对象。
        apps.forEach { $0.registerExtModule(moduleName, handler: handler) }
    }

    /// 待注册的 ext 模块缓存，用于在 App 创建之前注册的模块能在 App 初始化后自动注入
    private var pendingExtModules: [String: DMPExtModuleHandler] = [:]

    /// 创建新 App 时自动注入已缓存的 ext 模块（内部使用）
    internal func applyPendingExtModules(to app: DMPApp) {
        let modules = withStateLock { pendingExtModules }
        modules.forEach { moduleName, handler in
            app.registerExtModule(moduleName, handler: handler)
        }
    }
}
