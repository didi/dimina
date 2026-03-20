//
//  DMPAppManager.swift
//  dimina
//
//  Created by Lehem on 2025/4/28.
//

public class DMPAppManager {
    private static let instance = DMPAppManager()

    private var appPools: [Int: DMPApp] = [:]
    private var appIndex: Int = 0
    public private(set) var apiNamespaces: [String] = []

    private init() {}

    public static func sharedInstance() -> DMPAppManager {
        return instance
    }

    public func setup(apiNamespaces: [String] = []) {
        self.apiNamespaces = apiNamespaces
    }
    
    func getApp(appIndex: Int) -> DMPApp? {
        return appPools[appIndex]
    }
    
    func newAppWithConfig(appConfig: DMPAppConfig) -> DMPApp {
        appIndex += 1
        let newApp = DMPApp(appConfig: appConfig, appIndex: appIndex)
        appPools[appIndex] = newApp
        return newApp
    }
    
    public func appWithConfig(appConfig: DMPAppConfig) -> DMPApp {
        print("appWithConfig config=\(appConfig)")
        if let existingApp = existApp(appId: appConfig.appId) {
            print("appWithConfig return exist DMPApp")
            return existingApp
        } else {
            print("appWithConfig create DMPApp")
            appIndex += 1
            let newApp = DMPApp(appConfig: appConfig, appIndex: appIndex)
            appPools[appIndex] = newApp
            return newApp
        }
    }

    func existApp(appId: String) -> DMPApp? {
        return appPools.values.first(where: { $0.getAppId() == appId })
    }
    
    func removeApp(appId: String) {
        if let key = appPools.first(where: { $0.value.getAppId() == appId })?.key {
            appPools.removeValue(forKey: key)
        }
    }
}
