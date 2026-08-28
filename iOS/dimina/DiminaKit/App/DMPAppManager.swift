//
//  DMPAppManager.swift
//  dimina
//
//  Created by Lehem on 2025/4/28.
//

import Foundation
import UIKit

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
    /// 宿主自己的前后台状态，由 [setupSystemLifecycleObservers] 维护。跨小程序恢复 opener
    /// 时要看它，而不是看「谁在展示」——后者在宿主后台里同样会变。
    @MainActor private var hostVisible = true

    private var systemLifecycleObservers: [NSObjectProtocol] = []

    private init() {
        setupSystemLifecycleObservers()
    }

    deinit {
        systemLifecycleObservers.forEach(NotificationCenter.default.removeObserver)
    }

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

    /// UIApplication has exactly one foreground scene worth caring about here (no split-screen /
    /// Stage Manager support in this container), so the *whole* pool's system background verdict
    /// funnels through the one mini program actually on screen - the DMPApp whose navigator
    /// currently owns the shared UINavigationController. Suspended openers behind it are, by
    /// definition, already hidden (see [DMPNavigator.notifyPresentOut]) and receive nothing here.
    ///
    /// 这两个通知也是宿主可见性的唯一来源。跨小程序返回可以发生在宿主已经进后台之后
    /// （目标启动失败、或返回操作在后台完成），那时把 opener 恢复成展示中的小程序并不等于
    /// 它可见，所以 [hostVisible] 要独立于「谁在展示」记住宿主自己的前后台状态。
    private func setupSystemLifecycleObservers() {
        let center = NotificationCenter.default
        systemLifecycleObservers = [
            center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.hostVisible = false
                    self?.activePresentedApp()?.notifyMiniProgramHide()
                }
            },
            center.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                Task { @MainActor in
                    self?.hostVisible = true
                    self?.activePresentedApp()?.notifyMiniProgramShow()
                }
            },
        ]
    }

    /// The one DMPApp whose navigator currently owns the shared UINavigationController - the
    /// mini program actually on screen. `nil` when nothing is presented (e.g. an empty pool, or
    /// mid owner hand-off).
    @MainActor
    private func activePresentedApp() -> DMPApp? {
        stateLock.lock()
        let apps = Array(appPools.values)
        stateLock.unlock()
        return apps.first { $0.getNavigator()?.isActiveNavigationOwner() == true }
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

    /// Stops a running mini program and removes its installed package. Persistent
    /// Storage/FileSystem data is retained unless `clearUserData` is true.
    @MainActor
    public func uninstallMiniProgram(
        appId rawAppId: String,
        clearUserData: Bool = false
    ) async throws {
        let appId = rawAppId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !appId.isEmpty else {
            throw DMPMiniProgramNavigationError.invalidAppId
        }

        try DMPRemoteUpdateManager.shared.beginUninstall(appId: appId)
        defer { DMPRemoteUpdateManager.shared.endUninstall(appId: appId) }

        try await withMiniProgramOperation {
            if let app = existApp(appId: appId) {
                await closeMiniProgram(app)
                app.destroy()
            }
            FileAPI.clearOpenFiles(appId: appId)
            if clearUserData {
                DMPStorage.storage(for: appId).clearAllStorage()
            }
            DMPStorage.teardownModule(appId: appId)
            try await DMPRemoteUpdateManager.shared.uninstallPackage(
                appId: appId,
                clearUserData: clearUserData
            )
        }
    }

    @discardableResult
    private func removeOpenerContext(for targetAppIndex: Int) -> MiniProgramOpenerContext? {
        return withStateLock {
            miniProgramOpeners.removeValue(forKey: targetAppIndex)
        }
    }

    /// Establishes the same opener/target relationship `navigateToMiniProgram`
    /// records after a successful launch, without requiring a real bundled
    /// launch. Exists so tests can exercise `navigateBackMiniProgram` /
    /// `exitMiniProgram`'s opener-restoration paths directly.
    func markOpenedByMiniProgramForTesting(target: DMPApp, opener: DMPApp) {
        setOpenerContext(
            MiniProgramOpenerContext(
                openerAppIndex: opener.getAppIndex(),
                targetAppId: target.getAppId()
            ),
            for: target.getAppIndex()
        )
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

    /// 宿主前后台状态的只读视图。系统通知是异步送达的，测试用它确认通知已经生效，
    /// 再驱动依赖这个真相的跨小程序恢复路径。
    @MainActor
    func isHostVisibleForTesting() -> Bool {
        return hostVisible
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
                openerNavigator.reactivate()
                openerNavigator.resumeAfterMiniProgramNavigation(hostVisible: hostVisible)
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
        guard let opener = getApp(appIndex: context.openerAppIndex),
              let openerNavigator = opener.getNavigator() else { return }
        var referrerInfo: [String: Any] = ["appId": context.targetAppId]
        if let extraData {
            referrerInfo["extraData"] = extraData
        }
        openerNavigator.reactivate()
        openerNavigator.resumeAfterMiniProgramNavigation(
            scene: DMPScene.fromMiniProgramBack.rawValue,
            referrerInfo: referrerInfo,
            hostVisible: hostVisible
        )
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
