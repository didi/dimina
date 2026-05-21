//
//  DMPTabBarContainerController.swift
//  dimina
//
//  Created by OpenAI on 2026/5/17.
//

import UIKit

final class DMPTabBarContainerController: UIViewController {
    private let appConfig: DMPAppConfig
    private weak var app: DMPApp?
    private weak var navigator: DMPNavigator?
    private let tabBarConfig: DMPTabBarConfig
    private let initialPath: String
    private let initialQuery: [String: Any]?
    private let showsLaunchLoading: Bool

    private let contentView = UIView()
    private lazy var tabBarView = DMPTabBarView(
        config: tabBarConfig,
        appId: app?.getAppId() ?? ""
    )
    private var tabBarHeightConstraint: NSLayoutConstraint?
    private var tabControllers: [Int: DMPPageController] = [:]
    private var tabPageRecords: [Int: DMPPageRecord] = [:]

    private(set) var selectedIndex: Int = 0

    var selectedPageRecord: DMPPageRecord? {
        tabPageRecords[selectedIndex]
    }

    var currentPageController: DMPPageController? {
        tabControllers[selectedIndex]
    }

    init(
        initialPath: String,
        query: [String: Any]?,
        appConfig: DMPAppConfig,
        app: DMPApp?,
        navigator: DMPNavigator?,
        tabBarConfig: DMPTabBarConfig,
        showsLaunchLoading: Bool
    ) {
        self.initialPath = initialPath
        self.initialQuery = query
        self.appConfig = appConfig
        self.app = app
        self.navigator = navigator
        self.tabBarConfig = tabBarConfig
        self.showsLaunchLoading = showsLaunchLoading
        super.init(nibName: nil, bundle: nil)

        self.selectedIndex = tabBarConfig.list.firstIndex { $0.pagePath == initialPath } ?? 0
        self.tabBarView.selectedIndex = self.selectedIndex
        self.tabBarView.onSelect = { [weak self] index in
            guard let self,
                  index < self.tabBarConfig.list.count
            else { return }

            let targetPath = self.tabBarConfig.list[index].pagePath
            Task { @MainActor [weak self] in
                await self?.navigator?.switchTab(to: targetPath)
            }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = DMPUtil.colorFromHexString(tabBarConfig.backgroundColor) ?? .white
        setupViews()
        attachLoadedTabIfNeeded(selectedIndex)
        updateVisibleTab()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: false)
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        updateTabBarHeight()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        view.bringSubviewToFront(tabBarView)
    }

    @MainActor
    func prepareInitialTab() async -> DMPPageRecord? {
        selectedIndex = tabBarConfig.list.firstIndex { $0.pagePath == initialPath } ?? 0
        tabBarView.selectedIndex = selectedIndex
        return await loadTab(
            index: selectedIndex,
            pagePath: initialPath,
            query: initialQuery,
            showsLaunchLoading: showsLaunchLoading
        )
    }

    @MainActor
    func selectTab(index: Int, query: [String: Any]? = nil) async -> DMPPageRecord? {
        guard index >= 0, index < tabBarConfig.list.count else {
            return nil
        }

        let item = tabBarConfig.list[index]
        let record = await loadTab(
            index: index,
            pagePath: item.pagePath,
            query: query,
            showsLaunchLoading: false
        )

        selectedIndex = index
        tabBarView.selectedIndex = index
        attachLoadedTabIfNeeded(index)
        updateVisibleTab()
        return record
    }

    func preparePageLoading(in parentController: UIViewController) {
        currentPageController?.preparePageLoading(in: parentController)
    }

    func pageRecord(at index: Int) -> DMPPageRecord? {
        return tabPageRecords[index]
    }

    func destroy() {
        tabControllers.values.forEach { $0.destroy() }
    }

