//
//  DiminaVersion.swift
//  dimina
//
//  Created by Dimina Team
//

import Foundation

/// Dimina SDK 版本管理
public class DiminaVersion {
    private static let defaultSDKVersion = "1.3.1"
    
    /// 获取 SDK 版本号
    /// Swift Package 集成时无法从 MARKETING_VERSION 获取 SDK 版本，使用 SDK 内置版本号
    public static var sdkVersion: String {
        return defaultSDKVersion
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
