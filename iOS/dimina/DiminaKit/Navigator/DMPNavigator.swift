//
//  DMPNavigator.swift
//  dimina
//
//  Created by Lehem on 2025/4/17.
//

import Foundation
import ObjectiveC
import SwiftUI
import UIKit

// 用于存储关联对象的键
private var navigatorAssociationKey: UInt8 = 0

/// DMPNavigator 是一个导航管理器，用于接管整个应用的导航动作
public class DMPNavigator: NSObject {
    // app 弱引用
    private weak var app: DMPApp?

    // 页面生命周期管理
    private lazy var pageLifecycle: DMPPageLifecycle? = DMPPageLifecycle(app: app!)

    // 当前的导航控制器
    public private(set) weak var navigationController: UINavigationController?

    // 页面记录
    private var pageRecords: [DMPPageRecord] = []
    @MainActor private var pageRouteOperationDepth = 0
    private weak var tabBarContainerController: DMPTabBarContainerController?
    // 跨小程序打开时，目标和 opener 共用同一个 UINavigationController。
    // 这个快照是目标小程序的导航边界：close/reload/relaunch 只能处理
    // 快照之后追加的页面，不能把 opener 的页面当成自己的宿主根页清掉。
    private var miniProgramBaseViewControllers: [UIViewController]?
    // 胶囊属于小程序容器，而不是某个页面。固定挂在 UINavigationController.view
    // 上可避免 push/pop 时新旧页面各携带一份胶囊参与转场。
    private var capsuleView: UIView?
    private weak var capsuleMoreButton: UIButton?
    private weak var capsuleCloseButton: UIButton?

    // 公开初始化方法
    public init(app: DMPApp? = nil) {
        self.app = app
        super.init()
    }

    public func setup(navigationController: UINavigationController) {
        miniProgramBaseViewControllers = nil
        attach(to: navigationController)
    }

    func setup(
        navigationController: UINavigationController,
        preserving baseViewControllers: [UIViewController]
    ) {
        miniProgramBaseViewControllers = baseViewControllers
        attach(to: navigationController)
    }

    func reactivate() {
        guard let navigationController else { return }
        attach(to: navigationController)
    }

    /// The navigation controller is shared while one mini program presents
    /// another. Only the navigator currently installed as its associated owner
    /// may mutate that stack; suspended opener runtimes remain alive and can
    /// otherwise issue stale route calls from timers or async callbacks.
    @MainActor
    func isActiveNavigationOwner() -> Bool {
        guard let navigationController else { return false }
        return (objc_getAssociatedObject(
            navigationController,
            &navigatorAssociationKey
        ) as? DMPNavigator) === self
    }

    @MainActor
    func hasPageRouteOperationInProgress() -> Bool {
        return pageRouteOperationDepth > 0
    }

    private func attach(to navigationController: UINavigationController) {
        capsuleView?.removeFromSuperview()
        capsuleView = nil
        navigationController.view.subviews
            .filter { $0.accessibilityIdentifier == "dimina.navigation.capsule" }
            .forEach { $0.removeFromSuperview() }
        self.navigationController = navigationController

        objc_setAssociatedObject(
            navigationController, &navigatorAssociationKey, self, .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )

        // 禁用系统返回手势
        navigationController.interactivePopGestureRecognizer?.isEnabled = false
        installCapsule(in: navigationController)
    }

    func setCapsuleVisible(_ visible: Bool) {
        capsuleView?.isHidden = !visible
        if visible {
            setCapsuleEnabled(true)
        }
    }

    func setCapsuleEnabled(_ enabled: Bool) {
        capsuleMoreButton?.isEnabled = enabled
        capsuleCloseButton?.isEnabled = enabled
    }

    func bringCapsuleToFront() {
        guard let capsuleView, !capsuleView.isHidden else { return }
        capsuleView.superview?.bringSubviewToFront(capsuleView)
    }