    private func setupViews() {
        contentView.translatesAutoresizingMaskIntoConstraints = false
        tabBarView.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(contentView)
        view.addSubview(tabBarView)

        tabBarHeightConstraint = tabBarView.heightAnchor.constraint(equalToConstant: tabBarHeight)
        NSLayoutConstraint.activate([
            contentView.topAnchor.constraint(equalTo: view.topAnchor),
            contentView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: tabBarView.topAnchor),

            tabBarView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabBarView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabBarView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tabBarHeightConstraint!,
        ])
    }

    @MainActor
    private func loadTab(
        index: Int,
        pagePath: String,
        query: [String: Any]?,
        showsLaunchLoading: Bool
    ) async -> DMPPageRecord? {
        if let record = tabPageRecords[index] {
            return record
        }

        guard let app else {
            return nil
        }

        await app.service?.loadSubPackage(pagePath: pagePath)

        let pageController = DMPPageController(
            pagePath: pagePath,
            query: query,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true,
            showsLaunchLoading: showsLaunchLoading
        )

        let pageRecord = DMPPageRecord(
            webViewId: pageController.getWebView().getWebViewId(),
            fromWebViewId: app.getCurrentWebViewId(),
            pagePath: pagePath
        )
        pageRecord.query = query
        pageRecord.navStyle = app.getBundleAppConfig()?.getPageConfig(pagePath: pagePath)

        tabControllers[index] = pageController
        tabPageRecords[index] = pageRecord
        attachLoadedTabIfNeeded(index)
        return pageRecord
    }

    private func attachLoadedTabIfNeeded(_ index: Int) {
        guard isViewLoaded,
              let controller = tabControllers[index],
              controller.parent == nil
        else {
            return
        }

        addChild(controller)
        contentView.addSubview(controller.view)
        controller.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            controller.view.topAnchor.constraint(equalTo: contentView.topAnchor),
            controller.view.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            controller.view.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            controller.view.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
        ])
        controller.didMove(toParent: self)
    }

    private func updateVisibleTab() {
        for (index, controller) in tabControllers {
            let isSelected = index == selectedIndex
            controller.view.isHidden = !isSelected
            controller.view.alpha = isSelected ? 1 : 0
            if isSelected {
                contentView.bringSubviewToFront(controller.view)
            }
        }
    }

    private var tabBarHeight: CGFloat {
        49.5 + view.safeAreaInsets.bottom
    }

    private func updateTabBarHeight() {
        tabBarHeightConstraint?.constant = tabBarHeight
    }

    deinit {
        destroy()
    }
}

private final class DMPTabBarView: UIView {
    private let config: DMPTabBarConfig
    private let appId: String
    private let borderView = UIView()
    private let stackView = UIStackView()
    private var itemControls: [DMPTabBarItemControl] = []

    var onSelect: ((Int) -> Void)?

    var selectedIndex: Int = 0 {
        didSet {
            updateSelection()
        }
    }

