//
//  DMPPageController.swift
//  dimina
//
//  Created by Lehem on 2025/5/15.
//

import Foundation
import SwiftUI
import UIKit
import WebKit

/// DMPPageController is a specialized view controller for displaying mini-program pages
/// It directly integrates the functionality of both DMPPage and DMPViewController
public class DMPPageController: UIViewController {

    // Weak reference to the navigator
    private weak var navigator: DMPNavigator?

    // Page properties
    private let pagePath: String
    private let query: [String: Any]?
    private let appConfig: DMPAppConfig
    private weak var app: DMPApp?
    private let isRoot: Bool
    private let showsLaunchLoading: Bool

    // WebView related
    private var webview: DMPWebview
    private let loadingStateObserverToken = UUID()
    private var hostingController: UIHostingController<DMPWebViewContainer>?
    private var customNavigationBar: UIView?
    private var customNavigationContentView: UIView?
    private var customNavigationTitleLabel: UILabel?
    private var customNavigationBackButton: UIButton?
    private var customNavigationHomeButton: UIButton?
    // 微信真机 home 图标带灰色圆形底，比返回箭头更粗更显眼；颜色随导航栏深浅切换，见 updateCustomHomeButton
    private var customNavigationHomeButtonBackground: UIView?
    // home 键的两套水平位置：独占左槽（栈底自动规则）/ 紧随返回箭头之后
    // （homeButton: true 的内页，微信实测两者并存），按 showBack 切换激活
    private var homeButtonLeadingToEdge: NSLayoutConstraint?
    private var homeButtonLeadingAfterBack: NSLayoutConstraint?
    private var miniProgramMenuContainerView: UIView?
    private var isClosingMiniProgram = false
    private var webViewTopToNavigationConstraint: NSLayoutConstraint?
    private var webViewTopToViewConstraint: NSLayoutConstraint?
    private var loadingView: UIView?
    private weak var loadingParentController: UIViewController?

    // State
    private var isWebViewDestroyed = false
    private var hasStartedLoading = false
    private var hasShownLaunchLoading = false
    private var isGeneratingDeviceOrientationNotifications = false
    /// 这一页此刻是不是那个已经落定在屏幕上的页。
    /// `viewDidAppear` 置起、`viewDidDisappear` 清掉：只有它为真时这一页才认领方向（见 `supportedInterfaceOrientations`）。
    /// 不能只置不清——被压在下面的页再次露面走的是 pop，pop 动画里它还没落定，一个不清的旧标记会让它在动画中间就把窗口转回去，UIKit 因此把这次 pop 判成被打断。
    private var hasLandedOnScreen = false
    /// 这一页最后一次真正显示时窗口所处的界面方向，`auto` 页重新露面时用它兜底决定转回哪去（见 `autoOrientationTarget`）
    private var lastDisplayedInterfaceOrientation: UIInterfaceOrientation?
    private var deviceOrientationObserver: NSObjectProtocol?
    private var pageShowGeneration = 0
    private var pendingPageShow: (
        generation: Int,
        expected: UIInterfaceOrientationMask,
        action: @MainActor () async -> Void
    )?
    private var geometryRequestGeneration = 0
    private var activeGeometryRequest: (
        generation: Int,
        expected: UIInterfaceOrientationMask
    )?

    /// Initialization method
    /// - Parameters:
    ///   - pagePath: Page path
    ///   - query: Query parameters
    ///   - appConfig: App configuration
    ///   - app: App instance
    ///   - navigator: Navigator
    ///   - isRoot: Whether this is a root view controller
    ///   - showsLaunchLoading: Whether to show the app launch loading overlay
    public init(
        pagePath: String, query: [String: Any]?, appConfig: DMPAppConfig, app: DMPApp?,
        navigator: DMPNavigator?, isRoot: Bool = false, showsLaunchLoading: Bool = false
    ) {
        self.pagePath = pagePath
        self.query = query
        self.appConfig = appConfig
        self.app = app
        self.navigator = navigator
        self.isRoot = isRoot
        self.showsLaunchLoading = showsLaunchLoading

        // Create WebView
        self.webview = (app?.render!.createWebView(appName: appConfig.appName))!

        super.init(nibName: nil, bundle: nil)

        // Configure WebView - Configure immediately to ensure page path is set correctly
        configWebView()
        observeLoadingState()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    // Configure WebView
    private func configWebView() {        
        // Set page path and query parameters
        self.webview.setPagePath(pagePath: pagePath)
        if let query = query {
            self.webview.setQuery(query: query)
        }
        
        DMPLogger.debug("🔧 DMPPageController: WebView (ID: \(webview.getWebViewId())) configuration completed, current page path: \(webview.getPagePath())")
        
        app?.render?.setupJSBridge(webViewId: webview.getWebViewId())

    }

    // View loaded
    public override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = .white
        setupCustomNavigationBar()

        // Create SwiftUI view container
        let webViewContainer = DMPWebViewContainer(webview: webview, isRoot: isRoot)
        hostingController = UIHostingController(rootView: webViewContainer)

        // Add child view controller
        if let hostingController = hostingController {
            addChild(hostingController)
            view.addSubview(hostingController.view)
            hostingController.view.translatesAutoresizingMaskIntoConstraints = false
            webViewTopToNavigationConstraint = hostingController.view.topAnchor.constraint(
                equalTo: customNavigationBar?.bottomAnchor ?? view.topAnchor
            )
            webViewTopToViewConstraint = hostingController.view.topAnchor.constraint(equalTo: view.topAnchor)
            NSLayoutConstraint.activate([
                webViewTopToNavigationConstraint!,
                hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            ])
            hostingController.didMove(toParent: self)
        }

        // Set navigation bar style
        setupNavigationBar()
    }

