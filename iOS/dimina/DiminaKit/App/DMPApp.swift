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

    private(set) var pageCapsuleProvider: DMPPageCapsuleProvider?

    private var isLaunching = false
    private var isDestroyed = false
    private var pendingApiRegistrations: [(DMPApiHandler, DMPApiConflictPolicy)] = []
    
    public init(appConfig: DMPAppConfig, appIndex: Int) {
        self.appConfig = appConfig
        self.appId = appConfig.appId
        self.appIndex = appIndex
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

        await Self.prepareBundleResources(appId: appId)

        initContainer()

        await initService()

        await loadBundle()

        if let manifestUrl = appConfig?.updateManifestUrl,
           !manifestUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Task {
                await DMPRemoteUpdateManager.shared.checkForUpdate(app: self, manifestUrl: manifestUrl)
            }
        } else {
            await notifyUpdateStatus(event: "noupdate")
        }

        initRender()
        
        await openPage(launchConfig: launchConfig)

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

    /// Registers host APIs for this mini app.
    ///
    /// Register APIs before calling `launch`. Registrations are scoped to this
    /// `DMPApp` and are released when the app is destroyed.
    @discardableResult
    public func registerApi(
        _ handler: DMPApiHandler,
        conflictPolicy: DMPApiConflictPolicy = .reject
    ) -> Bool {
        guard !isLaunching, containerApi == nil, !isDestroyed else {
            DMPLogger.debug("registerApi skipped: APIs must be registered before launch")
            return false
        }
        guard !handler.apiNames.isEmpty else {
            DMPLogger.debug("registerApi skipped: handler has no API names")
            return false
        }

        pendingApiRegistrations.append((handler, conflictPolicy))
        return true
    }

    /// Registers a host-provided replacement for the built-in page capsule.
    ///
    /// Register the provider before calling `launch`. The provider is scoped to
    /// this `DMPApp` and is released when the app is destroyed.
    @MainActor
    @discardableResult
    public func registerPageCapsuleProvider(_ provider: DMPPageCapsuleProvider) -> Bool {
        guard !isLaunching, container == nil, !isDestroyed else {
            DMPLogger.debug(
                "registerPageCapsuleProvider skipped: provider must be registered before launch"
            )
            return false
        }
        guard pageCapsuleProvider == nil else {
            DMPLogger.debug("registerPageCapsuleProvider skipped: provider is already registered")
            return false
        }

        pageCapsuleProvider = provider
        return true
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
        if let containerApi {
            for (handler, conflictPolicy) in pendingApiRegistrations {
                let conflicts = containerApi.registerCustomAPI(
                    handler,
                    conflictPolicy: conflictPolicy
                )
                if !conflicts.isEmpty {
                    DMPLogger.debug(
                        "registerApi rejected conflicting methods: \(conflicts.sorted())"
                    )
                }
            }
        }
        pendingApiRegistrations.removeAll()
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
        let registeredApis = containerApi?.getAllRegisteredMethods() ?? []
        if !registeredApis.isEmpty,
           let data = try? JSONSerialization.data(withJSONObject: registeredApis),
           let json = String(data: data, encoding: .utf8) {
            await service?.evaluateScript("globalThis.__diminaRegisteredApis = \(json)")
        }
        await service?.loadFile(path: DMPSandboxManager.sdkServicePath())
        await service?.loadFile(path: DMPSandboxManager.appServicePath(appId: appId))

        let path = DMPSandboxManager.appConfigPath(appId: appId)
        let config = DMPFileUtil.readJsonFile(at: path)
        DMPLogger.debug("config: \(String(describing: config))")
        self.bundleAppConfig = DMPBundleAppConfig.fromJsonString(json: config)
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
        let requestedPath = launchConfig.appEntryPath ?? ""
        let entryPath = requestedPath.isEmpty
            ? bundleAppConfig?.entryPagePath ?? ""
            : requestedPath
        let route = DMPPageRoute(path: entryPath)

        var resolvedConfig = launchConfig
        resolvedConfig.appEntryPath = route.pagePath
        resolvedConfig.query = route.merging(query: launchConfig.query)
        currentLaunchConfig = resolvedConfig

        await navigator?.launch(to: route.pagePath, query: resolvedConfig.query)
    }

    @MainActor
    public func applyUpdate() async {
        let launchConfig = currentLaunchConfig
        service?.destroy()
        await initService()
        await loadBundle()

        let entryPath = launchConfig?.appEntryPath ?? bundleAppConfig?.entryPagePath ?? ""
        await navigator?.relaunch(to: entryPath, query: launchConfig?.query, animated: false)
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
        pendingApiRegistrations.removeAll()
        render = nil
        pageCapsuleProvider = nil

        DMPAppManager.sharedInstance().removeApp(appId: appId)

        // 清理第三方扩展的持续订阅，防止内存泄漏
        containerToDestroy?.clearExtSubscriptions()

        // Storage is a global singleton. Tear it down before another app initializes it.
        DMPStorage.teardownModule(appId: appId)

        DispatchQueue.global(qos: .utility).async {
            serviceToDestroy?.destroy()
        }
    }
}
