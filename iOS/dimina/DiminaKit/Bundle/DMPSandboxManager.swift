//
//  DMPSandboxManager.swift
//  dimina
//
//  Created by Lehem on 2025/4/17.
//

import Foundation
import SwiftUI

class DMPSandboxManager {
    private init() {}
    
    // 资源目录常量
    private static let DMPResourceDirectoryName = "resources"
    private static let DMPTmpResourceDirectoryName = "tmp"
    private static let DMPStoreResourceDirectoryName = "store"
    
    // sdk 沙盒路径
    private static var _sandboxPath: String? = {
        let paths = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
        let root = paths[0].path
        let sandbox = (root as NSString).appendingPathComponent("Dimina")
        
        if DMPFileUtil.createDirectory(at: sandbox) {
            return sandbox
        } else {
            DMPLogger.debug("创建沙盒目录失败")
            return nil
        }
    }()
    
    @discardableResult
    static func initBundleDirectoryForApp(appId: String, sandbox: String? = nil) -> Bool {
        guard let sandboxPath = _sandboxPath else { return false }
        
        let appBundlePath = (sandboxPath as NSString).appendingPathComponent(appId)
        let resourcePath = (appBundlePath as NSString).appendingPathComponent(DMPResourceDirectoryName)
        let tmpPath = (resourcePath as NSString).appendingPathComponent(DMPTmpResourceDirectoryName)
        let storePath = (resourcePath as NSString).appendingPathComponent(DMPStoreResourceDirectoryName)
        
        // 创建所需的目录结构
        if !DMPFileUtil.createDirectory(at: appBundlePath)
            || !DMPFileUtil.createDirectory(at: tmpPath)
            || !DMPFileUtil.createDirectory(at: storePath) {
            DMPLogger.debug("创建目录失败")
            return false
        }
        
        return true
    }

    // MARK: Directory

    static func sandboxPath() -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath
    }
    
    // MARK: App

    static func appResourceDirectoryPath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return (sandboxPath as NSString).appendingPathComponent(appId + "/" + DMPResourceDirectoryName)
    }

    static func appTmpResourceDirectoryPath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return (sandboxPath as NSString).appendingPathComponent(appId + "/" + DMPTmpResourceDirectoryName)
    }
    
    static func appStoreResourceDirectoryPath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return (sandboxPath as NSString).appendingPathComponent(appId + "/" + DMPStoreResourceDirectoryName)
    }
    
    static func appBundlePath(_ appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath + "/" + appId
    }
        
    // 获取 app 的 service, logic.js
    static func appServicePath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath + "/\(appId)" + "/main/logic.js"
    }

    static func appSubPackagePath(appId: String, packageName: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath + "/\(appId)" + "/\(packageName)" + "/logic.js"
    }

    // 获取 app 的 config.json
    static func appConfigPath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath + "/\(appId)" + "/main/app-config.json"
    }
    
    static func appBundleConfigPath(appId: String) -> String {
        guard let sandboxPath = _sandboxPath else { return "" }
        return sandboxPath + "/\(appId)" + "/config.json"
    }
    
    // MARK: SDK
    
    static func sdkBundlePath() -> String {
        return DMPSandboxManager.sandboxPath() + "/sdk"
    }
    
    static func sdkMainBundlePath() -> String {
        return DMPSandboxManager.sdkBundlePath() + "/main"
    }
    
    // 获取 sdk 的 service 目录
    static func sdkServicePath() -> String {
        return DMPSandboxManager.sdkMainBundlePath() + "/assets/service.js"
    }
    
    // 获取 sdk 的 pageFrame.html
    static func sdkPageFramePath() -> String {
        return DMPSandboxManager.sdkMainBundlePath() + "/pageFrame.html"
    }
    
    // 获取 sdk 的 config.json
    static func sdkConfigPath() -> String {
        return DMPSandboxManager.sdkBundlePath() + "/config.json"
    }
    
}
