//
//  DMPResourceManager.swift
//  dimina
//
//  Created by Lehem on 2025/4/17.
//

import Foundation
import SwiftUI

class DMPResourceManager {
    private init() {}

    public static func prepareApp(appId: String) {
        let bundlePath = DMPSandboxManager.appBundlePath(appId)
        let bundle = DMPResourceManager.jsappBundle

        if FileManager.default.fileExists(atPath: bundlePath) {
            let config = DMPFileUtil.loadJSONFromFile(
                filePath: DMPSandboxManager.appBundleConfigPath(appId: appId))
            let versionCodeOld = config?["versionCode"] as? Int ?? 0

            let resourcePath = (bundle?.resourcePath)!
            let configBundle = DMPFileUtil.loadJSONFromFile(
                filePath: resourcePath + "/\(appId)/config.json")
            let versionCodeNew = configBundle?["versionCode"] as? Int ?? 0

            if versionCodeOld >= versionCodeNew {
                print("App 目标路径已存在，跳过复制操作")
                return
            }
        }

        // 确保目标目录存在
        if DMPFileUtil.createDirectory(at: bundlePath) {
            if let resourcePath = bundle?.resourcePath {
                if DMPFileUtil.copyContents(
                    from: (resourcePath as NSString).appendingPathComponent(appId),
                    to: bundlePath,
                    excludeItems: ["\(appId).zip"]
                ) {
                    print("成功复制JSApp资源到沙盒路径: \(bundlePath)")
                } else {
                    print("复制JSApp资源失败")
                }

                // 再检查是否存在对应应用的zip文件并解压
                let appResourcePath = (resourcePath as NSString).appendingPathComponent(appId)
                let appZipPath = (appResourcePath as NSString).appendingPathComponent(
                    "\(appId).zip")
                if FileManager.default.fileExists(atPath: appZipPath) {
                    // 解压应用zip到目标路径
                    if DMPFileUtil.unzipFile(at: appZipPath, to: bundlePath) {
                        print("成功解压\(appId).zip到沙盒路径: \(bundlePath)")
                    } else {
                        print("解压\(appId).zip失败")
                    }
                }
            } else {
                print("无法获取JSApp Bundle资源路径")
            }
        } else {
            print("创建目标目录失败: \(bundlePath)")
        }
    }

    public static func prepareSdk() {
        let sdkBundlePath = DMPSandboxManager.sdkBundlePath()
        let bundle = DMPResourceManager.jssdkBundle

        if FileManager.default.fileExists(atPath: sdkBundlePath) {
            if let config = DMPFileUtil.loadJSONFromFile(filePath: DMPSandboxManager.sdkConfigPath())
            {
                let versionCodeOld = config["versionCode"] as? Int ?? 0

                // 加载 bundle 下的 config.json
                let resourcePath = (bundle?.resourcePath)!
                let configBundle = DMPFileUtil.loadJSONFromFile(
                    filePath: resourcePath + "/config.json")
                let versionCodeNew = configBundle?["versionCode"] as? Int ?? 0

                // 比较版本号
                if versionCodeOld >= versionCodeNew {
                    print("SDK目标路径已存在，跳过复制操作")
                    return
                }
            }
        }

        // 确保目标目录存在
        if DMPFileUtil.createDirectory(at: sdkBundlePath) {
            // 复制JSSDK资源到沙盒路径
            if let resourcePath = bundle?.resourcePath {
                // 先复制其他资源文件（排除main.zip）
                if DMPFileUtil.copyContents(from: resourcePath, to: sdkBundlePath, excludeItems: ["main.zip"])
                {
                    print("成功复制JSSDK资源到沙盒路径: \(sdkBundlePath)")
                } else {
                    print("复制JSSDK资源失败")
                }

                // 再检查是否存在main.zip文件并解压
                let mainZipPath = (resourcePath as NSString).appendingPathComponent("main.zip")
                if FileManager.default.fileExists(atPath: mainZipPath) {
                    // 解压main.zip到目标路径
                    if DMPFileUtil.unzipFile(at: mainZipPath, to: sdkBundlePath) {
                        print("成功解压main.zip到沙盒路径: \(sdkBundlePath)")
                    } else {
                        print("解压main.zip失败")
                    }
                }

                // 合并沙盒路径
//                let sandboxPath = DMPSandboxManager.sandboxPath()
//                // 如果 sandboxPath 不存在 assets 目录，并且也不存在 pageFrame.html，那么执行复制
//                if !DMPFileUtil.fileExists(at: sandboxPath + "/assets")
//                    || !DMPFileUtil.fileExists(at: sandboxPath + "/pageFrame.html")
//                {
//                    let mainPath = sdkBundlePath + "/main"
//                    if DMPFileUtil.copyContents(from: mainPath, to: sandboxPath) {
//                        print("成功复制main目录内容到沙盒路径: \(sandboxPath)")
//                    } else {
//                        print("复制main目录内容失败")
//                    }
//                }
            } else {
                print("无法获取JSSDK Bundle资源路径")
            }
        } else {
            print("创建目标目录失败: \(sdkBundlePath)")
        }
    }

