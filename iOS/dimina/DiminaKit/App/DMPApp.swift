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
        guard !isLaunching else {
            DMPLogger.debug("launch skipped: app is already launching")
            return
        }

        isLaunching = true
        defer {
            isLaunching = false
        }

        guard await prepareRuntimeForLaunch(initializeContainer: true) else {
            return
        }

        await openPage(launchConfig: launchConfig)
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
        let requestedEntry = launchConfig.appEntryPath?.trimmingCharacters(in: .whitespaces) ?? ""
        let normalizedEntry = DMPUtil.normalizePagePath(requestedEntry)
        newLaunchConfig.appEntryPath = normalizedEntry.isEmpty
            ? (self.bundleAppConfig?.entryPagePath ?? "")
            : normalizedEntry
        currentLaunchConfig = newLaunchConfig
        await navigator?.launch(to: newLaunchConfig.appEntryPath ?? "", query: newLaunchConfig.query)
    }

    @MainActor
    public func applyUpdate() async {
        var launchConfig = currentLaunchConfig ?? DMPLaunchConfig()
        launchConfig.isRelaunch = true
        await restart(launchConfig: launchConfig)
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
        await restart(launchConfig: launchConfig)
    }

    @MainActor
    private func restart(launchConfig: DMPLaunchConfig) async {
        guard !isLaunching, !isDestroyed else {
            DMPLogger.debug("restart skipped: app is launching or destroyed")
            return
        }

        isLaunching = true
        defer {
            isLaunching = false
        }

        await navigator?.reloadMiniProgram(animated: false) {
            BluetoothAPIManager.shared.clearApp(self.appId)
            LocalNetworkAPIManager.shared.clearApp(self.appId)
            self.container?.resetForReload()

            self.service?.destroy()
            self.service = nil
            self.render = nil
            self.bundleAppConfig = nil
            self.currentLaunchConfig = nil

            guard await self.prepareRuntimeForLaunch(initializeContainer: false) else {
                return nil
            }
            return launchConfig
        }
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

        let serviceToDestroy = service
        let containerToDestroy = container

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
