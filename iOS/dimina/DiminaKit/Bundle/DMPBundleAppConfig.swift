//
//  DMPBundleAppConfig.swift
//  dimina
//
//  Created by Lehem on 2025/4/21.
//

import Foundation

public class DMPBundleAppConfig {
    var data: [String: Any]
    var app: [String: Any]
    var modules: [String: Any]
    var pages: [String]?
    var tabBar: DMPTabBarConfig?
    var style: String
    var sitemapLocation: String
    var subPackages: [SubPackageConfig]
    var _entryPagePath: String
    var moduleMaps: [String: ModuleConfig]
    
    init(data: [String: Any]) {
        self.data = data
        self.app = data["app"] as? [String: Any] ?? [:]
        self.modules = data["modules"] as? [String: Any] ?? [:]
        
        self.pages = self.app["pages"] as? [String]
        self.tabBar = DMPTabBarConfig.from(self.app["tabBar"] as? [String: Any])
        self.style = self.app["style"] as? String ?? ""
        self.sitemapLocation = self.app["sitemapLocation"] as? String ?? ""
        self.subPackages = self.app["subPackages"] as? [SubPackageConfig] ?? []
        self._entryPagePath = self.app["entryPagePath"] as? String ?? ""
        
        // 初始化 moduleMaps
        var maps = [String: ModuleConfig]()
        
        for (pagePath, moduleData) in self.modules {
            guard let moduleDict = moduleData as? [String: Any] else { continue }
            let root = moduleDict["root"] as? String ?? "main"
            let moduleConfig = ModuleConfig(root: root, pages: [pagePath])
            maps[pagePath] = moduleConfig
        }
        
        self.moduleMaps = maps
    }
    
    func getRootPackage(pagePath: String) -> String {
        return moduleMaps[pagePath]?.root ?? "main"
    }
    
    func isContainsPage(pagePath: String) -> Bool {
        return moduleMaps[pagePath] != nil
    }
    
    func getModuleConfig(pagePath: String) -> ModuleConfig? {
        return moduleMaps[pagePath]
    }
    
    static func fromJsonString(json: String) -> DMPBundleAppConfig? {
        guard let data = json.data(using: .utf8),
              let dictionary = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            return nil
        }
        return DMPBundleAppConfig(data: dictionary)
    }
    
    var entryPagePath: String {
        get {
            if _entryPagePath.isEmpty {
                guard let firstPage = pages?.first else {
                    return ""
                }
                _entryPagePath = firstPage
            }
            // 统一输出无前导斜杠的 module-key 形态——首页判定（resolveLeftNavAction）、
            // navigateHome、openPage 等所有读者都按 app-config key 消费同一权威值
            return _entryPagePath.hasPrefix("/")
                ? String(_entryPagePath.drop(while: { $0 == "/" }))
                : _entryPagePath
        }
        set {
            _entryPagePath = newValue
        }
    }
    
    func getPageConfig(pagePath: String) -> [String: Any] {
        let pagePrivateConfig = modules[pagePath] as? [String: Any] ?? [:]
        let appWindowConfig = app["window"] as? [String: Any] ?? [:]
        
        var mergedConfig = [String: Any]()
        mergedConfig["navigationBarTitleText"] = (pagePrivateConfig["navigationBarTitleText"] as? String) ?? 
                       (appWindowConfig["navigationBarTitleText"] as? String) ?? ""
        mergedConfig["navigationBarBackgroundColor"] = (pagePrivateConfig["navigationBarBackgroundColor"] as? String) ?? 
                       (appWindowConfig["navigationBarBackgroundColor"] as? String) ?? "#FFFFFF"
        mergedConfig["navigationBarTextStyle"] = (pagePrivateConfig["navigationBarTextStyle"] as? String) ?? 
                       (appWindowConfig["navigationBarTextStyle"] as? String) ?? "black"
        mergedConfig["backgroundColor"] = (pagePrivateConfig["backgroundColor"] as? String) ?? 
                       (appWindowConfig["backgroundColor"] as? String) ?? "#FFFFFF"
        mergedConfig["navigationStyle"] = (pagePrivateConfig["navigationStyle"] as? String) ??
                       (appWindowConfig["navigationStyle"] as? String) ?? "default"
        mergedConfig["homeButton"] = (pagePrivateConfig["homeButton"] as? Bool) ??
                       (appWindowConfig["homeButton"] as? Bool) ?? false
        mergedConfig["usingComponents"] = pagePrivateConfig["usingComponents"] ?? [:]
        
        return mergedConfig
    }

    func getTabBarIndex(pagePath: String) -> Int {
        return tabBar?.list.firstIndex(where: { $0.pagePath == pagePath }) ?? -1
    }

    func isTabBarPage(pagePath: String) -> Bool {
        return getTabBarIndex(pagePath: pagePath) >= 0
    }
}

struct DMPTabBarConfig {
    var color: String
    var selectedColor: String
    var borderStyle: String
    var backgroundColor: String
    var list: [DMPTabBarItem]

    static func from(_ data: [String: Any]?) -> DMPTabBarConfig? {
        guard let data = data else { return nil }
        let rawList = data["list"] as? [[String: Any]] ?? []
        let items = rawList.compactMap { DMPTabBarItem.from($0) }

        guard !items.isEmpty else {
            return nil
        }

        return DMPTabBarConfig(
            color: data["color"] as? String ?? "#999999",
            selectedColor: data["selectedColor"] as? String ?? "#1890ff",
            borderStyle: data["borderStyle"] as? String ?? "black",
            backgroundColor: data["backgroundColor"] as? String ?? "#FFFFFF",
            list: items
        )
    }
}

struct DMPTabBarItem {
    var pagePath: String
    var iconPath: String
    var selectedIconPath: String
    var text: String

    static func from(_ data: [String: Any]) -> DMPTabBarItem? {
        guard let pagePath = data["pagePath"] as? String, !pagePath.isEmpty else {
            return nil
        }

        return DMPTabBarItem(
            pagePath: pagePath,
            iconPath: data["iconPath"] as? String ?? "",
            selectedIconPath: data["selectedIconPath"] as? String ?? "",
            text: data["text"] as? String ?? ""
        )
    }
}

struct ModuleConfig {
    var root: String
    var pages: [String]
}

struct SubPackageConfig {
    var root: String
    var navigationBarTitleText: [String]
}