    // jsapp的Bundle
    static var jsappBundle: Bundle? = {
        #if SWIFT_PACKAGE
        if let bundleURL = Bundle.module.url(forResource: "JsApp", withExtension: "bundle") {
            return Bundle(url: bundleURL)
        }
        #endif

        guard let bundleURL = Bundle.main.url(forResource: "JsApp", withExtension: "bundle") else {
            return nil
        }
        return Bundle(url: bundleURL)
    }()

    // jssdk的Bundle
    static var jssdkBundle: Bundle? = {
        #if SWIFT_PACKAGE
        if let bundleURL = Bundle.module.url(forResource: "JsSdk", withExtension: "bundle") {
            return Bundle(url: bundleURL)
        }
        #endif

        if let bundleURL = Bundle(for: DMPResourceManager.self).url(forResource: "DiminaJsSdk", withExtension: "bundle") {
            return Bundle(url: bundleURL)
        }

        if let bundleURL = Bundle.main.url(forResource: "JsSdk", withExtension: "bundle") {
            return Bundle(url: bundleURL)
        }

        return nil
    }()


    public static var assetsBundle: Bundle? = {
        #if SWIFT_PACKAGE
        return Bundle.module
        #else
        if let bundleURL = Bundle(for: DMPResourceManager.self).url(forResource: "DiminaAssets", withExtension: "bundle") {
            return Bundle(url: bundleURL)
        }

        return Bundle.main
        #endif
    }()


    /// 获取所有JSAppBundle下的config.json文件
    /// - Returns: DMPAppConfig数组
    static func getDMPAppConfigs() -> [DMPAppConfig] {
        var appItems = [DMPAppConfig]()

        guard let jsappBundle = jsappBundle,
            let jsappPath = jsappBundle.resourcePath
        else {
            return appItems
        }

        do {
            // 直接获取bundle中所有应用目录
            let folderContents = try FileManager.default.contentsOfDirectory(atPath: jsappPath)

            for folder in folderContents {
                let folderPath = (jsappPath as NSString).appendingPathComponent(folder)
                var isDir: ObjCBool = false

                if FileManager.default.fileExists(atPath: folderPath, isDirectory: &isDir),
                    isDir.boolValue
                {
                    // 检查应用目录中的config.json文件
                    let configPath = (folderPath as NSString).appendingPathComponent("config.json")

                    if FileManager.default.fileExists(atPath: configPath) {
                        // 读取并解析config.json
                        if let jsonObject = DMPFileUtil.loadJSONFromFile(filePath: configPath),
                            let name = jsonObject["name"] as? String,
                            let path = jsonObject["path"] as? String,
                            let versionCode = jsonObject["versionCode"] as? Int,
                            let versionName = jsonObject["versionName"] as? String
                        {

                            // 生成应用图标颜色和文字
                            let randomColor = Color(
                                red: Double.random(in: 0...1),
                                green: Double.random(in: 0...1),
                                blue: Double.random(in: 0...1)
                            )
                            let icon = name.isEmpty ? "?" : String(name.prefix(1))

                            // 创建DMPAppConfig并添加到列表
                            var appItem = DMPAppConfig(
                                appName: name, appId: folder
                            )
                            appItem.path = path
                            appItem.versionCode = versionCode
                            appItem.versionName = versionName
                            appItem.color = randomColor
                            appItem.icon = icon

                            appItems.append(appItem)
                        }
                    }
                }
            }
        } catch {
            print("读取JSAppBundle目录失败: \(error)")
        }

        return appItems
    }
}
