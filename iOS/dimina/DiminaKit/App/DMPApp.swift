//
//  DMPApp.swift
//  dimina
//
//  Created by Lehem on 2025/4/17.
//

import Foundation

public class DMPApp {
    private var appId: String
    private var appIndex: Int
    private var appConfig: DMPAppConfig?
    
    private lazy var navigator: DMPNavigator? = DMPNavigator(app: self)

    private var bundleAppConfig: DMPBundleAppConfig?
    private var currentLaunchConfig: DMPLaunchConfig?
    
    public var render: DMPRender?
    public var service: DMPService?
    public var container: DMPContainer?
    public var containerApi: DMPContainerApi?

    private var isLaunching = false
    private var isDestroyed = false
    
    public init(appConfig: DMPAppConfig, appIndex: Int) {
        self.appConfig = appConfig
        self.appId = appConfig.appId
        self.appIndex = appIndex
    }

    /// 小程序包的 `versionCode`，未知时是 `0`。用于容器注入的 `Referer`。
    func jsAppVersion() -> String {
        return String(appConfig?.versionCode ?? 0)
    }

    @MainActor
    public func launch(launchConfig: DMPLaunchConfig) async {
        _ = await performLaunch(launchConfig: launchConfig)
    }

    /// Same cold-launch path as `launch`, but reports whether the runtime was
    /// actually prepared. Cross-mini-program navigation uses this to roll the
    /// opener back into the foreground when target startup fails.
    @MainActor
    @discardableResult
    func launchForMiniProgramNavigation(launchConfig: DMPLaunchConfig) async -> Bool {
        return await performLaunch(launchConfig: launchConfig)
    }

    @MainActor
    private func performLaunch(launchConfig: DMPLaunchConfig) async -> Bool {
        guard !isLaunching else {
            DMPLogger.debug("launch skipped: app is already launching")
            return false
        }

        isLaunching = true
        defer {
            isLaunching = false
        }

        guard await prepareRuntimeForLaunch(initializeContainer: true) else {
            return false
        }

        let entryPath = resolvedEntryPath(for: launchConfig)
        guard bundleAppConfig?.runtimeType == "game"
                || bundleAppConfig?.isContainsPage(pagePath: entryPath) == true else {
            DMPLogger.debug("launch rejected: page is not declared: \(entryPath)")
            return false
        }

        await openPage(launchConfig: launchConfig)
        return true
    }

    @MainActor
    private func prepareRuntimeForLaunch(initializeContainer: Bool) async -> Bool {
        await Self.prepareBundleResources(appId: appId)

        let installedInitialPackage: Bool
        do {
            installedInitialPackage = try await DMPRemoteUpdateManager.shared
                .installInitialPackageIfNeeded(
                    appId: appId,
                    manifestUrl: appConfig?.updateManifestUrl
                )
        } catch {
            DMPLogger.debug("Initial package install failed: \(error)")
            return false
        }

        if initializeContainer {
            initContainer()
        }

        await initService()
        await loadBundle()

        if installedInitialPackage {
            await notifyUpdateStatus(event: "noupdate")
        } else if let manifestUrl = appConfig?.updateManifestUrl,
           !manifestUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Task {
                await DMPRemoteUpdateManager.shared.checkForUpdate(app: self, manifestUrl: manifestUrl)
            }
        } else {
            await notifyUpdateStatus(event: "noupdate")
        }