    // View will appear
    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigator?.setCapsuleVisible(true)
        if loadingView == nil {
            navigator?.bringCapsuleToFront()
        }
        setupNavigationBar()
        showPageLoadingIfNeeded()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let customNavigationBar = customNavigationBar, !customNavigationBar.isHidden {
            view.bringSubviewToFront(customNavigationBar)
        }
        if let miniProgramMenuContainerView = miniProgramMenuContainerView {
            miniProgramMenuContainerView.superview?.bringSubviewToFront(miniProgramMenuContainerView)
        }
        loadingView?.superview?.bringSubviewToFront(loadingView!)
    }

    // View did appear
    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if navigator?.pageOrientationSupport == .supported {
            hasLandedOnScreen = true
            // `UIDevice.current.orientation` 只有在开启方向通知时才有真值，否则恒为 `.unknown`。
            // 能力关闭时整段不执行，旧宿主不会新增传感器或通知监听。
            beginGeneratingDeviceOrientationNotificationsIfNeeded()
            // 第一次露面时把当时的界面方向记下来当作「设备朝哪」的初值；之后再露面（从上层页面返回）不能在这里覆盖，那时窗口很可能还停在上层页面强制的方向上。
            if lastDisplayedInterfaceOrientation == nil {
                rememberDisplayedOrientationIfNeeded()
            }
            startObservingDeviceOrientation()
            settlePendingPageShowOnAppear()
            resyncOrientationOnAppear()
        }
        startLoadingIfNeeded()
    }

    private func startLoadingIfNeeded() {
        guard !hasStartedLoading, !isWebViewDestroyed else {
            return
        }

        hasStartedLoading = true
        showPageLoadingIfNeeded()
        webview.poolState = .loading
        var enableVConsole = false
        #if DEBUG
        enableVConsole = true
        #endif
        webview.loadPageFrame(enableVConsole: enableVConsole)
    }

    public func preparePageLoading(in parentController: UIViewController) {
        guard showsLaunchLoading else {
            return
        }

        installPageLoading(in: parentController, isVisible: false)
    }

    private func observeLoadingState() {
        webview.setLoadingStateObserver(ownerToken: loadingStateObserverToken) { [weak self] isLoading in
            let updateLoading = {
                if isLoading {
                    self?.showPageLoadingIfNeeded()
                } else {
                    self?.hidePageLoading()
                }
            }

            if Thread.isMainThread {
                updateLoading()
            } else {
                DispatchQueue.main.async {
                    updateLoading()
                }
            }
        }
    }

    private func showPageLoadingIfNeeded() {
        guard showsLaunchLoading, !hasShownLaunchLoading else {
            return
        }

        hasShownLaunchLoading = true
        showPageLoading()
    }

    private func showPageLoading() {
        let parentController = loadingParentController ?? navigationController ?? self
        installPageLoading(in: parentController, isVisible: true)
    }

    private func installPageLoading(in parentController: UIViewController, isVisible: Bool) {
        let parentView = parentController.view!

        if let loadingView = self.loadingView {
            loadingView.superview?.bringSubviewToFront(loadingView)
            UIView.performWithoutAnimation {
                loadingView.alpha = isVisible ? 1 : 0
                loadingView.isUserInteractionEnabled = isVisible
                parentView.layoutIfNeeded()
            }
            return
        }

        let loadingView = makePageLoadingView()
        loadingView.translatesAutoresizingMaskIntoConstraints = false
        loadingView.alpha = isVisible ? 1 : 0
        loadingView.isUserInteractionEnabled = isVisible

        parentView.addSubview(loadingView)
        NSLayoutConstraint.activate([
            loadingView.topAnchor.constraint(equalTo: parentView.topAnchor),
            loadingView.bottomAnchor.constraint(equalTo: parentView.bottomAnchor),
            loadingView.leadingAnchor.constraint(equalTo: parentView.leadingAnchor),
            loadingView.trailingAnchor.constraint(equalTo: parentView.trailingAnchor),
        ])
        parentView.bringSubviewToFront(loadingView)
        UIView.performWithoutAnimation {
            parentView.layoutIfNeeded()
        }

        self.loadingView = loadingView
        self.loadingParentController = parentController
    }

    private func setupCustomNavigationBar() {
        let navigationBar = UIView()
        navigationBar.translatesAutoresizingMaskIntoConstraints = false

        let contentView = UIView()
        contentView.translatesAutoresizingMaskIntoConstraints = false

        let backButton = UIButton(type: .custom)
        backButton.translatesAutoresizingMaskIntoConstraints = false
        backButton.addTarget(self, action: #selector(customBackButtonTapped), for: .touchUpInside)

        let homeButton = UIButton(type: .custom)
        homeButton.translatesAutoresizingMaskIntoConstraints = false
        homeButton.accessibilityLabel = "Home"
        homeButton.addTarget(self, action: #selector(homeButtonTapped), for: .touchUpInside)

        let homeButtonBackground = UIView()
        homeButtonBackground.translatesAutoresizingMaskIntoConstraints = false
        homeButtonBackground.isUserInteractionEnabled = false
        homeButtonBackground.layer.cornerRadius = 16

        let titleLabel = UILabel()
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.textAlignment = .center
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail

        view.addSubview(navigationBar)
        navigationBar.addSubview(contentView)
        contentView.addSubview(backButton)
        contentView.addSubview(homeButtonBackground)
        contentView.addSubview(homeButton)
        contentView.addSubview(titleLabel)

        NSLayoutConstraint.activate([
            navigationBar.topAnchor.constraint(equalTo: view.topAnchor),
            navigationBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navigationBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            contentView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            contentView.leadingAnchor.constraint(equalTo: navigationBar.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: navigationBar.trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: navigationBar.bottomAnchor),
            contentView.heightAnchor.constraint(equalToConstant: DMPMenuButtonLayout.navigationBarContentHeight),

            backButton.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            backButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 44),
            backButton.heightAnchor.constraint(equalToConstant: 44),

            homeButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            homeButton.widthAnchor.constraint(equalToConstant: 44),
            homeButton.heightAnchor.constraint(equalToConstant: 44),

            homeButtonBackground.centerXAnchor.constraint(equalTo: homeButton.centerXAnchor),
            homeButtonBackground.centerYAnchor.constraint(equalTo: homeButton.centerYAnchor),
            homeButtonBackground.widthAnchor.constraint(equalToConstant: 32),
            homeButtonBackground.heightAnchor.constraint(equalToConstant: 32),

            titleLabel.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: backButton.trailingAnchor, constant: 8),
            titleLabel.trailingAnchor.constraint(
                lessThanOrEqualTo: contentView.trailingAnchor,
                constant: -DMPMenuButtonLayout.titleTrailingInset
            )
        ])

        let homeLeadingToEdge = homeButton.leadingAnchor.constraint(
            equalTo: contentView.leadingAnchor, constant: 8)
        // 44pt 触摸热区本身比图标大（图标 24pt 居中，热区两侧各留 10pt），
        // 热区自带的留白已经提供了视觉间距，这里不再叠加额外 margin，
        // 否则视觉间距会远超微信原生 `.navigator-hd a+a{margin-left:10px}` 的 10pt
        let homeLeadingAfterBack = homeButton.leadingAnchor.constraint(
            equalTo: backButton.trailingAnchor)
        homeLeadingToEdge.isActive = true
        homeButtonLeadingToEdge = homeLeadingToEdge
        homeButtonLeadingAfterBack = homeLeadingAfterBack

        customNavigationBar = navigationBar
        customNavigationContentView = contentView
        customNavigationBackButton = backButton
        customNavigationHomeButton = homeButton
        customNavigationHomeButtonBackground = homeButtonBackground
        customNavigationTitleLabel = titleLabel
    }

    private func makePageLoadingView() -> UIView {
        let container = UIView()
        container.backgroundColor = .white

        let stackView = UIStackView()
        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.spacing = 8
        stackView.translatesAutoresizingMaskIntoConstraints = false

        let iconView = UIView()
        iconView.translatesAutoresizingMaskIntoConstraints = false

        let ringView = UIView()
        ringView.layer.borderColor = UIColor.gray.withAlphaComponent(0.3).cgColor
        ringView.layer.borderWidth = 1
        ringView.layer.cornerRadius = 30
        ringView.translatesAutoresizingMaskIntoConstraints = false

        let appIconView = UIView()
        appIconView.backgroundColor = loadingIconColor(for: webview.appName)
        appIconView.layer.cornerRadius = 20
        appIconView.translatesAutoresizingMaskIntoConstraints = false

        let rotorView = UIView()
        rotorView.translatesAutoresizingMaskIntoConstraints = false

        let dotView = UIView()
        dotView.backgroundColor = .systemGreen
        dotView.layer.cornerRadius = 3
        dotView.translatesAutoresizingMaskIntoConstraints = false

        let initialLabel = UILabel()
        initialLabel.text = String(webview.appName.prefix(1))
        initialLabel.textColor = .white
        initialLabel.font = .systemFont(ofSize: 16, weight: .bold)
        initialLabel.textAlignment = .center
        initialLabel.translatesAutoresizingMaskIntoConstraints = false

        let appNameLabel = UILabel()
        appNameLabel.text = webview.appName
        appNameLabel.textColor = .label
        appNameLabel.font = .systemFont(ofSize: 14, weight: .medium)
        appNameLabel.textAlignment = .center

        container.addSubview(stackView)
        stackView.addArrangedSubview(iconView)
        stackView.addArrangedSubview(appNameLabel)

        iconView.addSubview(ringView)
        iconView.addSubview(appIconView)
        iconView.addSubview(rotorView)
        rotorView.addSubview(dotView)
        appIconView.addSubview(initialLabel)

        NSLayoutConstraint.activate([
            stackView.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            stackView.centerYAnchor.constraint(equalTo: container.centerYAnchor),

            iconView.widthAnchor.constraint(equalToConstant: 60),
            iconView.heightAnchor.constraint(equalToConstant: 60),

            ringView.centerXAnchor.constraint(equalTo: iconView.centerXAnchor),
            ringView.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
            ringView.widthAnchor.constraint(equalToConstant: 60),
            ringView.heightAnchor.constraint(equalToConstant: 60),

            appIconView.centerXAnchor.constraint(equalTo: iconView.centerXAnchor),
            appIconView.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
            appIconView.widthAnchor.constraint(equalToConstant: 40),
            appIconView.heightAnchor.constraint(equalToConstant: 40),

            rotorView.centerXAnchor.constraint(equalTo: iconView.centerXAnchor),
            rotorView.centerYAnchor.constraint(equalTo: iconView.centerYAnchor),
            rotorView.widthAnchor.constraint(equalToConstant: 60),
            rotorView.heightAnchor.constraint(equalToConstant: 60),

            dotView.centerXAnchor.constraint(equalTo: rotorView.centerXAnchor),
            dotView.centerYAnchor.constraint(equalTo: rotorView.topAnchor),
            dotView.widthAnchor.constraint(equalToConstant: 6),
            dotView.heightAnchor.constraint(equalToConstant: 6),

            initialLabel.centerXAnchor.constraint(equalTo: appIconView.centerXAnchor),
            initialLabel.centerYAnchor.constraint(equalTo: appIconView.centerYAnchor),
        ])

        let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
        rotation.fromValue = 0
        rotation.toValue = Double.pi * 2
        rotation.duration = 1.2
        rotation.repeatCount = .infinity
        rotation.timingFunction = CAMediaTimingFunction(name: .linear)
        rotorView.layer.add(rotation, forKey: "loading.rotation")

        return container
    }

    private func loadingIconColor(for name: String) -> UIColor {
        guard !name.isEmpty else {
            return UIColor(red: 33 / 255, green: 150 / 255, blue: 243 / 255, alpha: 1)
        }

        var hash: Int32 = 0
        for scalar in name.unicodeScalars {
            hash = 31 &* hash &+ Int32(scalar.value)
        }

        let hue = CGFloat(abs(hash % 360)) / 360.0
        let saturation = CGFloat(0.7 + Float(hash % 3000) / 10000.0)
        let brightness = CGFloat(0.8 + Float(hash % 2000) / 10000.0)
        return UIColor(hue: hue, saturation: saturation, brightness: brightness, alpha: 1)
    }

    private func hidePageLoading() {
        guard let loadingView = loadingView else {
            return
        }

        loadingView.removeFromSuperview()

        self.loadingView = nil
        self.loadingParentController = nil

        setupNavigationBar()
        navigator?.bringCapsuleToFront()
    }

    public func updateNavigationTitle(_ title: String) {
        let nextTitle = title.isEmpty ? appConfig.appName : title
        customNavigationTitleLabel?.text = nextTitle
        navigationItem.title = nextTitle
    }

    public func updateNavigationColor(backgroundColor: UIColor, textColor: UIColor, darkStyle: Bool) {
        customNavigationBar?.backgroundColor = backgroundColor
        customNavigationTitleLabel?.textColor = textColor
        updateCustomBackButton(darkStyle: darkStyle)
        updateCustomHomeButton(darkStyle: darkStyle)
    }

    private func updateCustomBackButton(darkStyle: Bool) {
        guard let backButton = customNavigationBackButton else {
            return
        }

        if let bundle = DMPResourceManager.assetsBundle {
            let imageName = darkStyle ? "arrow-back-dark" : "arrow-back-light"
            if let image = UIImage(named: imageName, in: bundle, compatibleWith: nil) {
                backButton.setImage(image.withRenderingMode(.alwaysOriginal), for: .normal)
                backButton.setTitle(nil, for: .normal)
                return
            }
        }

        backButton.setImage(nil, for: .normal)
        backButton.setTitle("back", for: .normal)
        backButton.setTitleColor(darkStyle ? .white : .black, for: .normal)
    }

    private func updateCustomHomeButton(darkStyle: Bool) {
        guard let homeButton = customNavigationHomeButton else {
            return
        }

        // 微信真机 home 图标的灰色圆形底，颜色随导航栏深浅切换
        customNavigationHomeButtonBackground?.backgroundColor = darkStyle
            ? UIColor.white.withAlphaComponent(0.24)
            : UIColor(red: 0.839, green: 0.839, blue: 0.839, alpha: 1)

        // 与返回箭头同机制：按 darkStyle 选择 Material home 造型的 SVG 资产
        if let bundle = DMPResourceManager.assetsBundle {
            let imageName = darkStyle ? "home-dark" : "home-light"
            if let image = UIImage(named: imageName, in: bundle, compatibleWith: nil) {
                homeButton.setImage(image.withRenderingMode(.alwaysOriginal), for: .normal)
                return
            }
        }

        // 资产缺失时退回 SF Symbol 模板渲染
        if let homeImage = UIImage(systemName: "house") {
            homeButton.setImage(homeImage.withRenderingMode(.alwaysTemplate), for: .normal)
        }
        homeButton.tintColor = darkStyle ? .white : .black
    }

    @objc private func customBackButtonTapped() {
        navigator?.handleBackButtonTapped()
    }

    // 路由判定收敛在 DMPNavigator.navigateHome（switchTab / redirectTo 的选择），按钮只发起
    @objc private func homeButtonTapped() {
        Task { @MainActor [weak self] in
            await self?.navigator?.navigateHome()
        }
    }

    func showMiniProgramMenuFromCapsule() {
        showMiniProgramMenu()
    }

    func closeMiniProgramFromCapsule() {
        guard !isClosingMiniProgram else {
            return
        }
        isClosingMiniProgram = true

        dismissMiniProgramMenu()
        navigator?.setCapsuleEnabled(false)

        guard let app else {
            isClosingMiniProgram = false
            navigator?.setCapsuleEnabled(true)
            return
        }
        Task { @MainActor [weak self] in
            do {
                // Capsule close is the UI form of exitMiniProgram. Reuse the
                // coordinator so it shares active-owner/operation guards,
                // lifecycle ordering, callback drain, and opener restoration.
                try await DMPAppManager.sharedInstance().exitMiniProgram(
                    app,
                    onAccepted: {}
                )
            } catch {
                self?.isClosingMiniProgram = false
                self?.navigator?.setCapsuleEnabled(true)
                DMPLogger.debug("capsule close rejected: \(error.localizedDescription)")
            }
        }
    }

    private func showMiniProgramMenu() {
        guard miniProgramMenuContainerView == nil else {
            return
        }

        let overlay = UIControl()
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        overlay.addTarget(self, action: #selector(dismissMiniProgramMenu), for: .touchUpInside)

        let sheetView = UIView()
        sheetView.translatesAutoresizingMaskIntoConstraints = false
        sheetView.backgroundColor = .white
        sheetView.layer.cornerRadius = 18
        if #available(iOS 11.0, *) {
            sheetView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        }

        let iconLabel = UILabel()
        iconLabel.translatesAutoresizingMaskIntoConstraints = false
        iconLabel.text = String(appConfig.appName.prefix(1)).isEmpty ? "小" : String(appConfig.appName.prefix(1))
        iconLabel.textAlignment = .center
        iconLabel.font = .systemFont(ofSize: 18, weight: .medium)
        iconLabel.textColor = UIColor(red: 138 / 255, green: 138 / 255, blue: 138 / 255, alpha: 1)
        iconLabel.backgroundColor = UIColor(red: 244 / 255, green: 244 / 255, blue: 244 / 255, alpha: 1)
        iconLabel.layer.cornerRadius = 22
        iconLabel.clipsToBounds = true

        let titleLabel = UILabel()
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = appConfig.appName
        titleLabel.font = .systemFont(ofSize: 18, weight: .semibold)
        titleLabel.textColor = UIColor(red: 32 / 255, green: 32 / 255, blue: 32 / 255, alpha: 1)

        let subtitleLabel = UILabel()
        subtitleLabel.translatesAutoresizingMaskIntoConstraints = false
        subtitleLabel.text = "小程序"
        subtitleLabel.font = .systemFont(ofSize: 14)
        subtitleLabel.textColor = UIColor(red: 154 / 255, green: 154 / 255, blue: 154 / 255, alpha: 1)

        let titleStack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        titleStack.translatesAutoresizingMaskIntoConstraints = false
        titleStack.axis = .vertical
        titleStack.spacing = 3

        let headerView = UIView()
        headerView.translatesAutoresizingMaskIntoConstraints = false
        headerView.addSubview(iconLabel)
        headerView.addSubview(titleStack)

        let topDivider = UIView()
        topDivider.translatesAutoresizingMaskIntoConstraints = false
        topDivider.backgroundColor = UIColor(red: 242 / 255, green: 242 / 255, blue: 242 / 255, alpha: 1)

        let iconColor = UIColor(red: 51 / 255, green: 51 / 255, blue: 51 / 255, alpha: 1)
        let symbolConfiguration = UIImage.SymbolConfiguration(pointSize: 24, weight: .medium)

        let reenterItem = makeMiniProgramMenuItem(
            title: "重新进入\n小程序",
            image: UIImage(systemName: "arrow.clockwise", withConfiguration: symbolConfiguration)?
                .withTintColor(iconColor, renderingMode: .alwaysOriginal) ?? UIImage(),
            action: #selector(miniProgramMenuReenterTapped)
        )
        let closeItem = makeMiniProgramMenuItem(
            title: "关闭小程序",
            image: UIImage(systemName: "xmark", withConfiguration: symbolConfiguration)?
                .withTintColor(iconColor, renderingMode: .alwaysOriginal) ?? UIImage(),
            action: #selector(miniProgramMenuCloseTapped)
        )

        let actionStack = UIStackView(arrangedSubviews: [reenterItem, closeItem])
        actionStack.translatesAutoresizingMaskIntoConstraints = false
        actionStack.axis = .horizontal
        actionStack.distribution = .fill
        actionStack.spacing = 16

        let bottomDivider = UIView()
        bottomDivider.translatesAutoresizingMaskIntoConstraints = false
        bottomDivider.backgroundColor = UIColor(red: 237 / 255, green: 237 / 255, blue: 237 / 255, alpha: 1)

        let cancelButton = UIButton(type: .custom)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.setTitle("取消", for: .normal)
        cancelButton.setTitleColor(UIColor(red: 87 / 255, green: 107 / 255, blue: 149 / 255, alpha: 1), for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 18)
        cancelButton.addTarget(self, action: #selector(dismissMiniProgramMenu), for: .touchUpInside)

        guard let presentationView = navigationController?.view ?? parent?.view ?? view else {
            return
        }
        presentationView.addSubview(overlay)
        overlay.addSubview(sheetView)
        sheetView.addSubview(headerView)
        sheetView.addSubview(topDivider)
        sheetView.addSubview(actionStack)
        sheetView.addSubview(bottomDivider)
        sheetView.addSubview(cancelButton)

        let bottomInset = presentationView.safeAreaInsets.bottom
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: presentationView.topAnchor),
            overlay.leadingAnchor.constraint(equalTo: presentationView.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: presentationView.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: presentationView.bottomAnchor),

            sheetView.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            sheetView.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            sheetView.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),

            headerView.topAnchor.constraint(equalTo: sheetView.topAnchor),
            headerView.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
            headerView.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
            headerView.heightAnchor.constraint(equalToConstant: 84),

            iconLabel.leadingAnchor.constraint(equalTo: headerView.leadingAnchor, constant: 24),
            iconLabel.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            iconLabel.widthAnchor.constraint(equalToConstant: 44),
            iconLabel.heightAnchor.constraint(equalToConstant: 44),

            titleStack.leadingAnchor.constraint(equalTo: iconLabel.trailingAnchor, constant: 14),
            titleStack.centerYAnchor.constraint(equalTo: headerView.centerYAnchor),
            titleStack.trailingAnchor.constraint(lessThanOrEqualTo: headerView.trailingAnchor, constant: -24),

            topDivider.topAnchor.constraint(equalTo: headerView.bottomAnchor),
            topDivider.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
            topDivider.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
            topDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            actionStack.topAnchor.constraint(equalTo: topDivider.bottomAnchor, constant: 20),
            actionStack.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor, constant: 24),
            actionStack.widthAnchor.constraint(equalToConstant: 172),
            actionStack.heightAnchor.constraint(equalToConstant: 94),

            bottomDivider.topAnchor.constraint(equalTo: actionStack.bottomAnchor, constant: 20),
            bottomDivider.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
            bottomDivider.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
            bottomDivider.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            cancelButton.topAnchor.constraint(equalTo: bottomDivider.bottomAnchor),
            cancelButton.leadingAnchor.constraint(equalTo: sheetView.leadingAnchor),
            cancelButton.trailingAnchor.constraint(equalTo: sheetView.trailingAnchor),
            cancelButton.heightAnchor.constraint(equalToConstant: 58),
            cancelButton.bottomAnchor.constraint(equalTo: sheetView.bottomAnchor, constant: -bottomInset),
        ])

        miniProgramMenuContainerView = overlay
        presentationView.bringSubviewToFront(overlay)
    }

    private func makeMiniProgramMenuItem(title: String, image: UIImage, action: Selector) -> UIControl {
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.addTarget(self, action: action, for: .touchUpInside)

        let iconContainer = UIView()
        iconContainer.translatesAutoresizingMaskIntoConstraints = false
        iconContainer.backgroundColor = UIColor(red: 248 / 255, green: 248 / 255, blue: 248 / 255, alpha: 1)
        iconContainer.layer.cornerRadius = 10
        iconContainer.isUserInteractionEnabled = false

        let imageView = UIImageView(image: image)
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.contentMode = .center

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = title
        label.font = .systemFont(ofSize: 13)
        label.textColor = UIColor(red: 104 / 255, green: 104 / 255, blue: 104 / 255, alpha: 1)
        label.textAlignment = .center
        label.numberOfLines = 2

        control.addSubview(iconContainer)
        iconContainer.addSubview(imageView)
        control.addSubview(label)

        NSLayoutConstraint.activate([
            control.widthAnchor.constraint(equalToConstant: 78),

            iconContainer.topAnchor.constraint(equalTo: control.topAnchor),
            iconContainer.centerXAnchor.constraint(equalTo: control.centerXAnchor),
            iconContainer.widthAnchor.constraint(equalToConstant: 52),
            iconContainer.heightAnchor.constraint(equalToConstant: 52),

            imageView.centerXAnchor.constraint(equalTo: iconContainer.centerXAnchor),
            imageView.centerYAnchor.constraint(equalTo: iconContainer.centerYAnchor),
            imageView.widthAnchor.constraint(equalToConstant: 24),
            imageView.heightAnchor.constraint(equalToConstant: 24),

            label.topAnchor.constraint(equalTo: iconContainer.bottomAnchor, constant: 8),
            label.leadingAnchor.constraint(equalTo: control.leadingAnchor),
            label.trailingAnchor.constraint(equalTo: control.trailingAnchor),
            label.bottomAnchor.constraint(lessThanOrEqualTo: control.bottomAnchor),
        ])

        return control
    }

    @objc private func dismissMiniProgramMenu() {
        miniProgramMenuContainerView?.removeFromSuperview()
        miniProgramMenuContainerView = nil
    }

    @objc private func miniProgramMenuReenterTapped() {
        dismissMiniProgramMenu()
        Task { @MainActor in
            await app?.reEnter()
        }
    }

    @objc private func miniProgramMenuCloseTapped() {
        dismissMiniProgramMenu()
        closeMiniProgramFromCapsule()
    }

    // Set navigation bar style
    private func setupNavigationBar() {
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationItem.hidesBackButton = true
        navigationItem.backButtonTitle = ""

        let pageRecord = navigator?.pageRecord(webViewId: webview.getWebViewId())
        let navStyle = pageRecord?.navStyle
            ?? app?.getBundleAppConfig()?.getPageConfig(pagePath: pagePath)
        let darkStyle = (navStyle?["navigationBarTextStyle"] as? String) == "white"
        var title = appConfig.appName
        var backgroundColor = UIColor.white
        var textColor = darkStyle ? UIColor.white : UIColor.black
        var isCustomNavigationStyle = false

        if let navStyle = navStyle {
            if let navTitle = navStyle["navigationBarTitleText"] as? String, !navTitle.isEmpty {
                title = navTitle
            }

            if let navigationStyle = navStyle["navigationStyle"] as? String {
                isCustomNavigationStyle = navigationStyle == "custom"
            }

            if let navBackgroundColor = navStyle["navigationBarBackgroundColor"] as? String {
                backgroundColor = DMPUtil.colorFromHexString(navBackgroundColor) ?? .white
            }

            if let navTextStyle = navStyle["navigationBarTextStyle"] as? String {
                textColor = navTextStyle == "white" ? .white : .black
            }

            // Only set default style if navigationItem has not been customized
            // This ensures that styles set via API are not overridden
            if navigationItem.standardAppearance == nil,
                let backgroundColor = navStyle["navigationBarBackgroundColor"] as? String,
                let textStyle = navStyle["navigationBarTextStyle"] as? String
            {

                let darkStyle = textStyle == "white"
                let bgColor = DMPUtil.colorFromHexString(backgroundColor) ?? .white
                let textColor: UIColor = darkStyle ? .white : .black

                let appearance = UINavigationBarAppearance()
                appearance.configureWithOpaqueBackground()
                appearance.backgroundColor = bgColor
                appearance.titleTextAttributes = [.foregroundColor: textColor]

                // Set navigation bar appearance for the current controller
                navigationItem.standardAppearance = appearance
                navigationItem.scrollEdgeAppearance = appearance
                navigationItem.compactAppearance = appearance

                if #available(iOS 15.0, *) {
                    navigationItem.compactScrollEdgeAppearance = appearance
                }

                // Set navigation bar button color
                navigationController?.navigationBar.tintColor = textColor

                DMPUIManager.updateWindowStyle(isDarkTheme: darkStyle)
            }
        }

        updateNavigationTitle(title)
        updateNavigationColor(backgroundColor: backgroundColor, textColor: textColor, darkStyle: darkStyle)

        let leftNav = resolveLeftNavAffordances(
            isCustomNavigationStyle: isCustomNavigationStyle,
            homeButtonForceHidden: pageRecord?.homeButtonForceHidden ?? false,
            homeButtonForcedByConfig: (navStyle?["homeButton"] as? Bool) == true
        )
        customNavigationBackButton?.isHidden = !leftNav.showBack
        customNavigationHomeButton?.isHidden = !leftNav.showHome
        customNavigationHomeButtonBackground?.isHidden = !leftNav.showHome
        // home 键位置随返回箭头存在与否切换：并存时紧随箭头，否则独占左槽
        if leftNav.showBack {
            homeButtonLeadingToEdge?.isActive = false
            homeButtonLeadingAfterBack?.isActive = true
        } else {
            homeButtonLeadingAfterBack?.isActive = false
            homeButtonLeadingToEdge?.isActive = true
        }

        customNavigationBar?.isHidden = isCustomNavigationStyle
        webViewTopToNavigationConstraint?.isActive = !isCustomNavigationStyle
        webViewTopToViewConstraint?.isActive = isCustomNavigationStyle

        if !isCustomNavigationStyle, let customNavigationBar = customNavigationBar {
            view.bringSubviewToFront(customNavigationBar)
        }
    }

    /// 导航栏左侧的两个 affordance（微信真机实测语义）：
    /// 返回箭头 = 非栈底页面；home 键 = 非首页 + 非 tabBar 页（这两条排除
    /// `homeButton: true` 也不能突破）且（栈底自动显示 ‖ 页面配置
    /// `homeButton: true`——此时与返回箭头并存）。`wx.hideHomeButton()` 只压制
    /// home 键。
    private func resolveLeftNavAffordances(
        isCustomNavigationStyle: Bool,
        homeButtonForceHidden: Bool,
        homeButtonForcedByConfig: Bool
    ) -> (showBack: Bool, showHome: Bool) {
        guard !isCustomNavigationStyle else {
            return (false, false)
        }

        // isRoot 表示这个页面在栈底（没有可以返回的上一页）
        let showBack = !isRoot

        if homeButtonForceHidden {
            return (showBack, false)
        }

        guard let bundleAppConfig = app?.getBundleAppConfig() else {
            return (showBack, false)
        }

        if bundleAppConfig.isTabBarPage(pagePath: pagePath) {
            return (showBack, false)
        }

        // entryPagePath 由 DMPBundleAppConfig 统一输出规范形态（无前导斜杠），
        // 只需归一化当前页一侧。pagePath 不保证已归一化：站内路由 URL
        // （navigateTo/redirectTo/switchTab/reLaunch）经 DMPUtil.queryPath 已
        // 归一化，但 tabBar 页的 pagePath 直接取自 tabBar 配置项
        // （DMPTabBarContainerController 的 onSelect/prepareInitialTab），
        // 未经 queryPath，写法不受调用方控制；entry 未知（空）时自动规则关闭
        let entryPagePath = bundleAppConfig.entryPagePath
        if entryPagePath.isEmpty || DMPUtil.normalizePagePath(pagePath) == entryPagePath {
            return (showBack, false)
        }

        return (showBack, isRoot || homeButtonForcedByConfig)
    }

    /// 仅当这个 controller 当前显示的正是 `webViewId` 时才重新计算导航栏（含
    /// home 按钮显隐）；其它页面这里不做任何事——它们的 `viewWillAppear` 会
    /// 重新跑一次 `setupNavigationBar()`，自然会读到后台期间被设置的页面标记
    public func refreshNavigationBar(ifDisplaying webViewId: Int) {
        guard webview.getWebViewId() == webViewId else { return }
        setupNavigationBar()
    }

    // MARK: - Page orientation

    /// Resolved page/app configuration.
    private var computedPageOrientation: DMPPageOrientation {
        let pageRecord = navigator?.pageRecord(webViewId: webview.getWebViewId())
        let navStyle = pageRecord?.navStyle
            ?? app?.getBundleAppConfig()?.getPageConfig(pagePath: pagePath)
        return DMPPageOrientation.parse(navStyle?["pageOrientation"])
            ?? DMPPageOrientation.defaultValue
    }

    private var configuredInterfaceOrientations: UIInterfaceOrientationMask {
        computedPageOrientation.interfaceOrientations
    }

    /// 这一页最终要认领的方向。
    /// A broad auto mask still accepts the orientation forced by the page being replaced, so UIKit has no reason to restore the auto page's target.
    /// Auto therefore publishes one resolved target while the page is visible and recomputes it when device orientation changes.
    /// Device posture is not rotation-lock aware because iOS does not expose the lock state.
    var claimedInterfaceOrientations: UIInterfaceOrientationMask {
        let configured = configuredInterfaceOrientations
        guard computedPageOrientation == .auto,
              let target = autoOrientationTarget,
              configured.contains(target) else {
            return configured
        }
        return target
    }

    /// 转场没结束前不认领方向，交给 UIKit 保持窗口当前朝向；转场结束（`viewDidAppear`）之后才把这一页的 mask 交出去，由 `resyncOrientationOnAppear` 触发那一次旋转。
    ///
    /// 这不是保守起见：转场动画进行中窗口跟着新栈顶转，UIKit 有相当概率把这次转场判成被打断。
    /// push 方向上的后果是刚压进去的页当场被摘出栈（`viewDidDisappear` 带 `isMovingFromParent` → 销毁 WebView），用户看到空白再弹回上一页；真机对照实测（同一台机器交替分块、两臂只差这一段）：落地后才认领 0/76，落地前就认领 14/67。
    ///
    /// pop 方向上的后果是被弹掉的页回到栈里：它的 `pageUnload` 已经送出去、JS 侧的页面已经销毁，回来的是一个还锁着自己方向的空壳，用户卡在横屏出不去（真机 14/54）。
    ///
    /// 三个判据各自回答一个问题：
    /// - `hasLandedOnScreen`：我是不是此刻已经落定在屏幕上的那一页。它在 `viewDidDisappear`
    /// 清掉，所以被压在下面、正被 pop 回来的页答的是否。
    /// tab 容器切换子页不走 appearance 回调（只切 `isHidden`），被切走的子页因此保持真——它的 mask 只经容器转给当前子页，隐藏子页根本不参与判定。
    /// - `viewIfLoaded?.window != nil`：我的视图此刻真的在窗口里吗。pop 刚发起时目的页的视图
    /// 还没挂进窗口，真机 50 个试次里 51 次那种查询**全部**是 `noWindow=true`，而 1396 次正当的认领**全部**是 `noWindow=false`——这一项独立于上一项挡住同一个错误。
    /// - `isNavigationTransitionInFlight`：这次转场是不是还在飞，兜住 appearance 没有走完整
    ///   一轮的情形（例如非全屏 present 盖上来再 dismiss，下面那页从没 disappear 过）。
    public override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        guard navigator?.pageOrientationSupport == .supported else {
            return super.supportedInterfaceOrientations
        }
        if Self.shouldClaimOrientation(
            hasLanded: hasLandedOnScreen,
            isOnScreen: viewIfLoaded?.window != nil,
            isTransitioning: isNavigationTransitionInFlight
        ) {
            return claimedInterfaceOrientations
        }
        return Self.orientationsHoldingCurrentWindow(
            current: currentWindowInterfaceOrientation
        ) ?? super.supportedInterfaceOrientations
    }

    /// 什么时候可以把这一页自己的 mask 交给 UIKit：三个条件都成立。
    static func shouldClaimOrientation(hasLanded: Bool, isOnScreen: Bool, isTransitioning: Bool) -> Bool {
        hasLanded && isOnScreen && !isTransitioning
    }

    /// 这一页所在窗口此刻的界面方向。
    /// 转场刚开始时这一页的 view 还没挂进窗口（`view.window == nil`），退到它所在导航控制器的窗口才问得到；问不到就会退化成 UIKit 默认的任意方向，「维持当前朝向」等于没维持。
    private var currentWindowInterfaceOrientation: UIInterfaceOrientation? {
        let window = viewIfLoaded?.window ?? navigationController?.view.window
        return window?.windowScene?.interfaceOrientation
    }

    /// 还没落地时交出去的 mask：只框住窗口此刻的朝向，等于「别转」。
    /// 读不到朝向（视图还没进窗口）时返回 nil，由调用方退回 UIKit 默认。
    static func orientationsHoldingCurrentWindow(
        current: UIInterfaceOrientation?
    ) -> UIInterfaceOrientationMask? {
        guard let current else { return nil }
        return mask(for: current)
    }

    /// Whether this controller is the one actually on screen right now — either directly on top of the navigation stack, or the selected tab inside `DMPTabBarContainerController` when that container is on top.
    private var isCurrentlyDisplayed: Bool {
        guard let top = navigator?.navigationController?.topViewController else {
            return false
        }
        if top === self {
            return true
        }
        return (top as? DMPTabBarContainerController)?.currentPageController === self
    }

    /// Forces the system to re-query `supportedInterfaceOrientations` for this page.
    func applyOrientationIfNeeded() {
        // 普通 UINavigationController 不把页面 mask 转给窗口，能力不可用时保持 no-op。
        guard navigator?.pageOrientationSupport == .supported else { return }

        let expected = claimedInterfaceOrientations
        if Self.isTargetGeometrySettled(
            expected: expected,
            targetSize: view.window?.bounds.size ?? .zero
        ) {
            geometryRequestGeneration += 1
            activeGeometryRequest = nil
            refreshSupportedInterfaceOrientations()
            return
        }
        submitGeometryUpdate(expected: expected)
    }

    private func refreshSupportedInterfaceOrientations() {
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    @discardableResult
    private func submitGeometryUpdate(expected: UIInterfaceOrientationMask) -> Int {
        if let active = activeGeometryRequest, active.expected == expected {
            return active.generation
        }

        geometryRequestGeneration += 1
        let generation = geometryRequestGeneration
        activeGeometryRequest = (generation, expected)

        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            guard Self.shouldSubmitGeometryRequest(
                isTransitioning: isNavigationTransitionInFlight,
                hasLanded: hasLandedOnScreen
            ) else {
                // 作废这次请求，让 viewDidAppear 上的 settlePendingPageShowOnAppear / resyncOrientationOnAppear 重新提交（相同 expected 会被去重，不清掉就再也提交不出去）；转场那一路另外挂一次转场完成回调兜底。
                activeGeometryRequest = nil
                resubmitGeometryUpdateWhenTransitionEnds()
                return generation
            }
            guard let windowScene = view.window?.windowScene else {
                // 视图还没进窗口——push 的同步阶段正是这样，UIKit 要到转场开始才把它挂上去。
                // 这不是平台拒绝，只是此刻问不到 scene，所以**不能**放行押着的 pageShow：放行等于从没押过，onShow 会读到上一页的方向。
                // 作废这次请求，让 viewDidAppear 上的 settlePendingPageShowOnAppear 能重新提交（submitGeometryUpdate 对相同 expected 会去重，不清掉就再也提交不出去）。
                activeGeometryRequest = nil
                return generation
            }
            windowScene.requestGeometryUpdate(
                .iOS(interfaceOrientations: expected)
            ) { [weak self] error in
                DispatchQueue.main.async {
                    self?.handleGeometryUpdateFailure(generation: generation, error: error)
                }
            }
        } else {
            UIViewController.attemptRotationToDeviceOrientation()
        }
        return generation
    }

    /// 转场结束后补提交一次刚被作废的方向请求。
    ///
    /// 常规 push 由 `viewDidAppear` 承担这次补提交，但页面的 appearance 有可能在请求发出
    /// **之前**就已经结清：从内页 `switchTab` 到一个还没加载过的 tab 时，容器先 pop（转场
    /// 开始），新 tab 的 view 才被挂进已经在窗口里的容器，它的 `viewDidAppear` 因此可能早于 `notifyPageShow` 登记 pendingPageShow。
    /// 那种情况下不会再有第二次 `viewDidAppear`，押着的 pageShow 没有别的放行者——固定方向页连设备旋转重试都没有（只有 auto 页有）。
    ///
    /// 只在页面已经落地且正在显示时才补提交：还没落地时 `supportedInterfaceOrientations` 交出去的仍是「维持窗口当前朝向」，此刻提交问不出这一页要的方向，交给 `viewDidAppear`。
    private func resubmitGeometryUpdateWhenTransitionEnds() {
        guard let coordinator = transitionCoordinator ?? navigationController?.transitionCoordinator else {
            return
        }
        _ = coordinator.animate(alongsideTransition: nil) { [weak self] _ in
            guard let self,
                  Self.shouldResubmitGeometryAfterTransition(
                      hasLanded: self.hasLandedOnScreen,
                      isDisplayed: self.isCurrentlyDisplayed
                  )
            else { return }
            self.applyOrientationIfNeeded()
        }
    }

    static func shouldResubmitGeometryAfterTransition(hasLanded: Bool, isDisplayed: Bool) -> Bool {
        hasLanded && isDisplayed
    }

    /// 这一页所在的导航栈是不是正在做 push/pop 转场。
    /// 转场期间栈顶已经换成了新页，`topViewController` 因此已经是它，但动画还没结束。
    private var isNavigationTransitionInFlight: Bool {
        transitionCoordinator != nil || navigationController?.transitionCoordinator != nil
    }

    /// 什么时候可以真的向系统提交方向请求。两个条件各自独立：
    ///
    /// - 转场期间不发。push/pop 本身就是 UIKit 重新评估方向的时机，紧邻的
    /// `setNeedsUpdateOfSupportedInterfaceOrientations()` 已经让它按新栈顶重查一次并把旋转并进同一段动画；此时再发一条竞争的 `requestGeometryUpdate`，UIKit 有几率把正在进行的 push 判成被打断，把刚压进去的页从栈里摘掉——那一页的 `viewDidDisappear` 带着 `isMovingFromParent` 走销毁，WebView 还没开始加载就被回收，用户看到空白页。
    /// - 页面落地前不发。落地前 `supportedInterfaceOrientations` 交出去的还是「维持窗口当前
    /// 朝向」，此刻提交一个与之矛盾的方向**一定**会被系统拒绝，而拒绝会被 `handleGeometryUpdateFailure` 当成「平台不肯转」：押着的 pageShow 被就地放行，并照旋转前的几何补报一次。
    /// 固定方向页两条 resize 通道都被抑制，那份错几何再没有纠正机会——真机实测过 tab 切到固定横屏 tab 时 `onShow` 读到 393×759 并写进页面 data。
    ///
    /// 两种情形都不改变能力语义：请求只是推迟到 `viewDidAppear`（或转场完成回调）重新提交。
    static func shouldSubmitGeometryRequest(isTransitioning: Bool, hasLanded: Bool) -> Bool {
        !isTransitioning && hasLanded
    }

    private func handleGeometryUpdateFailure(generation: Int, error: Error) {
        guard let failedRequest = activeGeometryRequest,
              failedRequest.generation == generation
        else { return }
        activeGeometryRequest = nil

        // A rejected platform request produces no transition callback. pageShow must therefore continue with the geometry that actually remains on screen instead of waiting forever.
        releasePendingPageShowAfterOrientationFailure()
    }

    private func releasePendingPageShowAfterOrientationFailure() {
        guard let pending = pendingPageShow,
              Self.shouldReleasePageShowAfterOrientationFailure(
                  isDisplayed: isCurrentlyDisplayed,
                  pendingGeneration: pending.generation,
                  currentGeneration: pageShowGeneration
              )
        else { return }
        pendingPageShow = nil
        Task { @MainActor in
            await pending.action()
            // 请求已经结案、窗口不会再因为它转了：此刻读到的就是这一页会一直保持的几何。
            // 不能走 reportRouteGeometry——它要求窗口已经转到这一页要求的方向，而这里正是转不过去的那条路。
            // Android 的 Ignore 分支与 Harmony 的 releasePageShowWithoutNewGeometry 在同一情形下也是照当前几何报一次。
            await self.reportCurrentRouteGeometry()
        }
    }

    /// 方向请求结案后照**当前**几何报一次路由落地。
    /// 放行在前、上报在后：service 只把已经 show 的页登记成 `Page.onResize` 的收件人。
    private func reportCurrentRouteGeometry() async {
        guard isCurrentlyDisplayed, let size = view.window?.bounds.size else { return }
        await notifyPageResize(targetSize: size, callSite: "reportCurrentRouteGeometry")
    }

    static func shouldReleasePageShowAfterOrientationFailure(
        isDisplayed: Bool,
        pendingGeneration: Int?,
        currentGeneration: Int
    ) -> Bool {
        isDisplayed && pendingGeneration == currentGeneration
    }

    /// Resolves auto from device posture, then falls back to this page's last displayed interface orientation when posture is unavailable.
    /// With neither fact, UIKit keeps the broad auto mask.
    private var autoOrientationTarget: UIInterfaceOrientationMask? {
        // UIDevice 描述的是设备顶部朝哪，与界面方向左右相反
        switch UIDevice.current.orientation {
        case .portrait:
            return .portrait
        case .landscapeLeft:
            return .landscapeRight
        case .landscapeRight:
            return .landscapeLeft
        default:
            break
        }
        guard let remembered = lastDisplayedInterfaceOrientation else {
            return nil
        }
        return Self.mask(for: remembered)
    }

    private static func mask(for orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask? {
        switch orientation {
        case .portrait:
            return .portrait
        case .portraitUpsideDown:
            return .portraitUpsideDown
        case .landscapeLeft:
            return .landscapeLeft
        case .landscapeRight:
            return .landscapeRight
        default:
            return nil
        }
    }

    /// 只在这一页确实是当前显示页时记账：`viewWillTransition` 会被容器链转发给栈里所有页面（含被压在下面的），不加这道判据的话，上层固定横屏页把窗口转过去时会把「横屏」写进下面那个 auto 页的记忆里，返回时就再也转不回来了
    private func rememberDisplayedOrientationIfNeeded() {
        guard isCurrentlyDisplayed,
              let orientation = view.window?.windowScene?.interfaceOrientation,
              orientation != .unknown else {
            return
        }
        lastDisplayedInterfaceOrientation = orientation
    }

    /// 页面真正露面之后（push 落地、从上层页面 pop 回到这一页）重新把方向推给窗口。
    /// 只靠 UIKit 在换页时自己的重查不够：mask 从 `.landscape` 放宽回 `.allButUpsideDown` 时，当前的横屏仍落在新 mask 里，UIKit 就不会主动转回来 ——竖屏设备上从锁死横屏的页面返回 auto 页会一直停在横屏，直到下一次真实的设备旋转；而且窗口几何没变，`viewWillTransition` 不触发，这一页连 `Page.onResize` 都收不到，JS 侧读到的仍是加载时那份竖屏几何。
    /// 放在 `viewDidAppear` 而不是 `viewWillAppear`：交互式返回手势可能中途取消，那时这一页并没有真的接管屏幕，不该由它决定窗口方向。
    private func resyncOrientationOnAppear() {
        guard isCurrentlyDisplayed else { return }
        applyOrientationIfNeeded()
    }

    /// 只在这一页显示期间盯着设备姿态：`auto` 的目标方向由传感器决定，姿态一变就要重新解算 mask，否则上面那张窄 mask 会把用户的真实旋转挡住。
    /// 非显示页不订阅 —— 它的 mask 根本不参与判定，改了也没人问。
    private func startObservingDeviceOrientation() {
        guard deviceOrientationObserver == nil else { return }
        deviceOrientationObserver = NotificationCenter.default.addObserver(
            forName: UIDevice.orientationDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self, self.isCurrentlyDisplayed, self.computedPageOrientation == .auto else {
                return
            }
            self.applyOrientationIfNeeded()
        }
    }

    private func stopObservingDeviceOrientation() {
        guard let observer = deviceOrientationObserver else { return }
        deviceOrientationObserver = nil
        NotificationCenter.default.removeObserver(observer)
    }

    /// 路由落地后把当前页所在窗口的几何报一次，不比对几何：`Page.onResize` 的收件人由宿主指名，每次路由（含 appLaunch）都报落点页。
    ///
    /// `viewWillTransition` 只在窗口真的转动时触发，所以「被压住期间窗口转过去、回来时窗口不再动一次」这一类只有这条能覆盖；tab 切换更是连 `viewDidAppear` 都不走（容器只切 `isHidden`），同样只剩这条。
    private func reportRouteGeometry() async {
        let size = view.window?.bounds.size
        guard Self.shouldReportRouteGeometry(
            isDisplayed: isCurrentlyDisplayed,
            expected: claimedInterfaceOrientations,
            currentSize: size
        ), let size else { return }
        await notifyPageResize(targetSize: size, callSite: "reportRouteGeometry")
    }

    /// 路由落地时该不该把几何报出去。
    /// 只看「这一页真的在屏幕上」和「窗口已经转到它要求的方向」；几何变没变不在判据里——页面通道由宿主指名，不按几何去重。
    ///
    /// 窗口还没转到位时不报：随之而来的 `viewWillTransition` 会带着目标尺寸报，这里先报一次就等于多给业务代码一份中途尺寸。
    static func shouldReportRouteGeometry(
        isDisplayed: Bool,
        expected: UIInterfaceOrientationMask,
        currentSize: CGSize?
    ) -> Bool {
        guard isDisplayed, let currentSize else { return false }
        return isTargetGeometrySettled(expected: expected, targetSize: currentSize)
    }

    private func settleGeometryRequest(targetSize: CGSize) {
        if let active = activeGeometryRequest,
           Self.isTargetGeometrySettled(expected: active.expected, targetSize: targetSize)
        {
            activeGeometryRequest = nil
        }
    }

    /// pageShow must observe the geometry of the page becoming visible, not the page it replaces.
    /// When direction changes, the transition's target size is the first authoritative new geometry; queue pageShow behind that snapshot.
    /// A monotonic generation and visibility check make late transition callbacks unable to revive a page that has already been superseded.
    func notifyPageShowAfterOrientationSettles(
        _ action: @escaping @MainActor () async -> Void
    ) {
        pageShowGeneration += 1
        let generation = pageShowGeneration
        pendingPageShow = nil

        guard navigator?.pageOrientationSupport == .supported else {
            Task { @MainActor in await action() }
            return
        }

        let expected = claimedInterfaceOrientations
        let currentSize = view.window?.bounds.size
        guard !Self.shouldRunPageShowImmediately(
            isDisplayed: isCurrentlyDisplayed,
            expected: expected,
            currentSize: currentSize,
            canRequestGeometry: Self.canRequestWindowGeometry
        ) else {
            // 路由落地 = pageShow 之后紧跟一条几何上报，见 `reportRouteGeometry`。
            Task { @MainActor in
                await action()
                await self.reportRouteGeometry()
            }
            return
        }

        pendingPageShow = (generation, expected, action)
        if isCurrentlyDisplayed {
            applyOrientationIfNeeded()
        }
    }

    private func settlePendingPageShowOnAppear() {
        guard let pending = pendingPageShow,
              pending.generation == pageShowGeneration
        else { return }

        if Self.shouldRunPageShowImmediately(
            isDisplayed: true,
            expected: pending.expected,
            currentSize: view.window?.bounds.size,
            canRequestGeometry: Self.canRequestWindowGeometry
        ) {
            pendingPageShow = nil
            Task { @MainActor in
                await pending.action()
                await self.reportRouteGeometry()
            }
            return
        }
        applyOrientationIfNeeded()
    }

    /// 押着的 pageShow 在窗口转到位时放行。
    /// 这里**不**自己补几何上报：唯一的调用点 `viewWillTransition` 紧接着就用转场的目标尺寸报一次，而此刻 `view.window.bounds` 可能还停在转场前的尺寸——自己报就等于先给业务代码一份旧几何。
    private func flushPendingPageShow(targetSize: CGSize) async {
        guard isCurrentlyDisplayed,
              let pending = pendingPageShow,
              pending.generation == pageShowGeneration,
              Self.isTargetGeometrySettled(expected: pending.expected, targetSize: targetSize)
        else {
            return
        }
        pendingPageShow = nil
        await pending.action()
    }

    /// 平台上有没有能真正把窗口转过去的接口。
    /// iOS 16 之前只有 `attemptRotationToDeviceOrientation()`，它按设备**物理姿态**重新评估支持的方向，转不到设备当前不在的方向，也没有成功/失败回调。
    static var canRequestWindowGeometry: Bool {
        if #available(iOS 16.0, *) { return true }
        return false
    }

    /// 押后 pageShow 的前提是容器能证明窗口接下来一定会转；证明不了就必须立刻放行，否则没有任何回调会来放行它，这一页永远收不到 onShow。
    ///
    /// - Parameter canRequestGeometry: 见 ``canRequestWindowGeometry``。为 false 时容器
    /// 根本没有手段让窗口转过去，判据恒为「立刻放行」——与 HarmonyOS 的 auto 页、Android 的能力关闭路径是同一条语义。
    static func shouldRunPageShowImmediately(
        isDisplayed: Bool,
        expected: UIInterfaceOrientationMask,
        currentSize: CGSize?,
        canRequestGeometry: Bool
    ) -> Bool {
        guard canRequestGeometry else { return true }
        guard isDisplayed, let currentSize else { return false }
        return isTargetGeometrySettled(expected: expected, targetSize: currentSize)
    }

    /// 能不能当成窗口事实上报：宽高都是正的有限数。
    static func isReportableWindowSize(_ size: CGSize) -> Bool {
        size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0
    }

    static func isTargetGeometrySettled(
        expected: UIInterfaceOrientationMask,
        targetSize: CGSize
    ) -> Bool {
        let target: UIInterfaceOrientationMask = targetSize.width > targetSize.height
            ? .landscape
            : .portrait
        return !expected.intersection(target).isEmpty
    }

    public override func viewWillTransition(
        to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator
    ) {
        super.viewWillTransition(to: size, with: coordinator)
        guard navigator?.pageOrientationSupport == .supported else { return }

        coordinator.animate(alongsideTransition: { [weak self] _ in
            guard let self else { return }
            // UIKit 在旋转和导航转场撞在一起时会把旋转差量叠加两次的尺寸交出来：真机抓到的 -66×1311 正好是 (2W−H, 2H−W)，W=393、H=852。
            // 宽或高不是正有限数就不是任何窗口的事实：拿它判方向会判反（-66<1311 会判成竖屏），送进 JS 会让 rpx 基准变成负数，非有限数过 JSON 通道更是直接崩。
            guard Self.isReportableWindowSize(size) else {
                DMPLogger.debug(
                    "viewWillTransition got an impossible size \(size) for \(self.pagePath), ignored"
                )
                // 这一段同时跳过了 settleGeometryRequest，在飞的那次请求就没有结算者了。
                // 作废它，让后面实读窗口的那条路（`viewDidAppear` 的 resyncOrientationOnAppear）能重新提交——不清掉的话相同 expected 会被去重吞掉。
                //
                // 已知丢失面：转场在飞时，落点页的 `viewDidAppear` 会补上这次几何；但「已在屏、无 pendingPageShow 的页碰上这种尺寸」没有补报者，那一次旋转的 `Page.onResize` / `wx.onWindowResize` 对 JS 丢失，要等下一次真实旋转才纠正。
                // `wx.getWindowInfo` 是活读，不受影响。
                // 送毒数据比丢一次更糟。
                self.activeGeometryRequest = nil
                return
            }
            Task { @MainActor in
                self.settleGeometryRequest(targetSize: size)
                // 押着的 pageShow 先放行：service 只把已经 show 的页面登记成 `Page.onResize` 的收件人，反过来这条几何就送不到它手上。
                await self.flushPendingPageShow(targetSize: size)
                await self.notifyPageResize(targetSize: size, callSite: "viewWillTransition")
            }
        }, completion: { [weak self] _ in
            self?.rememberDisplayedOrientationIfNeeded()
        })
    }

    /// Pushes the post-rotation window size to JS mid-animation (inside `alongsideTransition`), not from `completion`: UIKit's own rotation animation runs roughly 0.3s, and a page that derives its own layout from `windowWidth`/`windowHeight` (rpx, canvas backdrops, custom nav bars, scroll-view heights) would otherwise render at the old size for the whole animation and only snap to the new layout once it ends.
    ///
    /// 这里只上报原始事实加上判据需要的 `pageOrientation`：`wx.onWindowResize` 要不要响、固定方向页要不要保持沉默都由 service 的 `resolveResizeDispatch` 判定，哪一页收到 `Page.onResize` 则由这次上报的接收方决定。
    /// 容器只在「窗口真的转了」（`viewWillTransition`）和「路由刚落地」（`reportRouteGeometry`）两个时机调用它。
    private func notifyPageResize(targetSize: CGSize, callSite: String) async {
        // 容器只在自己是当前可见页时才是权威：viewWillTransition 由包含链统一转发给栈里所有页面（含被压在下面、被切走的 tab），非可见页收到的 targetSize 并不代表它自己真实展示时的尺寸
        guard let app, isCurrentlyDisplayed else { return }

        let pageRecord = navigator?.pageRecord(webViewId: webview.getWebViewId())
        let navStyle = pageRecord?.navStyle ?? app.getBundleAppConfig()?.getPageConfig(pagePath: pagePath)
        let originalPageOrientation = navStyle?["pageOrientation"] as? String ?? "portrait"

        // 与 DMPUIManager.getDeviceDisplayInfo() 同一套公式（宽度取整窗宽，高度扣顶部+底部安全区），但基于 viewWillTransition 传入的目标尺寸而非当时可能仍处于过渡中的 window.bounds
        let safeAreaInsets = DMPUIManager.shared.getSafeAreaInsets()
        let windowWidth = targetSize.width
        let windowHeight = max(targetSize.height - safeAreaInsets.top - safeAreaInsets.bottom, 0)
        let deviceOrientation = targetSize.width > targetSize.height ? "landscape" : "portrait"

        // 屏幕尺寸取 targetSize 本身，不读 `UIScreen.bounds`：容器窗口在本 SDK 里始终铺满屏幕，而 `UIScreen.bounds` 和 `window.bounds` 一样可能还停在转场前的方向，用它会在动画期间报出竖屏的屏幕配横屏的窗口。
        // 与窗口尺寸的差就是上下安全区，两组随旋转一起换宽高。

        let message = DMPMap([
            "type": "pageResize",
            "body": [
                "bridgeId": webview.getWebViewId(),
                "size": [
                    "screenWidth": targetSize.width,
                    "screenHeight": targetSize.height,
                    "windowWidth": windowWidth,
                    "windowHeight": windowHeight,
                ],
                "deviceOrientation": deviceOrientation,
                "pageOrientation": [
                    "originalPageOrientation": originalPageOrientation,
                ],
            ],
        ])
        await app.service?.postMessage(data: message)
    }

    // Back button tap event
    @objc private func backButtonTapped() {
        if let navigator = navigator {
            navigator.handleBackButtonTapped()
        } else {
            navigationController?.popViewController(animated: true)
        }
    }

    // Get WebView instance
    public func getWebView() -> DMPWebview {
        return webview
    }

    // Called when page is shown
    public func onShow() {
        // Add your logic here
    }
    
    // MARK: - Lifecycle Methods
    
    public override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        pageShowGeneration += 1
        pendingPageShow = nil
        geometryRequestGeneration += 1
        activeGeometryRequest = nil
        // 离开屏幕就不再是方向的主人：下次露面要重新落定才认领。
        hasLandedOnScreen = false
        // 隐藏页的 mask 不参与窗口决策，不继续消费物理姿态；重新露面时会按当时的传感器或该页最后显示方向重新解算并提交。
        stopObservingDeviceOrientation()
        endGeneratingDeviceOrientationNotificationsIfNeeded()
        hidePageLoading()

        // Notify lifecycle management when page completely disappears
        if isMovingFromParent {
            // Page is removed from navigation stack
            destroyWebView()
        }
    }

    private func beginGeneratingDeviceOrientationNotificationsIfNeeded() {
        guard !isGeneratingDeviceOrientationNotifications else { return }
        isGeneratingDeviceOrientationNotifications = true
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
    }

    /// 与 begin 严格一进一出：`UIDevice` 的方向通知是全进程引用计数，多退一次会把宿主 app 自己开的那份扣穿。
    /// 页面销毁时若还没配对上，`deinit` 里补一次
    private func endGeneratingDeviceOrientationNotificationsIfNeeded() {
        guard isGeneratingDeviceOrientationNotifications else { return }
        isGeneratingDeviceOrientationNotifications = false
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }
    
    // Destroy WebView
    private func destroyWebView() {
        // Add state check to prevent duplicate destruction
        guard !isWebViewDestroyed else {
            DMPLogger.debug("🟡 DMPPageController: WebView (ID: \(webview.getWebViewId())) has already been destroyed, skipping duplicate operation")
            return
        }
        
        DMPLogger.debug("🗑️ DMPPageController: Destroy WebView (ID: \(webview.getWebViewId()))")
        isWebViewDestroyed = true
        webview.clearLoadingStateObserver(ownerToken: loadingStateObserverToken)
        
        // Notify page unload
        if let app = app {
            let msg = DMPMap([
                "type": "pageUnload",
                "body": [
                    "bridgeId": webview.getWebViewId()
                ]
            ])
            DMPChannelProxy.containerToService(msg: msg, app: app)
        }
        
        // Release WebView back to pool
        app?.render?.releaseWebView(webview)
    }
    
    // Manual destroy method (for external calls)
    public func destroy() {
        destroyWebView()
    }
    
    deinit {
        DMPLogger.debug("🗑️ DMPPageController: deinit (WebView ID: \(webview.getWebViewId()))")
        stopObservingDeviceOrientation()
        endGeneratingDeviceOrientationNotificationsIfNeeded()
        webview.clearLoadingStateObserver(ownerToken: loadingStateObserverToken)
        // Ensure WebView is correctly released
        destroyWebView()
    }
}

// SwiftUI view container for displaying WebView
public struct DMPWebViewContainer: View {
    @ObservedObject var webview: DMPWebview
    var isRoot: Bool = false

    public init(webview: DMPWebview, isRoot: Bool = false) {
        self.webview = webview
        self.isRoot = isRoot
    }

    public var body: some View {
        ZStack {
            DMPWebview.WebViewRepresentable(webview: webview)
        }
        .ignoresSafeArea(.container, edges: [.top, .bottom])
    }
}
