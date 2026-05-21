//
//  DMPFileUtil.swift
//  dimina
//
//  Created by Lehem on 2025/4/17.
//

import CommonCrypto
import Foundation
import ZIPFoundation

public class DMPFileUtil {

    public static let DMPFileURLScheme: String = "difile"

    private init() {}

    @discardableResult
    public static func unzipFile(
        at zipPath: String, to destinationPath: String, overwrite: Bool = true
    ) -> Bool {
        do {
            if overwrite && FileManager.default.fileExists(atPath: destinationPath) {
                try FileManager.default.removeItem(atPath: destinationPath)
            }

            try FileManager.default.createDirectory(
                atPath: destinationPath, withIntermediateDirectories: true, attributes: nil)
            try FileManager.default.unzipItem(
                at: URL(fileURLWithPath: zipPath),
                to: URL(fileURLWithPath: destinationPath)
            )
            print("成功解压文件: \(zipPath) 到 \(destinationPath)")
            return true
        } catch {
            print("解压文件过程中发生错误: \(error)")
            return false
        }
    }

    @discardableResult
    public static func copyContents(
        from sourcePath: String, to destinationPath: String, excludeItems: [String] = []
    ) -> Bool {
        do {
            // 确保目标目录存在
            try FileManager.default.createDirectory(
                atPath: destinationPath, withIntermediateDirectories: true, attributes: nil)

            // 获取源目录下的所有内容
            let contents = try FileManager.default.contentsOfDirectory(atPath: sourcePath)

            // 遍历复制文件
            for item in contents {
                // 跳过需要排除的文件
                if excludeItems.contains(item) {
                    continue
                }

                let sourceItemPath = (sourcePath as NSString).appendingPathComponent(item)
                let destinationItemPath = (destinationPath as NSString).appendingPathComponent(item)

                var isDir: ObjCBool = false
                if FileManager.default.fileExists(atPath: sourceItemPath, isDirectory: &isDir) {
                    if isDir.boolValue {
                        // 如果是目录，递归复制
                        try FileManager.default.createDirectory(
                            atPath: destinationItemPath, withIntermediateDirectories: true,
                            attributes: nil)
                        if !copyContents(from: sourceItemPath, to: destinationItemPath) {
                            return false
                        }
                    } else {
                        // 如果是文件，直接复制
                        if FileManager.default.fileExists(atPath: destinationItemPath) {
                            try FileManager.default.removeItem(atPath: destinationItemPath)
                        }
                        try FileManager.default.copyItem(
                            atPath: sourceItemPath, toPath: destinationItemPath)
                    }
                }
            }

            return true
        } catch {
            print("复制文件过程中发生错误: \(error)")
            return false
        }
    }

    @discardableResult
    public static func removeItem(at path: String) -> Bool {
        do {
            if FileManager.default.fileExists(atPath: path) {
                try FileManager.default.removeItem(atPath: path)
                return true
            }
            return false
        } catch {
            print("删除文件失败: \(error)")
            return false
        }
    }

    @discardableResult
    public static func createDirectory(at path: String) -> Bool {
        do {
            try FileManager.default.createDirectory(
                atPath: path, withIntermediateDirectories: true, attributes: nil)
            return true
        } catch {
            print("创建目录失败: \(error)")
            return false
        }
    }

    public static func fileExists(at path: String) -> Bool {
        return FileManager.default.fileExists(atPath: path)
    }

    public static func readJsonFile(at path: String) -> String {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
            return "{}"
        }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    public static func loadJSONFromFile(filePath: String) -> [String: Any]? {
        guard
            let fileURL = URL(fileURLWithPath: filePath).isFileURL
                ? URL(fileURLWithPath: filePath) : nil
        else {
            print("无效的文件路径")
            return nil
        }

        do {
            let data = try Data(contentsOf: fileURL)
            return try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
        } catch {
            print("加载 JSON 文件失败: \(error)")
            return nil
        }
    }

    public static func vPathFromSandboxPath(sandboxPath: String, appId: String) -> String {
        let resourceDirectory: String = DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId)
        let relativePath: String = sandboxPath.replacingOccurrences(of: resourceDirectory, with: "")
        let vPath: String = "\(DMPFileURLScheme)://\(relativePath)"
        return vPath
    }

    public static func sandboxPathFromVPath(from vPath: String, appId: String) -> String? {
        guard let components: URLComponents = URLComponents(string: vPath) else {
            return nil
        }

        let path: String = components.path
        let resourceDirectory: String = DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId)
        let sandboxPath: String = (resourceDirectory as NSString).appendingPathComponent(components.host ?? "") + path
        return sandboxPath
    }

}

// MARK: - String MD5 扩展
extension String {
    var dmp_sha256: String {
        let data = Data(self.utf8)
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))

        _ = data.withUnsafeBytes { buffer in
            CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &digest)
        }

        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