    private func installCapsule(in navigationController: UINavigationController) {
        let capsuleView = UIView()
        capsuleView.translatesAutoresizingMaskIntoConstraints = false
        capsuleView.accessibilityIdentifier = "dimina.navigation.capsule"
        capsuleView.backgroundColor = .white
        capsuleView.layer.cornerRadius = DMPMenuButtonLayout.capsuleSize.height / 2
        capsuleView.layer.borderWidth = 0.5
        capsuleView.layer.borderColor = UIColor(
            red: 229 / 255, green: 229 / 255, blue: 229 / 255, alpha: 1
        ).cgColor
        capsuleView.layer.shadowColor = UIColor.black.cgColor
        capsuleView.layer.shadowOpacity = 0.08
        capsuleView.layer.shadowRadius = 2
        capsuleView.layer.shadowOffset = CGSize(width: 0, height: 1)
        capsuleView.isHidden = true

        let moreButton = UIButton(type: .custom)
        moreButton.translatesAutoresizingMaskIntoConstraints = false
        moreButton.contentHorizontalAlignment = .center
        moreButton.contentVerticalAlignment = .center
        moreButton.setImage(makeCapsuleMoreImage(), for: .normal)
        moreButton.accessibilityLabel = "More"
        moreButton.addTarget(self, action: #selector(capsuleMoreButtonTapped), for: .touchUpInside)

        let closeButton = UIButton(type: .custom)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.contentHorizontalAlignment = .center
        closeButton.contentVerticalAlignment = .center
        closeButton.setImage(makeCapsuleCloseImage(), for: .normal)
        closeButton.accessibilityLabel = "Close"
        closeButton.addTarget(self, action: #selector(capsuleCloseButtonTapped), for: .touchUpInside)

        let separatorView = UIView()
        separatorView.translatesAutoresizingMaskIntoConstraints = false
        separatorView.backgroundColor = UIColor(
            red: 233 / 255, green: 233 / 255, blue: 233 / 255, alpha: 1
        )

        capsuleView.addSubview(moreButton)
        capsuleView.addSubview(separatorView)
        capsuleView.addSubview(closeButton)
        navigationController.view.addSubview(capsuleView)

        let verticalInset = (DMPMenuButtonLayout.navigationBarContentHeight
            - DMPMenuButtonLayout.capsuleSize.height) / 2
        NSLayoutConstraint.activate([
            capsuleView.topAnchor.constraint(
                equalTo: navigationController.view.safeAreaLayoutGuide.topAnchor,
                constant: verticalInset
            ),
            capsuleView.trailingAnchor.constraint(
                equalTo: navigationController.view.trailingAnchor,
                constant: -DMPMenuButtonLayout.trailingSpacing
            ),
            capsuleView.widthAnchor.constraint(equalToConstant: DMPMenuButtonLayout.capsuleSize.width),
            capsuleView.heightAnchor.constraint(equalToConstant: DMPMenuButtonLayout.capsuleSize.height),

            moreButton.leadingAnchor.constraint(equalTo: capsuleView.leadingAnchor),
            moreButton.topAnchor.constraint(equalTo: capsuleView.topAnchor),
            moreButton.bottomAnchor.constraint(equalTo: capsuleView.bottomAnchor),
            moreButton.widthAnchor.constraint(equalToConstant: 43),

            separatorView.centerXAnchor.constraint(equalTo: capsuleView.centerXAnchor),
            separatorView.centerYAnchor.constraint(equalTo: capsuleView.centerYAnchor),
            separatorView.widthAnchor.constraint(equalToConstant: 0.5),
            separatorView.heightAnchor.constraint(equalToConstant: 16),

            closeButton.trailingAnchor.constraint(equalTo: capsuleView.trailingAnchor),
            closeButton.topAnchor.constraint(equalTo: capsuleView.topAnchor),
            closeButton.bottomAnchor.constraint(equalTo: capsuleView.bottomAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 43),
        ])

        self.capsuleView = capsuleView
        self.capsuleMoreButton = moreButton
        self.capsuleCloseButton = closeButton
    }

    private func makeCapsuleMoreImage() -> UIImage {
        let color = UIColor(red: 31 / 255, green: 31 / 255, blue: 31 / 255, alpha: 1)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 22, height: 22))
        return renderer.image { context in
            color.setFill()
            let centerY: CGFloat = 11
            let centers: [(CGFloat, CGFloat)] = [(5, 2), (11, 3.2), (17, 2)]
            for (centerX, radius) in centers {
                context.cgContext.fillEllipse(in: CGRect(
                    x: centerX - radius,
                    y: centerY - radius,
                    width: radius * 2,
                    height: radius * 2
                ))
            }
        }.withRenderingMode(.alwaysOriginal)
    }

