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
    public var service: DMPService? {
        didSet {
            guard service !== oldValue else { return }
            // 新 service 是新的 JS 运行时：bundle 还没求值，它自己随后会派发一次
            // App.onLaunch/onShow，所以送达状态回到「已显示」，等就绪再补差额。
            // 容器意图不动——换掉运行时不等于容器隐藏，重启期间到达的真实前后台变化
            // 记在 appVisibleDesired 上，由新运行时就绪时结算。
            appRuntimeReady = false
            appVisibleSent = true
        }
    }
    public var container: DMPContainer?
    public var containerApi: DMPContainerApi?

    private var isLaunching = false
    private var isDestroyed = false

    // App 级可见性账本。微信里 App.onShow/onHide 严格交替，同一个状态不会重复派发；
    // 而跨小程序打开的目标在启动窗口里还没有 service，此刻到达的系统前后台事件直接
    // 发出去就整条丢了，小程序会在后台以为自己仍在前台。账本只记两件事：容器认定的
    // 可见状态，和最后真正送达 service 的状态，两者不一致且 service 存在时才派发。
    // 起点是「已显示」：小程序启动本身就是一次 onShow，由 JS 侧自己派发。
    private var appVisibleDesired = true
    private var appVisibleSent = true
    // service.js / logic.js 求值之前 DiminaServiceBridge 还不存在，此刻投递的消息
    // 会在引擎队列里整条丢掉，所以就绪之前只记账不派发。
    private var appRuntimeReady = false
    // 宿主在后台时被交还展示关系的小程序：容器意图仍是不可见，这次恢复该带的 enter options
    // 先存在这里，等宿主真正回到前台、账本第一次派发 App.onShow 时一并交出去。
    private var pendingShowScene: Int?
    private var pendingShowReferrerInfo: [String: Any]?
    
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

        return await openPage(launchConfig: launchConfig)
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
            let operationToken = DMPRemoteUpdateManager.shared.operationToken(for: appId)
            Task {
                await DMPRemoteUpdateManager.shared.checkForUpdate(
                    app: self,
                    manifestUrl: manifestUrl,
                    operationToken: operationToken
                )
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

#if DEBUG
    func setBundleAppConfigForTesting(_ config: DMPBundleAppConfig?) {
        bundleAppConfig = config
    }
#endif

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
        if let packageConfig = DMPFileUtil.loadJSONFromFile(
            filePath: DMPSandboxManager.appBundleConfigPath(appId: appId)
        ) {
            appConfig?.versionCode = packageConfig["versionCode"] as? Int
            appConfig?.versionName = packageConfig["versionName"] as? String
        }

        await service?.loadFile(path: DMPSandboxManager.sdkServicePath())
        await service?.loadFile(path: DMPSandboxManager.appServicePath(appId: appId))
    }

    /// service 侧 App 实例已经存在，可以接生命周期消息了：把启动窗口期只记在账本里、
    /// 还没派发的可见性变化补上。
    ///
    /// 只有 `serviceResourceLoaded` 能给出这个保证。`loadFile` 返回时 logic.js 才刚被投给
    /// 引擎求值，App 实例要等 loader 的 `modRequire('app')` 才建出来；在那之前投递的 appHide
    /// 会被 service 侧 `runtime.appHide()` 的 `this.app` 判空静默丢掉。
    func markAppRuntimeReady() {
        appRuntimeReady = true
        flushAppVisibility()
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
    @discardableResult
    public func openPage(launchConfig: DMPLaunchConfig) async -> Bool {
        DMPLogger.debug("openPage")
        var newLaunchConfig = launchConfig
        // 尊重调用方指定的启动页（扫码/分享等场景从内页启动，此时导航栏按
        // 微信规则显示返回首页按钮）；未指定时回退到应用首页
        // 路径入口经 DMPUtil.normalizePagePath 统一去前导斜杠，与
        // DMPBundleAppConfig.entryPagePath 及页面栈 key 同口径
        newLaunchConfig.appEntryPath = resolvedEntryPath(for: launchConfig)
        currentLaunchConfig = newLaunchConfig
        guard let navigator else { return false }
        return await navigator.launch(to: newLaunchConfig.appEntryPath ?? "", query: newLaunchConfig.query)
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
        launchConfig.appEntryPath = nil
        launchConfig.isRelaunch = true
        do {
            guard try await DMPRemoteUpdateManager.shared.activatePendingUpdate(appId: appId) else {
                await notifyUpdateStatus(event: "updatefail")
                return
            }
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
            NetworkTypeAPI.clearApp(self.appId)
            ScreenAPI.clearApp(self.appId)
            FileAPI.clearOpenFiles(appId: self.appId)
            // 正在后台写盘的 canvas 导出属于这一代 runtime；换代之后它的回调没有接收方，
            // 已经发布的文件也不会有人来取。
            ImageAPI.clearApp(self.appId)
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

    @MainActor
    func notifyMiniProgramHide() {
        notifyMiniProgramHide(webViewId: getCurrentWebViewId())
    }

    @MainActor
    func notifyMiniProgramHide(webViewId: Int) {
        guard appVisibleDesired else { return }
        appVisibleDesired = false
        guard appRuntimeReady else { return }
        appVisibleSent = false
        if webViewId > 0 {
            navigator?.dispatchPageHide(webViewId: webViewId)
        }
        notifyAppHide()
    }

    /// 运行时整体销毁前把终态 App.onHide 交给旧 service。
    ///
    /// 这不是一次容器隐藏，所以只推进送达状态、不动 `appVisibleDesired`：重启期间到达的
    /// 系统前后台变化才是容器的真实意图，要留给新运行时结算。派发后旧 service 不再是有效
    /// 投递目标，`appRuntimeReady` 一并归假，避免这段窗口里的事件发给正在销毁的引擎。
    @MainActor
    func notifyRuntimeTeardownHide() {
        guard appRuntimeReady else { return }
        appRuntimeReady = false
        guard appVisibleSent else { return }
        appVisibleSent = false
        let webViewId = getCurrentWebViewId()
        if webViewId > 0 {
            navigator?.dispatchPageHide(webViewId: webViewId)
        }
        notifyAppHide()
    }

    @MainActor
    func notifyMiniProgramShow(scene: Int? = nil, referrerInfo: [String: Any]? = nil) {
        notifyMiniProgramShow(
            webViewId: getCurrentWebViewId(),
            scene: scene,
            referrerInfo: referrerInfo
        )
    }

    @MainActor
    func notifyMiniProgramShow(
        webViewId: Int,
        scene: Int? = nil,
        referrerInfo: [String: Any]? = nil
    ) {
        guard !appVisibleDesired else { return }
        appVisibleDesired = true
        guard appRuntimeReady else { return }
        appVisibleSent = true
        let options = consumePendingShow(scene: scene, referrerInfo: referrerInfo)
        notifyAppShow(scene: options.scene, referrerInfo: options.referrerInfo)
        guard webViewId > 0 else { return }
        navigator?.dispatchPageShow(webViewId: webViewId)
    }

    /// 宿主在后台时把这个小程序恢复成展示中的那一个。
    ///
    /// 这不是一次可见性变化——容器整体不可见，opener 也就没有显示——所以账本不动，只记下
    /// 这次恢复该带的 scene/referrerInfo。真正的 App.onShow 由宿主回到前台时派发，届时
    /// 这份 enter options 会覆盖掉调用方的默认值，把 1038 和 referrerInfo 带到正确的那条
    /// show 上。
    @MainActor
    func stashMiniProgramShow(scene: Int?, referrerInfo: [String: Any]?) {
        pendingShowScene = scene
        pendingShowReferrerInfo = referrerInfo
    }

    /// 取出并清空暂存的 enter options；没有暂存时原样返回调用方传入的值。
    private func consumePendingShow(
        scene: Int?,
        referrerInfo: [String: Any]?
    ) -> (scene: Int?, referrerInfo: [String: Any]?) {
        guard pendingShowScene != nil || pendingShowReferrerInfo != nil else {
            return (scene, referrerInfo)
        }
        let pending = (scene: pendingShowScene, referrerInfo: pendingShowReferrerInfo)
        pendingShowScene = nil
        pendingShowReferrerInfo = nil
        return pending
    }

    /// 结算账本：service 缺席期间记下的可见性变化，在新 service 出现时补发。
    /// 只补 App 级事件——页面级的 show/hide 由当时的页面栈决定，缺席期间那些
    /// 页面并不存在，补发一条针对旧 webViewId 的消息只会送到已经没了的页面。
    private func flushAppVisibility() {
        guard appRuntimeReady, appVisibleSent != appVisibleDesired else { return }
        appVisibleSent = appVisibleDesired
        if appVisibleDesired {
            let options = consumePendingShow(scene: nil, referrerInfo: nil)
            notifyAppShow(scene: options.scene, referrerInfo: options.referrerInfo)
        } else {
            notifyAppHide()
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

    /// Requests a normal mini-program exit from the host application.
    ///
    /// Unlike `destroy()`, this first closes the owned pages through the navigator, delivers the
    /// Page/App hide sequence, and restores a live opener mini program when one exists.
    @MainActor
    public func closeMiniProgram() async throws {
        try await DMPAppManager.sharedInstance().exitMiniProgram(self, onAccepted: {})
    }

    @MainActor
    public func destroy() {
        guard !isDestroyed else {
            return
        }
        isDestroyed = true
        DMPLogger.debug("app destroy")
        BluetoothAPIManager.shared.clearApp(appId)
        LocalNetworkAPIManager.shared.clearApp(appId)
        NetworkAPI.clearApp(appId)
        NetworkTypeAPI.clearApp(appId)
        ScreenAPI.clearApp(appId)
        FileAPI.clearOpenFiles(appId: appId)
        ImageAPI.clearApp(appId)

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
