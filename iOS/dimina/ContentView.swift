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
            let launchConfig = DMPLaunchConfig()
            await app.launch(launchConfig: launchConfig)
        }
    }

    var body: some View {
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

                    List(filteredItems) { item in
                        AppListItemView(item: item)
                            .onTapGesture {
                                navigateToDetail(item: item)
                            }
                    }
                    .listStyle(.plain)
                    .background(Color(.systemGray6))
                    .modifier(AppListBackgroundModifier())
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGray6).ignoresSafeArea(.container, edges: .bottom))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color(.systemBackground))
            .navigationBarHidden(true)
            .onAppear {
                setupNavigationController()
            }
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

private struct AppListBackgroundModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16.0, *) {
            content.scrollContentBackground(.hidden)
        } else {
            content
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

#Preview("ContentView") {
    ContentView()
}