        initRender()
        return true
    }

    public func initService() async {
        service = DMPService(app: self)
    }

    public func getNavigator() -> DMPNavigator? {
        return navigator
    }

    public func getService() -> DMPService? {
        return service
    }

    public func getAppConfig() -> DMPAppConfig? {
        return appConfig
    }

    public func getCurrentWebViewId() -> Int {
        return navigator?.getTopPageRecord()?.webViewId ?? -1
    }

    public func getAppId() -> String {
        return appId
    }

    public func getAppIndex() -> Int {
        return appIndex
    }
        
    public func getBundleAppConfig() -> DMPBundleAppConfig? {
        return bundleAppConfig
    }

    func getCurrentLaunchConfig() -> DMPLaunchConfig? {
        return currentLaunchConfig
    }
    
    public func getContainer() -> DMPContainer? {
        return container
    }
    
    public func initBundle() {
        DMPLogger.debug("initBundle")
        DMPResourceManager.prepareSdk()
        DMPResourceManager.prepareApp(appId: appId)
        DMPSandboxManager.initBundleDirectoryForApp(appId: appId)
    }

    private static func prepareBundleResources(appId: String) async {
        await Task.detached(priority: .userInitiated) {
            DMPResourceManager.prepareSdk()
            DMPResourceManager.prepareApp(appId: appId)
            DMPSandboxManager.initBundleDirectoryForApp(appId: appId)
        }.value
    }

    public func initContainer() {
        DMPLogger.debug("initContainer")
        DMPStorage.setupModule(appId: appId)        
        DMPUIManager.shared.prepareUI()
        container = DMPContainer(app: self)
        containerApi = DMPContainerApi.create(app: self)
        // appWithConfig is called before the target container exists, so its
        // early replay cannot install host APIs. Replay whenever a fresh
        // container is created, including full-runtime restart.
        DMPAppManager.sharedInstance().applyPendingExtModules(to: self)
    }

    @MainActor
    public func initRender() {
        DMPLogger.debug("initRender")
        render = DMPRender(app: self)
        
        // Pre-warm WebView pool to improve first page opening speed
        DMPWebViewPool.shared.warmUp(appId: appId)
    }

    public func loadBundle() async {
        DMPLogger.debug("loadBundle")
        // Inject custom API namespaces before loading service.js
        let namespaces = DMPAppManager.sharedInstance().apiNamespaces
        if !namespaces.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject: namespaces),
           let json = String(data: data, encoding: .utf8) {
            await service?.evaluateScript("globalThis.__diminaApiNamespaces = \(json)")
        }
        // 注入已注册的 API 名字，使 service 层的 wx 对象能枚举到它们
        let registeredApis = DMPContainerApi.getAllRegisteredMethods()
        if !registeredApis.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject: registeredApis),
           let json = String(data: data, encoding: .utf8) {
            await service?.evaluateScript("globalThis.__diminaRegisteredApis = \(json)")
        }
        // 顺序承重，不要把这段挪到下面两次 loadFile 之后：logic.js 一被求值，小程序自己的
        // 代码就有机会跑，而它读到的容器状态里必须已经有 app.json（比如 connectSocket 要按
        // networkTimeout.connectSocket 定超时，缺了就会静默落到 60000）。当前编译产物把小程序
        // 代码都包在 modDefine 工厂里、顶层无副作用，所以即使顺序反过来也碰巧不出事——但那是
        // 产物形状的巧合，不是保证。先解析配置再求值脚本，这条边界才是结构性关掉的。
        let path = DMPSandboxManager.appConfigPath(appId: appId)
        let config = DMPFileUtil.readJsonFile(at: path)
        DMPLogger.debug("config: \(String(describing: config))")
        self.bundleAppConfig = DMPBundleAppConfig.fromJsonString(json: config)

        await service?.loadFile(path: DMPSandboxManager.sdkServicePath())
        await service?.loadFile(path: DMPSandboxManager.appServicePath(appId: appId))
    }

    func notifyUpdateStatus(event: String) async {
        let message = DMPMap([
            "type": "onUpdateStatusChange",
            "body": [
                "event": event,
            ],
        ])
        await service?.postMessage(data: message)
    }

    @MainActor
    public func openPage(launchConfig: DMPLaunchConfig) async {
        DMPLogger.debug("openPage")
        var newLaunchConfig = launchConfig
        // 尊重调用方指定的启动页（扫码/分享等场景从内页启动，此时导航栏按
        // 微信规则显示返回首页按钮）；未指定时回退到应用首页
        // 路径入口经 DMPUtil.normalizePagePath 统一去前导斜杠，与
        // DMPBundleAppConfig.entryPagePath 及页面栈 key 同口径
        newLaunchConfig.appEntryPath = resolvedEntryPath(for: launchConfig)
        currentLaunchConfig = newLaunchConfig
        await navigator?.launch(to: newLaunchConfig.appEntryPath ?? "", query: newLaunchConfig.query)
    }

    private func resolvedEntryPath(for launchConfig: DMPLaunchConfig) -> String {
        if bundleAppConfig?.runtimeType == "game" {
            return bundleAppConfig?.entryPagePath ?? "game"
        }
        let requestedEntry = launchConfig.appEntryPath?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalizedEntry = DMPUtil.normalizePagePath(requestedEntry)
        return normalizedEntry.isEmpty
            ? (bundleAppConfig?.entryPagePath ?? "")
            : normalizedEntry
    }

    @MainActor
    public func applyUpdate() async {
        var launchConfig = currentLaunchConfig ?? DMPLaunchConfig()
        launchConfig.isRelaunch = true
        do {
            _ = try await DMPAppManager.sharedInstance().restartMiniProgramRuntime(
                self,
                launchConfig: launchConfig,
                onAccepted: {}
            )
        } catch {
            DMPLogger.debug("applyUpdate restart rejected: \(error.localizedDescription)")
        }
    }

    /// Restart the complete mini-program runtime at the caller-supplied path.
    /// Existing scene/referrer options are retained, while path/query are
    /// replaced. This intentionally goes through service/render/container
    /// teardown plus `DMPNavigator.reloadMiniProgram`, not page-level relaunch.
    @MainActor
    @discardableResult
    public func restartMiniProgram(
        path: String,
        onAccepted: @escaping () -> Void
    ) async -> Bool {
        do {
            return try await DMPAppManager.sharedInstance().restartMiniProgram(
                self,
                path: path,
                onAccepted: onAccepted
            )
        } catch {
            DMPLogger.debug("restartMiniProgram rejected: \(error.localizedDescription)")
            return false
        }
    }

    func makeRestartLaunchConfig(path: String) -> DMPLaunchConfig? {
        let urlData = DMPUtil.queryPath(path: path)
        guard let pagePath = urlData["pagePath"] as? String, !pagePath.isEmpty else {
            return nil
        }
        guard bundleAppConfig?.isContainsPage(pagePath: pagePath) == true else {
            return nil
        }
        var launchConfig = currentLaunchConfig ?? DMPLaunchConfig()
        launchConfig.appEntryPath = pagePath
        launchConfig.query = urlData["query"] as? [String: Any]
        launchConfig.isRelaunch = true
        return launchConfig
    }

    /// Cold-reload the current mini program from its configured entry page.
    /// Persistent storage is intentionally retained; service, page, render,
    /// bridge-resource, and transient API state are recreated.
    @MainActor
    public func reEnter() async {
        let entryPath = bundleAppConfig?.entryPagePath ?? currentLaunchConfig?.appEntryPath ?? ""
        let launchConfig = DMPLaunchConfig(
            appEntryPath: entryPath,
            query: nil,
            isRelaunch: true
        )
        do {
            _ = try await DMPAppManager.sharedInstance().restartMiniProgramRuntime(
                self,
                launchConfig: launchConfig,
                onAccepted: {}
            )
        } catch {
            DMPLogger.debug("reEnter restart rejected: \(error.localizedDescription)")
        }
    }

    @MainActor
    @discardableResult
    func restartRuntime(
        launchConfig: DMPLaunchConfig,
        onAccepted: (() -> Void)? = nil
    ) async -> Bool {
        let entryPath = resolvedEntryPath(for: launchConfig)
        guard bundleAppConfig?.isContainsPage(pagePath: entryPath) == true else {
            DMPLogger.debug("restart rejected: page is not declared: \(entryPath)")
            return false
        }
        guard !isLaunching, !isDestroyed else {
            DMPLogger.debug("restart skipped: app is launching or destroyed")
            return false
        }

        isLaunching = true
        defer {
            isLaunching = false
        }

        return await navigator?.reloadMiniProgram(
            animated: false,
            onAccepted: {
                // The callback id belongs to the old service. Enqueue success
                // and complete at this commit point, before presentation-out
                // lifecycle and all old-runtime teardown.
                onAccepted?()
            }
        ) {
            await self.service?.drainPendingContainerMessages()
            BluetoothAPIManager.shared.clearApp(self.appId)
            LocalNetworkAPIManager.shared.clearApp(self.appId)
            NetworkAPI.clearApp(self.appId)
            DMPWebSocketManager.shared.disposeOwner(appId: self.appId)
            let registeredExtModules = self.container?.extModules ?? [:]
            self.container?.resetForReload()

            self.service?.destroy()
            self.service = nil
            self.render = nil
            self.container = nil
            self.containerApi = nil
            self.bundleAppConfig = nil
            self.currentLaunchConfig = nil

            guard await self.prepareRuntimeForLaunch(initializeContainer: true) else {
                return nil
            }
            registeredExtModules.forEach { moduleName, handler in
                self.container?.registerExtModule(moduleName, handler: handler)
            }
            return launchConfig
        } ?? false
    }

    func notifyAppHide() {
        DMPChannelProxy.containerToService(
            msg: DMPMap(["type": "appHide", "body": [String: Any]()]),
            app: self
        )
    }

    func notifyAppShow(scene: Int? = nil, referrerInfo: [String: Any]? = nil) {
        var body: [String: Any] = [:]
        if let pageRecord = navigator?.getTopPageRecord() {
            body["path"] = pageRecord.pagePath
            body["query"] = pageRecord.query ?? [:]
        } else if let path = currentLaunchConfig?.appEntryPath {
            body["path"] = path
            body["query"] = currentLaunchConfig?.query ?? [:]
        }
        body["scene"] = scene
            ?? currentLaunchConfig?.scene
            ?? DMPScene.fromMainEntry.rawValue
        if let referrerInfo = referrerInfo ?? currentLaunchConfig?.referrerInfo {
            body["referrerInfo"] = referrerInfo
        }
        DMPChannelProxy.containerToService(
            msg: DMPMap(["type": "appShow", "body": body]),
            app: self
        )
    }

    /// 注册第三方扩展 bridge 模块。
    ///
    /// 小程序通过 `wx.extBridge` / `wx.extOnBridge` / `wx.extOffBridge` 与 native 模块通信，
    /// 宿主通过此方法（或 `DMPAppManager.registerExtModule`）向框架注册对应处理器。
    ///
    /// - Parameters:
    ///   - moduleName: 模块名，与小程序侧 `module` 参数一致
    ///   - handler:    处理器，详见 `DMPExtModuleHandler`
    public func registerExtModule(_ moduleName: String, handler: @escaping DMPExtModuleHandler) {
        container?.registerExtModule(moduleName, handler: handler)
    }

    public func destroy() {
        guard !isDestroyed else {
            return
        }
        isDestroyed = true
        DMPLogger.debug("app destroy")
        BluetoothAPIManager.shared.clearApp(appId)
        LocalNetworkAPIManager.shared.clearApp(appId)
        NetworkAPI.clearApp(appId)

        let serviceToDestroy = service
        let containerToDestroy = container

        // Invalidate the engine -> app generation before making any runtime
        // field nil. The app can still be strongly held by its caller while
        // asynchronous engine teardown is pending.
        serviceToDestroy?.invalidateAppBinding()

        service = nil
        container = nil
        containerApi = nil
        render = nil

        DMPAppManager.sharedInstance().removeApp(appId: appId)

        // 清理第三方扩展的持续订阅，防止内存泄漏
        containerToDestroy?.clearExtSubscriptions()

        // Storage is a global singleton. Tear it down before another app initializes it.
        DMPStorage.teardownModule(appId: appId)

        // DMPWebSocketManager is a cross-app singleton too; ARC won't clear
        // this app's sockets/listeners/timers for us, so tear them down
        // explicitly (synchronous + silent, see DMPWebSocketManager.disposeOwner).
        DMPWebSocketManager.shared.disposeOwner(appId: appId)

        DispatchQueue.global(qos: .utility).async {
            serviceToDestroy?.destroy()
        }
    }
}