    private func makeCapsuleCloseImage() -> UIImage {
        let color = UIColor(red: 31 / 255, green: 31 / 255, blue: 31 / 255, alpha: 1)
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 22, height: 22))
        return renderer.image { context in
            let cgContext = context.cgContext
            let center = CGPoint(x: 11, y: 11)
            color.setStroke()
            cgContext.setLineWidth(2.4)
            cgContext.strokeEllipse(in: CGRect(x: 3.2, y: 3.2, width: 15.6, height: 15.6))
            color.setFill()
            cgContext.fillEllipse(in: CGRect(
                x: center.x - 3.1,
                y: center.y - 3.1,
                width: 6.2,
                height: 6.2
            ))
        }.withRenderingMode(.alwaysOriginal)
    }

    private func activePageController() -> DMPPageController? {
        if let pageController = navigationController?.topViewController as? DMPPageController {
            return pageController
        }
        return (navigationController?.topViewController as? DMPTabBarContainerController)?
            .currentPageController
    }

    @objc private func capsuleMoreButtonTapped() {
        activePageController()?.showMiniProgramMenuFromCapsule()
    }

    @objc private func capsuleCloseButtonTapped() {
        activePageController()?.closeMiniProgramFromCapsule()
    }

    public func pageRecord(webViewId: Int) -> DMPPageRecord? {
        if let record = pageRecords.first(where: { $0.webViewId == webViewId }) {
            return record
        }
        // pageRecords 的根位置只镜像当前选中 tab（updateRootTabRecord），
        // 后台 tab 的记录存在 tab 容器自己的 tabPageRecords 里——这里兜底查询，
        // 否则后台 tab 的迟到调用（如 wx.hideHomeButton）会找不到自己的页面
        return currentTabBarContainer()?.pageRecord(webViewId: webViewId)
    }

    private func isTabBarPage(_ pagePath: String) -> Bool {
        return app?.getBundleAppConfig()?.isTabBarPage(pagePath: pagePath) ?? false
    }

    private func tabBarIndex(for pagePath: String) -> Int {
        return app?.getBundleAppConfig()?.getTabBarIndex(pagePath: pagePath) ?? -1
    }

    func currentTabBarContainer() -> DMPTabBarContainerController? {
        if let tabBarContainerController {
            return tabBarContainerController
        }
        guard let navigationController else { return nil }
        return ownedViewControllers(in: navigationController).first {
            $0 is DMPTabBarContainerController
        } as? DMPTabBarContainerController
    }

    private func hostViewControllers(in navigationController: UINavigationController) -> [UIViewController] {
        if let miniProgramBaseViewControllers {
            return miniProgramBaseViewControllers
        }
        return Array(navigationController.viewControllers.prefix {
            !($0 is DMPPageController) && !($0 is DMPTabBarContainerController)
        })
    }

    private func ownedViewControllers(in navigationController: UINavigationController) -> [UIViewController] {
        let hostControllers = hostViewControllers(in: navigationController)
        let hostIdentifiers = Set(hostControllers.map(ObjectIdentifier.init))
        return navigationController.viewControllers.filter {
            !hostIdentifiers.contains(ObjectIdentifier($0))
        }
    }

    private func notifyRoutingUnload(for controller: UIViewController) {
        (controller as? DMPPageController)?.notifyRoutingUnloadIfNeeded()
        (controller as? DMPTabBarContainerController)?.notifyRoutingUnloadIfNeeded()
    }

    @MainActor
    func suspendForMiniProgramNavigation() {
        guard isActiveNavigationOwner() else { return }
        setCapsuleVisible(false)
        notifyPresentOut()
    }

    @MainActor
    func dispatchPageShow(webViewId: Int) {
        pageLifecycle?.onShow(webviewId: webViewId)
    }

    @MainActor
    func dispatchPageHide(webViewId: Int) {
        pageLifecycle?.onHide(webviewId: webViewId)
    }

    @MainActor
    private func notifyPresentOut() {
        guard isActiveNavigationOwner() else { return }
        app?.notifyMiniProgramHide()
    }

    /// restart 专用：容器留在原地，被换掉的是运行时，所以这条 App.onHide 是发给旧 service
    /// 的终态，而不是一次容器隐藏。
    @MainActor
    private func notifyRuntimeTeardownOut() {
        guard isActiveNavigationOwner() else { return }
        app?.notifyRuntimeTeardownHide()
    }

    /// - Parameter hostVisible: 宿主此刻是否真的在前台。为 false 时这次恢复只交还展示关系，
    ///   不派发 App.onShow：容器整体不可见，此刻派发会让账本以为已经显示，宿主真正回到
    ///   前台时那条 show 就被去重掉，小程序再也收不到本次返回的 onShow。
    @MainActor
    func resumeAfterMiniProgramNavigation(
        scene: Int? = nil,
        referrerInfo: [String: Any]? = nil,
        hostVisible: Bool
    ) {
        guard isActiveNavigationOwner() else { return }
        if hostVisible {
            app?.notifyMiniProgramShow(scene: scene, referrerInfo: referrerInfo)
        } else {
            app?.stashMiniProgramShow(scene: scene, referrerInfo: referrerInfo)
        }
        setCapsuleVisible(true)
        bringCapsuleToFront()
    }

    /// 把拆栈原因交给页面控制器本身。真正的 pageUnload 桥消息只由 DMPPageController 发出；
    /// 路由会在改栈前让它提前派发，销毁则可能晚到转场结束后的 viewDidDisappear、甚至 deinit。
    /// 退出原因必须在离栈之前标注，否则迟到的销毁会被误判为路由。
    private func markPageTeardownReason(_ reason: DMPPageStateTeardown) {
        tabBarContainerController?.markTeardownReason(reason)
        guard let navigationController else { return }
        for controller in ownedViewControllers(in: navigationController) {
            (controller as? DMPPageController)?.markTeardownReason(reason)
            (controller as? DMPTabBarContainerController)?.markTeardownReason(reason)
        }
    }

    private func clearMiniProgramPageState(reason: DMPPageStateTeardown) {
        markPageTeardownReason(reason)
        if reason == .routing {
            if let navigationController {
                let controllers = ownedViewControllers(in: navigationController)
                controllers.reversed().forEach {
                    notifyRoutingUnload(for: $0)
                }
                if let tabBarContainerController,
                   !controllers.contains(where: { $0 === tabBarContainerController })
                {
                    tabBarContainerController.notifyRoutingUnloadIfNeeded()
                }
            } else {
                tabBarContainerController?.notifyRoutingUnloadIfNeeded()
            }
        }
        tabBarContainerController?.destroy()
        tabBarContainerController = nil
        pageRecords.removeAll()
    }

    private func updateRootTabRecord(_ pageRecord: DMPPageRecord) {
        if pageRecords.isEmpty {
            pageRecords.append(pageRecord)
        } else {
            pageRecords[0] = pageRecord
            if pageRecords.count > 1 {
                pageRecords.removeSubrange(1..<pageRecords.count)
            }
        }
    }

    /// 创建自定义返回按钮
    public func createBackButton(darkStyle: Bool = false) -> UIBarButtonItem {
        if let bundle = DMPResourceManager.assetsBundle {
            let imageName = darkStyle ? "arrow-back-dark" : "arrow-back-light"
            if let backImage = UIImage(named: imageName, in: bundle, compatibleWith: nil) {
                let originalImage = backImage.withRenderingMode(.alwaysOriginal)
                return UIBarButtonItem(
                    image: originalImage, style: .plain, target: self,
                    action: #selector(handleBackButtonTapped))
            }
        }

        return UIBarButtonItem(
            title: "back",
            style: .plain,
            target: self,
            action: #selector(handleBackButtonTapped)
        )
    }

    /// 处理返回按钮点击事件
    @objc public func handleBackButtonTapped() {
        // 确保在主线程上调用 navigateBack
        DispatchQueue.main.async { [weak self] in
            self?.navigateBack()
        }
    }

    /// 启动到指定页面
    @MainActor
    /// - Returns: whether a page actually ended up pushed onto the navigation stack. Callers that
    ///   roll a failed cross-mini-program launch back into the foreground (see
    ///   `DMPAppManager.navigateToMiniProgram`) depend on this being accurate - `true` on a launch
    ///   that left the screen blank previously stranded the opener with no way back.
    @discardableResult
    public func launch(
        to path: String, query: [String: Any]? = nil, animated: Bool = true,
        showsLaunchLoading: Bool = true
    ) async -> Bool {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return false
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("launch skipped: navigator is not the active owner")
            return false
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        navigationController.view.endEditing(true)
        dispatchPageHide(webViewId: app!.getCurrentWebViewId())

        if let tabBarConfig = app?.getBundleAppConfig()?.tabBar,
           isTabBarPage(path)
        {
            let tabBarController = DMPTabBarContainerController(
                initialPath: path,
                query: query,
                appConfig: app!.getAppConfig()!,
                app: app,
                navigator: self,
                tabBarConfig: tabBarConfig,
                showsLaunchLoading: showsLaunchLoading
            )

            guard let pageRecord = await tabBarController.prepareInitialTab() else {
                return false
            }
            guard isActiveNavigationOwner() else { return false }

            pageRecords.append(pageRecord)
            tabBarContainerController = tabBarController

            if showsLaunchLoading {
                tabBarController.preparePageLoading(in: navigationController)
            }
            navigationController.pushViewController(tabBarController, animated: animated)

            dispatchPageShow(webViewId: pageRecord.webViewId)
            return true
        }

        // 使用DMPPageController创建页面
        let pageController = DMPPageController(
            pagePath: path,
            query: query,
            appConfig: app!.getAppConfig()!,
            app: app,
            navigator: self,
            isRoot: true,
            showsLaunchLoading: showsLaunchLoading
        )

        let pageRecord = DMPPageRecord(
            webViewId: pageController.getWebView().getWebViewId(),
            fromWebViewId: app!.getCurrentWebViewId(), pagePath: path)
        pageRecord.query = query
        pageRecord.navStyle = app?.getBundleAppConfig()?.getPageConfig(pagePath: path)
        pageRecords.append(pageRecord)

        await app?.service?.loadSubPackage(pagePath: path)
        guard isActiveNavigationOwner() else { return false }

        if showsLaunchLoading {
            pageController.preparePageLoading(in: navigationController)
        }
        navigationController.pushViewController(pageController, animated: animated)

        dispatchPageShow(webViewId: pageController.getWebView().getWebViewId())
        return true
    }

    /// 导航到指定页面
    @MainActor
    public func navigateTo(to path: String, query: [String: Any]? = nil, animated: Bool = true)
        async
    {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("navigateTo skipped: navigator is not the active owner")
            return
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        navigationController.view.endEditing(true)
        if isTabBarPage(path) {
            DMPLogger.debug("navigateTo failed: can not navigateTo a tabbar page: \(path)")
            return
        }

        dispatchPageHide(webViewId: app!.getCurrentWebViewId())

        // 使用DMPPageController创建页面
        let pageController = DMPPageController(
            pagePath: path,
            query: query,
            appConfig: app!.getAppConfig()!,
            app: app,
            navigator: self,
            isRoot: false
        )

        let pageRecord = DMPPageRecord(
            webViewId: pageController.getWebView().getWebViewId(),
            fromWebViewId: app!.getCurrentWebViewId(), pagePath: path)
        pageRecord.query = query
        pageRecord.navStyle = app?.getBundleAppConfig()?.getPageConfig(pagePath: path)
        pageRecords.append(pageRecord)

        // 打印调试信息
        DMPLogger.debug("navigateTo: Creating page controller for path: \(path), isRoot: false")

        await app?.service?.loadSubPackage(pagePath: path)
        guard isActiveNavigationOwner() else {
            pageRecords.removeAll { $0 === pageRecord }
            pageController.destroy()
            return
        }

        navigationController.pushViewController(pageController, animated: animated)

        dispatchPageShow(webViewId: pageController.getWebView().getWebViewId())
    }

    /// 返回上一页或多页
    @MainActor
    public func navigateBack(delta: Int = 1, animated: Bool = true, destroy: Bool = true) {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("navigateBack skipped: navigator is not the active owner")
            return
        }

        navigationController.view.endEditing(true)

        // 退出判定对两种宿主拓扑同源：hostViewControllers 在跨小程序场景返回启动前保留的宿主栈，
        // 独占导航栈时按「栈底连续的非小程序控制器」推断。currentIndex 不高于宿主段，说明小程序
        // 自己只剩一个页面、没有可回退的页面，这次返回就是一次退出而不是路由。
        let hostControllers = hostViewControllers(in: navigationController)
        let currentIndex = navigationController.viewControllers.count - 1
        if currentIndex <= hostControllers.count {
            // 被另一个小程序拉起的 guest 只能从 exitMiniProgram / navigateBackMiniProgram 通道
            // 退出——那里才会把 scene 1038 和 referrerInfo 交还 opener、并回收 target 运行时。
            // 首页上的返回在微信同样是失败而非退出，所以这里不派发任何生命周期。
            guard miniProgramBaseViewControllers == nil else {
                DMPLogger.debug("navigateBack skipped: guest mini program has no page to pop")
                return
            }
            guard destroy else { return }
            setCapsuleVisible(false)
            // 退出对齐微信的「小程序切入后台」：栈顶页先 onHide，App 再 onHide。关闭不派发
            // onUnload——微信的 unloadPage 只由路由事件驱动，退出走的是 onAppEnterBackground。
            let hidingWebViewId = app?.getCurrentWebViewId() ?? -1
            // 标注必须早于 pop：动画结束后才走 viewDidDisappear，那时这些控制器已经离栈，
            // clearMiniProgramPageState 再标注就来不及了。
            markPageTeardownReason(.exit)
            if let hostTopController = hostControllers.last {
                navigationController.popToViewController(hostTopController, animated: animated)
            }
            app?.notifyMiniProgramHide(webViewId: hidingWebViewId)
            clearMiniProgramPageState(reason: .exit)
            if hostControllers.isEmpty {
                // 没有宿主控制器可退回，页面壳随小程序一起消失，运行时也没有保活的意义。
                app?.destroy()
            }
            return
        }

        // 计算要返回的目标控制器索引
        let targetIndex = max(currentIndex - max(delta, 1), hostControllers.count)
        if targetIndex + 1 < navigationController.viewControllers.count {
            navigationController.viewControllers[(targetIndex + 1)...]
                .reversed()
                .forEach { notifyRoutingUnload(for: $0) }
        }

        // 处理返回逻辑：最多弹到只剩栈底那条记录，首页记录必须留下——pageRecords 是
        // getCurrentWebViewId 的唯一来源，清空它会让之后的前后台切换和跨小程序派发拿到 -1。
        let removalCount = min(max(delta, 1), max(pageRecords.count - 1, 0))
        for _ in 0..<removalCount {
            if navigationController.viewControllers.count <= 1 || pageRecords.isEmpty {
                break
            }

            pageRecords.removeLast()
        }

        // 返回到目标控制器
        let targetViewController = navigationController.viewControllers[targetIndex]
        navigationController.popToViewController(targetViewController, animated: animated)

        // 显示前一个页面
        if let previousPageRecord = pageRecords.last {
            dispatchPageShow(webViewId: previousPageRecord.webViewId)
        }
    }

    /// 返回首页（导航栏 home 按钮的唯一路由入口），终态都是只剩首页：
    /// 首页是 tab 页走 switchTab（保留其它 tab 状态并露出 tabBar，自带清非 tab 栈）；
    /// 首页非 tab 且当前是栈底，redirectTo 原地替换；非栈底（`homeButton: true`
    /// 的内页）redirect 只会替换栈顶、栈底仍在，须 relaunch 清整栈
    @MainActor
    public func navigateHome() async {
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("navigateHome skipped: navigator is not the active owner")
            return
        }
        guard let entryPagePath = app?.getBundleAppConfig()?.entryPagePath, !entryPagePath.isEmpty else {
            return
        }
        if isTabBarPage(entryPagePath) {
            await switchTab(to: entryPagePath)
        } else if pageRecords.count <= 1 {
            await redirectTo(to: entryPagePath)
        } else {
            await relaunch(to: entryPagePath)
        }
    }

    @MainActor
    public func redirectTo(to path: String, query: [String: Any]? = nil) async {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("redirectTo skipped: navigator is not the active owner")
            return
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        navigationController.view.endEditing(true)
        if isTabBarPage(path) {
            DMPLogger.debug("redirectTo failed: can not redirectTo a tabbar page: \(path)")
            return
        }

        let currentIndex = navigationController.viewControllers.count - 1

        // 栈底判定与 navigateHome 同源：pageRecords 是小程序页面栈的唯一权威。
        // 原生 viewControllers 的栈底可能是宿主自己的页面（如 demo 的应用列表），
        // 按原生栈位置判栈底会把"替换仅剩的一页"误判为非栈底，导航栏因此错显返回箭头
        let replacingStackBottom = pageRecords.count <= 1
        notifyRoutingUnload(for: navigationController.viewControllers[currentIndex])

        // 如果当前只有一个页面，则需要特殊处理
        if currentIndex == 0 {
            if !pageRecords.isEmpty {
                pageRecords.removeLast()
            }

            let pageController = DMPPageController(
                pagePath: path,
                query: query,
                appConfig: app!.getAppConfig()!,
                app: app,
                navigator: self,
                isRoot: true
            )

            let pageRecord = DMPPageRecord(
                webViewId: pageController.getWebView().getWebViewId(),
                fromWebViewId: app!.getCurrentWebViewId(), pagePath: path)
            pageRecord.query = query
            pageRecord.navStyle = app?.getBundleAppConfig()?.getPageConfig(pagePath: path)
            pageRecords.append(pageRecord)

            await app?.service?.loadSubPackage(pagePath: path)
            guard isActiveNavigationOwner() else {
                pageRecords.removeAll { $0 === pageRecord }
                pageController.destroy()
                return
            }

            let viewControllers = [pageController]
            navigationController.setViewControllers(viewControllers, animated: false)

            dispatchPageShow(webViewId: pageController.getWebView().getWebViewId())

            return
        }

        if !pageRecords.isEmpty {
            pageRecords.removeLast()
        }

        let pageController = DMPPageController(
            pagePath: path,
            query: query,
            appConfig: app!.getAppConfig()!,
            app: app,
            navigator: self,
            isRoot: replacingStackBottom
        )

        let pageRecord = DMPPageRecord(
            webViewId: pageController.getWebView().getWebViewId(),
            fromWebViewId: app!.getCurrentWebViewId(), pagePath: path)
        pageRecord.query = query
        pageRecord.navStyle = app?.getBundleAppConfig()?.getPageConfig(pagePath: path)
        pageRecords.append(pageRecord)

        var viewControllers = navigationController.viewControllers
        viewControllers.removeLast()
        viewControllers.append(pageController)
        navigationController.setViewControllers(viewControllers, animated: false)
        dispatchPageShow(webViewId: pageController.getWebView().getWebViewId())
    }

    @MainActor
    public func relaunch(to path: String, query: [String: Any]? = nil, animated: Bool = true) async
    {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("relaunch skipped: navigator is not the active owner")
            return
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        navigationController.view.endEditing(true)
        let hostControllers = hostViewControllers(in: navigationController)
        clearMiniProgramPageState(reason: .routing)

        await launch(to: path, query: query, animated: false, showsLaunchLoading: false)
        guard isActiveNavigationOwner() else { return }

        guard let newRootController = navigationController.topViewController else {
            return
        }
        navigationController.setViewControllers(
            hostControllers + [newRootController],
            animated: animated
        )
    }

    /// Rebuild the mini-program runtime between tearing down the old page tree
    /// and launching the new root page. Unlike `relaunch`, this is an app-level
    /// cold reload and intentionally runs the launch-loading path again.
    @MainActor
    @discardableResult
    func reloadMiniProgram(
        animated: Bool = false,
        onAccepted: @MainActor () -> Void = {},
        prepareRuntime: @MainActor () async -> DMPLaunchConfig?
    ) async -> Bool {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return false
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("reload skipped: navigator is not the active owner")
            return false
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        navigationController.view.endEditing(true)
        let hostControllers = hostViewControllers(in: navigationController)
        let pageControllers = ownedViewControllers(in: navigationController).compactMap {
            $0 as? DMPPageController
        }

        // API success/complete and presentation-out lifecycle must all reach
        // the old service before its engine is destroyed in prepareRuntime.
        onAccepted()
        notifyRuntimeTeardownOut()
        // restart 是「关掉再重开」而不是一次路由：上面已经发过 App.onHide，
        // 旧运行时紧接着整体销毁，所以和退出同源，不补 onUnload。
        clearMiniProgramPageState(reason: .exit)
        pageControllers.forEach { $0.destroy() }

        guard let launchConfig = await prepareRuntime() else {
            return false
        }
        await app?.openPage(launchConfig: launchConfig)

        guard let newRootController = navigationController.topViewController else {
            return false
        }
        navigationController.setViewControllers(
            hostControllers + [newRootController],
            animated: animated
        )
        return true
    }

    @MainActor
    public func closeMiniProgram(
        animated: Bool = true,
        completion: @escaping () -> Void
    ) {
        guard let navigationController = navigationController else {
            completion()
            return
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("close skipped: navigator is not the active owner")
            completion()
            return
        }

        navigationController.view.endEditing(true)
        notifyPresentOut()
        setCapsuleVisible(false)
        let hostControllers = hostViewControllers(in: navigationController)
        clearMiniProgramPageState(reason: .exit)

        if hostControllers.isEmpty {
            navigationController.dismiss(animated: animated, completion: completion)
            return
        }

        CATransaction.begin()
        CATransaction.setCompletionBlock(completion)
        navigationController.setViewControllers(hostControllers, animated: animated)
        CATransaction.commit()
    }

    @MainActor
    @discardableResult
    public func switchTab(to path: String, query: [String: Any]? = nil, animated: Bool = true) async -> Bool {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return false
        }
        guard isActiveNavigationOwner() else {
            DMPLogger.debug("switchTab skipped: navigator is not the active owner")
            return false
        }
        pageRouteOperationDepth += 1
        defer { pageRouteOperationDepth -= 1 }

        guard let tabBarConfig = app?.getBundleAppConfig()?.tabBar else {
            DMPLogger.debug("switchTab failed: tabBar config not found")
            return false
        }

        let targetIndex = tabBarIndex(for: path)
        guard targetIndex >= 0 else {
            DMPLogger.debug("switchTab failed: target is not a tabbar page: \(path)")
            return false
        }

        navigationController.view.endEditing(true)

        if let tabBarController = currentTabBarContainer() {
            let previousRecord = tabBarController.selectedPageRecord ?? pageRecords.first
            let wasPreviousTabVisible = navigationController.topViewController === tabBarController
                && pageRecords.count <= 1

            if navigationController.topViewController !== tabBarController {
                if let tabIndex = navigationController.viewControllers.firstIndex(where: {
                    $0 === tabBarController
                }), tabIndex + 1 < navigationController.viewControllers.count {
                    navigationController.viewControllers[(tabIndex + 1)...]
                        .reversed()
                        .forEach { notifyRoutingUnload(for: $0) }
                }
                while pageRecords.count > 1 {
                    pageRecords.removeLast()
                }
                navigationController.popToViewController(tabBarController, animated: animated)
            }

            if wasPreviousTabVisible,
               let previousRecord,
               previousRecord.webViewId != tabBarController.pageRecord(at: targetIndex)?.webViewId
            {
                dispatchPageHide(webViewId: previousRecord.webViewId)
            }

            guard let currentRecord = await tabBarController.selectTab(index: targetIndex, query: query) else {
                return false
            }
            guard isActiveNavigationOwner() else { return false }

            updateRootTabRecord(currentRecord)

            if !wasPreviousTabVisible || previousRecord?.webViewId != currentRecord.webViewId {
                dispatchPageShow(webViewId: currentRecord.webViewId)
            }

            tabBarContainerController = tabBarController
            return true
        }

        ownedViewControllers(in: navigationController).reversed().forEach {
            notifyRoutingUnload(for: $0)
        }
        pageRecords.removeAll()

        let tabBarController = DMPTabBarContainerController(
            initialPath: path,
            query: query,
            appConfig: app!.getAppConfig()!,
            app: app,
            navigator: self,
            tabBarConfig: tabBarConfig,
            showsLaunchLoading: false
        )

        guard let pageRecord = await tabBarController.prepareInitialTab() else {
            return false
        }
        guard isActiveNavigationOwner() else {
            tabBarController.destroy()
            return false
        }

        updateRootTabRecord(pageRecord)
        tabBarContainerController = tabBarController

        var nextViewControllers = hostViewControllers(in: navigationController)
        nextViewControllers.append(tabBarController)
        navigationController.setViewControllers(nextViewControllers, animated: animated)

        dispatchPageShow(webViewId: pageRecord.webViewId)
        return true
    }

    /// 返回到根页面
    private func goBackToRoot(animated: Bool = true) {
        guard let navigationController = navigationController else {
            DMPLogger.debug("导航控制器未设置")
            return
        }

        navigationController.popToRootViewController(animated: animated)
        pageRecords.removeAll()
    }

    /// 获取当前页面记录
    public func getTopPageRecord() -> DMPPageRecord? {
        return pageRecords.last
    }
}
