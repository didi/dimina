//
//  DMPTabBarContainerController.swift
//  dimina
//
//  Created by Doslin on 2026/5/17.
//

import UIKit

final class DMPTabBarContainerController: UIViewController {
    private let appConfig: DMPAppConfig
    private weak var app: DMPApp?
    private weak var navigator: DMPNavigator?
    private var tabBarConfig: DMPTabBarConfig
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

    /// 按 webViewId 查找 tab 页记录（含未选中的后台 tab）。navigator 的
    /// pageRecords 只镜像当前选中 tab，按调用页记账的 API（如 hideHomeButton）
    /// 需要能定位到后台 tab 的记录
    func pageRecord(webViewId: Int) -> DMPPageRecord? {
        return tabPageRecords.values.first { $0.webViewId == webViewId }
    }

    func setTabBarStyle(
        color: String?,
        selectedColor: String?,
        backgroundColor: String?,
        borderStyle: String?
    ) {
        tabBarConfig.color = color ?? tabBarConfig.color
        tabBarConfig.selectedColor = selectedColor ?? tabBarConfig.selectedColor
        tabBarConfig.backgroundColor = backgroundColor ?? tabBarConfig.backgroundColor
        if borderStyle == "black" || borderStyle == "white" {
            tabBarConfig.borderStyle = borderStyle!
        }

        view.backgroundColor = DMPUtil.colorFromHexString(tabBarConfig.backgroundColor) ?? .white
        tabBarView.updateStyle(config: tabBarConfig)
    }

    func setTabBarItem(
        index: Int,
        text: String?,
        iconPath: String?,
        selectedIconPath: String?
    ) {
        guard index >= 0, index < tabBarConfig.list.count else {
            return
        }

        var item = tabBarConfig.list[index]
        item.text = text ?? item.text
        item.iconPath = iconPath ?? item.iconPath
        item.selectedIconPath = selectedIconPath ?? item.selectedIconPath
        tabBarConfig.list[index] = item
        tabBarView.updateItem(index: index, item: item)
    }

    func setTabBarVisible(_ visible: Bool) {
        tabBarView.isHidden = !visible
        updateTabBarHeight()
        view.layoutIfNeeded()
    }

    func setTabBarBadge(index: Int, text: String) {
        tabBarView.setBadge(index: index, text: text)
    }

    func removeTabBarBadge(index: Int) {
        tabBarView.removeBadge(index: index)
    }

    func showTabBarRedDot(index: Int) {
        tabBarView.showRedDot(index: index)
    }

    func hideTabBarRedDot(index: Int) {
        tabBarView.hideRedDot(index: index)
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
        tabBarHeightConstraint?.constant = tabBarView.isHidden ? 0 : tabBarHeight
    }

    deinit {
        destroy()
    }
}

private final class DMPTabBarView: UIView {
    private var config: DMPTabBarConfig
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

    func updateStyle(config: DMPTabBarConfig) {
        self.config = config
        backgroundColor = DMPUtil.colorFromHexString(config.backgroundColor) ?? .white
        borderView.backgroundColor = config.borderStyle == "white"
            ? .white
            : UIColor(red: 224 / 255, green: 224 / 255, blue: 224 / 255, alpha: 1)

        let normalColor = DMPUtil.colorFromHexString(config.color) ?? UIColor(white: 0.6, alpha: 1)
        let selectedColor = DMPUtil.colorFromHexString(config.selectedColor) ?? .systemBlue
        itemControls.forEach {
            $0.updateStyle(normalColor: normalColor, selectedColor: selectedColor)
        }
        updateSelection()
    }

    func updateItem(index: Int, item: DMPTabBarItem) {
        guard index >= 0, index < itemControls.count else {
            return
        }
        config.list[index] = item
        itemControls[index].updateItem(item)
        updateSelection()
    }

    func setBadge(index: Int, text: String) {
        itemControls[safe: index]?.setBadge(text)
    }

