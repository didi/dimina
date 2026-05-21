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
    private var hostingController: UIHostingController<DMPWebViewContainer>?
    private var customNavigationBar: UIView?
    private var customNavigationContentView: UIView?
    private var customNavigationTitleLabel: UILabel?
    private var customNavigationBackButton: UIButton?
    private var customNavigationCapsuleView: UIView?
    private var customNavigationCapsuleMoreButton: UIButton?
    private var customNavigationCapsuleCloseButton: UIButton?
    private var customNavigationCapsuleSeparatorView: UIView?
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
        
        print("🔧 DMPPageController: WebView (ID: \(webview.getWebViewId())) configuration completed, current page path: \(webview.getPagePath())")
        
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
        setupNavigationBar()
        showPageLoadingIfNeeded()
    }

    public override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if let customNavigationBar = customNavigationBar, !customNavigationBar.isHidden {
            view.bringSubviewToFront(customNavigationBar)
        }
        if let customNavigationCapsuleView = customNavigationCapsuleView {
            view.bringSubviewToFront(customNavigationCapsuleView)
        }
        if let miniProgramMenuContainerView = miniProgramMenuContainerView {
            view.bringSubviewToFront(miniProgramMenuContainerView)
        }
        loadingView?.superview?.bringSubviewToFront(loadingView!)
    }

    // View did appear
    public override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        startLoadingIfNeeded()
    }

    private func startLoadingIfNeeded() {
        guard !hasStartedLoading, !isWebViewDestroyed else {
            return
        }

        hasStartedLoading = true
        showPageLoadingIfNeeded()
        webview.poolState = .loading
        var enableVConsole = appConfig.isDebugMode
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
        webview.onLoadingStateChanged = { [weak self] isLoading in
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

        let titleLabel = UILabel()
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.textAlignment = .center
        titleLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail

        let capsuleView = makeCapsuleButton()
        let menuButtonRect = MenuAPI.getMenuButtonBoundingClientRect()
        let capsuleWidth = CGFloat(menuButtonRect.getDouble(key: "width") ?? 87)
        let capsuleHeight = CGFloat(menuButtonRect.getDouble(key: "height") ?? 32)
        let screenWidth = UIScreen.main.bounds.width
        let capsuleRight = CGFloat(menuButtonRect.getDouble(key: "right") ?? (screenWidth - 10))
        let capsuleTrailing = screenWidth - capsuleRight

        view.addSubview(navigationBar)
        view.addSubview(capsuleView)
        navigationBar.addSubview(contentView)
        contentView.addSubview(backButton)
        contentView.addSubview(titleLabel)

        NSLayoutConstraint.activate([
            navigationBar.topAnchor.constraint(equalTo: view.topAnchor),
            navigationBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            navigationBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            contentView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            contentView.leadingAnchor.constraint(equalTo: navigationBar.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: navigationBar.trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: navigationBar.bottomAnchor),
            contentView.heightAnchor.constraint(equalToConstant: 44),

            backButton.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 8),
            backButton.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            backButton.widthAnchor.constraint(equalToConstant: 44),
            backButton.heightAnchor.constraint(equalToConstant: 44),

            titleLabel.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            titleLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: backButton.trailingAnchor, constant: 8),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -110),

            capsuleView.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            capsuleView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -capsuleTrailing),
            capsuleView.widthAnchor.constraint(equalToConstant: capsuleWidth),
            capsuleView.heightAnchor.constraint(equalToConstant: capsuleHeight),
        ])

        customNavigationBar = navigationBar
        customNavigationContentView = contentView
        customNavigationBackButton = backButton
        customNavigationTitleLabel = titleLabel
        customNavigationCapsuleView = capsuleView
    }

    private func makeCapsuleButton() -> UIView {
        let capsuleView = UIView()
        capsuleView.translatesAutoresizingMaskIntoConstraints = false
        capsuleView.layer.cornerRadius = 16
        capsuleView.layer.borderWidth = 0.5
        capsuleView.layer.shadowColor = UIColor.black.cgColor
        capsuleView.layer.shadowOpacity = 0.08
        capsuleView.layer.shadowRadius = 2
        capsuleView.layer.shadowOffset = CGSize(width: 0, height: 1)

        let moreButton = UIButton(type: .custom)
        moreButton.translatesAutoresizingMaskIntoConstraints = false
        moreButton.contentHorizontalAlignment = .center
        moreButton.contentVerticalAlignment = .center
        moreButton.setImage(makeCapsuleMoreImage(color: UIColor(red: 31 / 255, green: 31 / 255, blue: 31 / 255, alpha: 1)), for: .normal)
        moreButton.accessibilityLabel = "More"
        moreButton.addTarget(self, action: #selector(capsuleMoreButtonTapped), for: .touchUpInside)

        let closeButton = UIButton(type: .custom)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.contentHorizontalAlignment = .center
        closeButton.contentVerticalAlignment = .center
        closeButton.setImage(makeCapsuleCloseImage(color: UIColor(red: 31 / 255, green: 31 / 255, blue: 31 / 255, alpha: 1)), for: .normal)
        closeButton.accessibilityLabel = "Close"
        closeButton.addTarget(self, action: #selector(capsuleCloseButtonTapped), for: .touchUpInside)

        let separatorView = UIView()
        separatorView.translatesAutoresizingMaskIntoConstraints = false

        capsuleView.addSubview(moreButton)
        capsuleView.addSubview(separatorView)
        capsuleView.addSubview(closeButton)

        NSLayoutConstraint.activate([
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

        customNavigationCapsuleMoreButton = moreButton
        customNavigationCapsuleCloseButton = closeButton
        customNavigationCapsuleSeparatorView = separatorView

        return capsuleView
    }

    private func makeCapsuleMoreImage(color: UIColor) -> UIImage {
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

    private func makeCapsuleCloseImage(color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 22, height: 22))
        return renderer.image { context in
            let cgContext = context.cgContext
            let center = CGPoint(x: 11, y: 11)

            color.setStroke()
            cgContext.setLineWidth(2.4)
            cgContext.strokeEllipse(in: CGRect(x: 3.2, y: 3.2, width: 15.6, height: 15.6))

            color.setFill()
            cgContext.fillEllipse(in: CGRect(x: center.x - 3.1, y: center.y - 3.1, width: 6.2, height: 6.2))
        }.withRenderingMode(.alwaysOriginal)
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
        updateCustomCapsuleButton(darkStyle: darkStyle)
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

    @objc private func customBackButtonTapped() {
        navigator?.handleBackButtonTapped()
    }

    private func updateCustomCapsuleButton(darkStyle: Bool) {
        customNavigationCapsuleView?.backgroundColor = .white
        let borderColor = UIColor(red: 229 / 255, green: 229 / 255, blue: 229 / 255, alpha: 1)
        customNavigationCapsuleView?.layer.borderColor = borderColor.cgColor
        customNavigationCapsuleSeparatorView?.backgroundColor = UIColor(red: 233 / 255, green: 233 / 255, blue: 233 / 255, alpha: 1)
    }

    @objc private func capsuleMoreButtonTapped() {
        showMiniProgramMenu()
    }

    @objc private func capsuleCloseButtonTapped() {
        guard !isClosingMiniProgram else {
            return
        }
        isClosingMiniProgram = true
        let appToDestroy = app

        dismissMiniProgramMenu()
        customNavigationCapsuleMoreButton?.isEnabled = false
        customNavigationCapsuleCloseButton?.isEnabled = false

        if let navigationController = navigationController {
            navigationController.view.endEditing(true)
            if navigationController.viewControllers.first === self {
                navigationController.dismiss(animated: true) {
                    appToDestroy?.destroy()
                }
                return
            }

            CATransaction.begin()
            CATransaction.setCompletionBlock {
                appToDestroy?.destroy()
            }
            navigationController.popToRootViewController(animated: true)
            CATransaction.commit()
        } else {
            dismiss(animated: true) {
                appToDestroy?.destroy()
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

        let reenterItem = makeMiniProgramMenuItem(
            title: "重新进入\n小程序",
            image: makeMenuReenterImage(),
            action: #selector(miniProgramMenuReenterTapped)
        )
        let closeItem = makeMiniProgramMenuItem(
            title: "关闭小程序",
            image: makeMenuCloseImage(),
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

        view.addSubview(overlay)
        overlay.addSubview(sheetView)
        sheetView.addSubview(headerView)
        sheetView.addSubview(topDivider)
        sheetView.addSubview(actionStack)
        sheetView.addSubview(bottomDivider)
        sheetView.addSubview(cancelButton)

        let bottomInset = view.safeAreaInsets.bottom
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: view.topAnchor),
            overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),

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
        view.bringSubviewToFront(overlay)
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

    private func makeMenuReenterImage() -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24))
        return renderer.image { _ in
            let color = UIColor(red: 51 / 255, green: 51 / 255, blue: 51 / 255, alpha: 1)
            let text = "↻" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 24, weight: .medium),
                .foregroundColor: color
            ]
            let textSize = text.size(withAttributes: attributes)
            text.draw(
                at: CGPoint(
                    x: (24 - textSize.width) / 2,
                    y: (24 - textSize.height) / 2
                ),
                withAttributes: attributes
            )
        }.withRenderingMode(.alwaysOriginal)
    }

    private func makeMenuCloseImage() -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24))
        return renderer.image { _ in
            let color = UIColor(red: 51 / 255, green: 51 / 255, blue: 51 / 255, alpha: 1)
            let text = "×" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 26, weight: .medium),
                .foregroundColor: color
            ]
            let textSize = text.size(withAttributes: attributes)
            text.draw(
                at: CGPoint(
                    x: (24 - textSize.width) / 2,
                    y: (24 - textSize.height) / 2
                ),
                withAttributes: attributes
            )
        }.withRenderingMode(.alwaysOriginal)
    }

    @objc private func dismissMiniProgramMenu() {
        miniProgramMenuContainerView?.removeFromSuperview()
        miniProgramMenuContainerView = nil
    }

    @objc private func miniProgramMenuReenterTapped() {
        dismissMiniProgramMenu()
        let entryPath = app?.getBundleAppConfig()?.entryPagePath ?? pagePath
        Task { @MainActor in
            await navigator?.relaunch(to: entryPath.isEmpty ? pagePath : entryPath, query: nil, animated: false)
        }
    }

    @objc private func miniProgramMenuCloseTapped() {
        dismissMiniProgramMenu()
        capsuleCloseButtonTapped()
    }

    // Set navigation bar style
    private func setupNavigationBar() {
        navigationController?.setNavigationBarHidden(true, animated: false)
        navigationItem.hidesBackButton = true
        navigationItem.backButtonTitle = ""

        let navStyle = navigator?.pageRecord(webViewId: webview.getWebViewId())?.navStyle
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

        customNavigationBar?.isHidden = isCustomNavigationStyle
        webViewTopToNavigationConstraint?.isActive = !isCustomNavigationStyle
        webViewTopToViewConstraint?.isActive = isCustomNavigationStyle

        if !isCustomNavigationStyle, let customNavigationBar = customNavigationBar {
            view.bringSubviewToFront(customNavigationBar)
        }
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
        hidePageLoading()
        
        // Notify lifecycle management when page completely disappears
        if isMovingFromParent {
            // Page is removed from navigation stack
            destroyWebView()
        }
    }
    
    // Destroy WebView
    private func destroyWebView() {
        // Add state check to prevent duplicate destruction
        guard !isWebViewDestroyed else {
            print("🟡 DMPPageController: WebView (ID: \(webview.getWebViewId())) has already been destroyed, skipping duplicate operation")
            return
        }
        
        print("🗑️ DMPPageController: Destroy WebView (ID: \(webview.getWebViewId()))")
        isWebViewDestroyed = true
        
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
        print("🗑️ DMPPageController: deinit (WebView ID: \(webview.getWebViewId()))")
        webview.onLoadingStateChanged = nil
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
