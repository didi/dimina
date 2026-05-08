//
//  DiminaVersion.swift
//  dimina
//
//  Created by Dimina Team
//

import Foundation

/// Dimina SDK 版本管理
public class DiminaVersion {
    
    /// 获取 SDK 版本号
    /// 优先级：Bundle Info > 默认值
    public static var sdkVersion: String {
        // 从 Bundle 的 Info.plist 读取 MARKETING_VERSION
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !version.isEmpty {
            return version
        }
        
        // 如果是 framework，尝试从 framework bundle 读取
        if let frameworkBundle = Bundle(for: DiminaVersion.self).infoDictionary?["CFBundleShortVersionString"] as? String,
           !frameworkBundle.isEmpty {
            return frameworkBundle
        }
        
        // 默认值（与 Dimina.podspec 同步）
        return "1.2.0"
    }
    
    /// 获取完整的版本信息（用于调试）
    public static var fullVersionInfo: [String: String] {
        return [
            "sdkVersion": sdkVersion,
            "bundleVersion": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown",
            "buildNumber": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "unknown"
        ]
    }
}