    init(config: DMPTabBarConfig, appId: String) {
        self.config = config
        self.appId = appId
        super.init(frame: .zero)
        setup()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setup() {
        backgroundColor = DMPUtil.colorFromHexString(config.backgroundColor) ?? .white

        borderView.translatesAutoresizingMaskIntoConstraints = false
        borderView.backgroundColor = config.borderStyle == "white"
            ? .white
            : UIColor(red: 224 / 255, green: 224 / 255, blue: 224 / 255, alpha: 1)

        stackView.translatesAutoresizingMaskIntoConstraints = false
        stackView.axis = .horizontal
        stackView.alignment = .fill
        stackView.distribution = .fillEqually

        addSubview(borderView)
        addSubview(stackView)

        NSLayoutConstraint.activate([
            borderView.topAnchor.constraint(equalTo: topAnchor),
            borderView.leadingAnchor.constraint(equalTo: leadingAnchor),
            borderView.trailingAnchor.constraint(equalTo: trailingAnchor),
            borderView.heightAnchor.constraint(equalToConstant: 0.5),

            stackView.topAnchor.constraint(equalTo: borderView.bottomAnchor),
            stackView.leadingAnchor.constraint(equalTo: leadingAnchor),
            stackView.trailingAnchor.constraint(equalTo: trailingAnchor),
            stackView.heightAnchor.constraint(equalToConstant: 49),
        ])

        itemControls = config.list.enumerated().map { index, item in
            let control = DMPTabBarItemControl(
                item: item,
                appId: appId,
                normalColor: DMPUtil.colorFromHexString(config.color) ?? UIColor(white: 0.6, alpha: 1),
                selectedColor: DMPUtil.colorFromHexString(config.selectedColor) ?? .systemBlue
            )
            control.tag = index
            control.addTarget(self, action: #selector(handleItemTap(_:)), for: .touchUpInside)
            stackView.addArrangedSubview(control)
            return control
        }

        updateSelection()
    }

    private func updateSelection() {
        for (index, control) in itemControls.enumerated() {
            control.isSelected = index == selectedIndex
        }
    }

    @objc private func handleItemTap(_ sender: UIControl) {
        onSelect?(sender.tag)
    }
}

private final class DMPTabBarItemControl: UIControl {
    private let item: DMPTabBarItem
    private let appId: String
    private let normalColor: UIColor
    private let selectedColor: UIColor
    private let imageView = UIImageView()
    private let titleLabel = UILabel()

    override var isSelected: Bool {
        didSet {
            updateContent()
        }
    }

    init(item: DMPTabBarItem, appId: String, normalColor: UIColor, selectedColor: UIColor) {
        self.item = item
        self.appId = appId
        self.normalColor = normalColor
        self.selectedColor = selectedColor
        super.init(frame: .zero)
        setup()
        updateContent()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func setup() {
        let stackView = UIStackView(arrangedSubviews: [imageView, titleLabel])
        stackView.translatesAutoresizingMaskIntoConstraints = false
        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.spacing = 2
        stackView.isUserInteractionEnabled = false

        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false

        titleLabel.font = .systemFont(ofSize: 10)
        titleLabel.textAlignment = .center
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.text = item.text

        addSubview(stackView)
        NSLayoutConstraint.activate([
            stackView.centerXAnchor.constraint(equalTo: centerXAnchor),
            stackView.centerYAnchor.constraint(equalTo: centerYAnchor),
            stackView.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 4),
            stackView.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -4),

            imageView.widthAnchor.constraint(equalToConstant: 24),
            imageView.heightAnchor.constraint(equalToConstant: 24),
            titleLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 72),
        ])
    }

    private func updateContent() {
        titleLabel.textColor = isSelected ? selectedColor : normalColor
        let rawPath = isSelected && !item.selectedIconPath.isEmpty
            ? item.selectedIconPath
            : item.iconPath
        loadImage(rawPath)
    }

    private func loadImage(_ rawPath: String) {
        guard let url = resolveIconURL(rawPath) else {
            imageView.image = nil
            return
        }

        if url.isFileURL {
            imageView.image = UIImage(contentsOfFile: url.path)
            return
        }

        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data,
                  let image = UIImage(data: data)
            else { return }
            DispatchQueue.main.async {
                self?.imageView.image = image
            }
        }.resume()
    }

    private func resolveIconURL(_ rawPath: String) -> URL? {
        guard !rawPath.isEmpty else {
            return nil
        }

        if rawPath.hasPrefix("http://") || rawPath.hasPrefix("https://") || rawPath.hasPrefix("file://") {
            return URL(string: rawPath)
        }

        if rawPath.hasPrefix("data:") {
            return nil
        }

        let appRoot = DMPSandboxManager.appBundlePath(appId)
        let appIdPrefix = "/\(appId)/"
        if rawPath.hasPrefix(appIdPrefix) {
            let relativePath = String(rawPath.dropFirst(appIdPrefix.count))
            return URL(fileURLWithPath: (appRoot as NSString).appendingPathComponent(relativePath))
        }

        if rawPath.hasPrefix("/") {
            return URL(fileURLWithPath: rawPath)
        }

        return URL(fileURLWithPath: (appRoot as NSString).appendingPathComponent("main/\(rawPath)"))
    }
}