    func removeBadge(index: Int) {
        itemControls[safe: index]?.removeBadge()
    }

    func showRedDot(index: Int) {
        itemControls[safe: index]?.setRedDotVisible(true)
    }

    func hideRedDot(index: Int) {
        itemControls[safe: index]?.setRedDotVisible(false)
    }

    @objc private func handleItemTap(_ sender: UIControl) {
        onSelect?(sender.tag)
    }
}

private final class DMPTabBarItemControl: UIControl {
    private var item: DMPTabBarItem
    private let appId: String
    private var normalColor: UIColor
    private var selectedColor: UIColor
    private let imageView = UIImageView()
    private let titleLabel = UILabel()
    private let badgeLabel = DMPTabBarBadgeLabel()
    private let redDotView = UIView()

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

        badgeLabel.translatesAutoresizingMaskIntoConstraints = false
        badgeLabel.font = .systemFont(ofSize: 10)
        badgeLabel.textColor = .white
        badgeLabel.textAlignment = .center
        badgeLabel.backgroundColor = UIColor(red: 250 / 255, green: 81 / 255, blue: 81 / 255, alpha: 1)
        badgeLabel.layer.cornerRadius = 8
        badgeLabel.clipsToBounds = true
        badgeLabel.isHidden = true

        redDotView.translatesAutoresizingMaskIntoConstraints = false
        redDotView.backgroundColor = UIColor(red: 250 / 255, green: 81 / 255, blue: 81 / 255, alpha: 1)
        redDotView.layer.cornerRadius = 4
        redDotView.isHidden = true

        addSubview(stackView)
        addSubview(badgeLabel)
        addSubview(redDotView)
        NSLayoutConstraint.activate([
            stackView.centerXAnchor.constraint(equalTo: centerXAnchor),
            stackView.centerYAnchor.constraint(equalTo: centerYAnchor),
            stackView.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 4),
            stackView.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -4),

            imageView.widthAnchor.constraint(equalToConstant: 24),
            imageView.heightAnchor.constraint(equalToConstant: 24),
            titleLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 72),

            badgeLabel.centerXAnchor.constraint(equalTo: centerXAnchor, constant: 18),
            badgeLabel.topAnchor.constraint(equalTo: stackView.topAnchor, constant: -2),
            badgeLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 16),
            badgeLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 16),

            redDotView.centerXAnchor.constraint(equalTo: centerXAnchor, constant: 18),
            redDotView.topAnchor.constraint(equalTo: stackView.topAnchor),
            redDotView.widthAnchor.constraint(equalToConstant: 8),
            redDotView.heightAnchor.constraint(equalToConstant: 8),
        ])
    }

    func updateStyle(normalColor: UIColor, selectedColor: UIColor) {
        self.normalColor = normalColor
        self.selectedColor = selectedColor
        updateContent()
    }

    func updateItem(_ item: DMPTabBarItem) {
        self.item = item
        titleLabel.text = item.text
        updateContent()
    }

    func setBadge(_ text: String) {
        badgeLabel.text = text
        badgeLabel.isHidden = text.isEmpty
        redDotView.isHidden = true
    }

    func removeBadge() {
        badgeLabel.text = nil
        badgeLabel.isHidden = true
    }

    func setRedDotVisible(_ visible: Bool) {
        redDotView.isHidden = !visible
        if visible {
            badgeLabel.text = nil
            badgeLabel.isHidden = true
        }
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

private final class DMPTabBarBadgeLabel: UILabel {
    private let contentInsets = UIEdgeInsets(top: 1, left: 4, bottom: 1, right: 4)

    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(
            width: size.width + contentInsets.left + contentInsets.right,
            height: size.height + contentInsets.top + contentInsets.bottom
        )
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: contentInsets))
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        guard indices.contains(index) else {
            return nil
        }
        return self[index]
    }
}
