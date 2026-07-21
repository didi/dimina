//
//  ContentView.swift
//  dimina
//
//  Created by Lehem on 2025/4/15.
//

import SwiftUI
import Combine

struct ContentView: View {
    @State private var searchText = ""

    // 存储UINavigationController的引用
    static var navigationController: UINavigationController?

    // 自动化测试钩子的一次性标记（见 autoOpenAppForTestIfRequested）
    static var didAutoOpenForTest = false

    let appItems = DMPResourceManager.getDMPAppConfigs()

    var filteredItems: [DMPAppConfig] {
        if searchText.isEmpty {
            return appItems
        } else {
            return appItems.filter { $0.appName.localizedCaseInsensitiveContains(searchText) }
        }
    }

    func navigateToDetail(item: DMPAppConfig) {
        // 使用已保存的导航控制器
        guard let navController = ContentView.navigationController else {
            print("无法获取导航控制器")
            return
        }

        // 创建小程序配置和实例
        let manager = DMPAppManager.sharedInstance()
        var appConfig = DMPAppConfig(appName: item.appName, appId: item.id)
        appConfig.isDebugMode = true
        let app = manager.appWithConfig(appConfig: appConfig)

        // 设置DMPNavigator
        app.getNavigator()!.setup(navigationController: navController)

        // 启动小程序
        Task { @MainActor in
            // 自动化测试钩子：环境变量指定启动页（如验证非首页启动的返回首页按钮），
            // 未设置时保持默认首页启动
            let launchConfig = DMPLaunchConfig(
                appEntryPath: ProcessInfo.processInfo.environment["DMP_TEST_ENTRY_PATH"]
            )
            await app.launch(launchConfig: launchConfig)
        }
    }

    var body: some View {
        let items = filteredItems

        NavigationView {
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundColor(.gray)

                    TextField("搜索小程序", text: $searchText)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.systemGray6))
                .cornerRadius(10)
                .padding(.horizontal)
                .padding(.top)
                .padding(.bottom, 12)

                VStack(spacing: 0) {
                    Text("应用列表")
                        .font(.system(size: 14))
                        .foregroundColor(Color(.systemGray))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .padding(.vertical, 8)

                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(items.indices, id: \.self) { index in
                                AppListRowView(
                                    item: items[index],
                                    showsSeparator: index < items.count - 1
                                ) {
                                    navigateToDetail(item: items[index])
                                }
                            }
                        }
                    }
                    .background(Color(.systemGray6))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGray6).ignoresSafeArea(.container, edges: .bottom))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemBackground))
            .navigationBarHidden(true)
            .onAppear {
                setupNavigationController()
                autoOpenAppForTestIfRequested()
            }
        }
    }

    /// 自动化测试钩子：环境变量 DMP_TEST_AUTO_OPEN_APPID 指定 appId 时，启动后自动打开
    /// 该小程序，配合 DMP_TEST_ENTRY_PATH 覆盖启动页。
    /// 只触发一次：小程序 relaunch 的 popToRootViewController 会瞬时露出本列表页并
    /// 重跑 onAppear，无防重会用测试入口页重启小程序、覆盖正在进行的 relaunch
    private func autoOpenAppForTestIfRequested() {
        guard !ContentView.didAutoOpenForTest,
              let autoId = ProcessInfo.processInfo.environment["DMP_TEST_AUTO_OPEN_APPID"],
              let item = appItems.first(where: { $0.id == autoId }) else {
            return
        }
        ContentView.didAutoOpenForTest = true
        // setupNavigationController 在 onAppear 中先向 main 队列入队；这里再入队
        // 即按 FIFO 排在其后，执行时导航控制器已就绪，无需定时等待
        DispatchQueue.main.async {
            navigateToDetail(item: item)
        }
    }

    private func setupNavigationController() {
        // 在视图出现时获取并保存导航控制器
        DispatchQueue.main.async {
            if ContentView.navigationController == nil,
               let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let window = windowScene.windows.first,
               let rootVC = window.rootViewController {

                // 尝试获取根导航控制器
                if let navController = rootVC as? UINavigationController {
                    ContentView.navigationController = navController
                } else {
                    // 如果没有导航控制器，替换根视图控制器为导航控制器
                    let navController = UINavigationController()
                    
                    // 使用UIHostingController包装当前视图，避免重复创建ContentView
                    let hostingController = UIHostingController(rootView: self)
                    hostingController.navigationItem.title = "星河小程序"

                    // 设置为根视图
                    navController.viewControllers = [hostingController]
                    window.rootViewController = navController

                    ContentView.navigationController = navController
                }
            }
        }
    }
}

struct AppListItemView: View {
    let item: DMPAppConfig

    var body: some View {
        HStack {
            Circle()
                .fill(DMPUtil.generateColorFromName(name: item.appName))
                .frame(width: 50, height: 50)
                .overlay(
                    Text(item.icon!)
                        .font(.system(size: 18))
                        .foregroundColor(.white)
                )

            Text(item.appName)
                .padding(.leading, 8)

            Spacer()
        }
        .padding(.vertical, 4)
    }
}

private struct AppListRowView: View {
    let item: DMPAppConfig
    let showsSeparator: Bool
    let onTap: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onTap) {
                AppListItemView(item: item)
                    .padding(.horizontal)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if showsSeparator {
                Divider()
                    .padding(.leading, 74)
            }
        }
        .background(Color(.systemBackground))
    }
}

#Preview("ContentView") {
    ContentView()
}
