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
    
    public var render: DMPRender?
    public var service: DMPService?
    public var container: DMPContainer?
    public var containerApi: DMPContainerApi?
    
    public init(appConfig: DMPAppConfig, appIndex: Int) {
        self.appConfig = appConfig
        self.appId = appConfig.appId
        self.appIndex = appIndex
    }

    @MainActor
    public func launch(launchConfig: DMPLaunchConfig) async {
        showLoading()
        initBundle()

        initContainer()

        await initService()

        await loadBundle()

        initRender()
        
        await openPage(launchConfig: launchConfig)

        hideLoading()
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
        print("initBundle")
        DMPSandboxManager.initBundleDirectoryForApp(appId: appId)
        DMPResourceManager.prepareSdk()
        DMPResourceManager.prepareApp(appId: appId)
    }

    public func initContainer() {
        print("initContainer")
        DMPStorage.setupModule(appId: appId)        
        DMPUIManager.shared.prepareUI()
        container = DMPContainer(app: self)
        containerApi = DMPContainerApi.create(app: self)
    }

    @MainActor
    public func initRender() {
        print("initRender")
        render = DMPRender(app: self)
        
        // Pre-warm WebView pool to improve first page opening speed
        DMPWebViewPool.shared.warmUp()
    }

    public func loadBundle() async {
        print("loadBundle")
        // Inject custom API namespaces before loading service.js
        let namespaces = DMPAppManager.sharedInstance().apiNamespaces
        if !namespaces.isEmpty {
            let json = namespaces.map { "\"\($0)\"" }.joined(separator: ",")
            await service?.evaluateScript("globalThis.__diminaApiNamespaces = [\(json)]")
        }
        await service?.loadFile(path: DMPSandboxManager.sdkServicePath())
        await service?.loadFile(path: DMPSandboxManager.appServicePath(appId: appId))

        let path = DMPSandboxManager.appConfigPath(appId: appId)
        let config = DMPFileUtil.readJsonFile(at: path)
        print("config: \(String(describing: config))")
        self.bundleAppConfig = DMPBundleAppConfig.fromJsonString(json: config)
    }

    @MainActor
    public func openPage(launchConfig: DMPLaunchConfig) async {
        print("openPage")
        var newLaunchConfig = launchConfig
        newLaunchConfig.appEntryPath = self.bundleAppConfig?.entryPagePath ?? ""
        await navigator?.launch(to: newLaunchConfig.appEntryPath ?? "", query: newLaunchConfig.query)
    }

    public func showLoading() {
        print("showLoading")
    }

    public func hideLoading() {
        print("hideLoading")
    } 

    public func destroy() {
        print("app destroy")
        
        // Clear WebView cache pool (execute on main thread)
        Task { @MainActor in
            DMPWebViewPool.shared.clearPool()
        }
        
        DMPStorage.teardownModule()
        
        DMPAppManager.sharedInstance().removeApp(appId: appId)
        service?.destroy()
    }
}
