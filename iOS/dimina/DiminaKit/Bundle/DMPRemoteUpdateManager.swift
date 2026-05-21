//
//  DMPRemoteUpdateManager.swift
//  dimina
//
//  Created by doslin on 2026/5/19.
//

import CommonCrypto
import Foundation

final class DMPRemoteUpdateManager {
    static let shared = DMPRemoteUpdateManager()

    private init() {}

    func checkForUpdate(app: DMPApp, manifestUrl: String) async {
        let trimmedUrl = manifestUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUrl.isEmpty else {
            await app.notifyUpdateStatus(event: "noupdate")
            return
        }

        var updateAnnounced = false
        do {
            let manifest = try await fetchManifest(manifestUrl: trimmedUrl)
            guard manifest.appId == app.getAppId() else {
                throw RemoteUpdateError.invalidManifest("manifest appId \(manifest.appId) does not match \(app.getAppId())")
            }

            let currentVersion = currentVersionCode(appId: app.getAppId())
            guard manifest.versionCode > currentVersion else {
                await app.notifyUpdateStatus(event: "noupdate")
                return
            }

            updateAnnounced = true
            await app.notifyUpdateStatus(event: "updating")

            let zipPath = try await downloadPackage(manifest: manifest)
            if let sha256 = manifest.sha256, !sha256.isEmpty {
                try verifySha256(filePath: zipPath, expectedSha256: sha256)
            }

            try installPackage(manifest: manifest, zipPath: zipPath)
            await app.notifyUpdateStatus(event: "updateready")
        } catch {
            print("Remote update failed: \(error)")
            await app.notifyUpdateStatus(event: updateAnnounced ? "updatefail" : "noupdate")
        }
    }

    private func fetchManifest(manifestUrl: String) async throws -> RemoteUpdateManifest {
        guard let url = URL(string: manifestUrl) else {
            throw RemoteUpdateError.invalidManifest("invalid manifest url")
        }

        let (data, response) = try await requestData(url: url)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw RemoteUpdateError.network("manifest request failed: HTTP \(httpResponse.statusCode)")
        }

        let object = try JSONSerialization.jsonObject(with: data)
        guard let root = object as? [String: Any] else {
            throw RemoteUpdateError.invalidManifest("manifest is not an object")
        }

        let payload = root["data"] as? [String: Any] ?? root
        return try RemoteUpdateManifest(json: payload)
    }

    private func downloadPackage(manifest: RemoteUpdateManifest) async throws -> String {
        guard let url = URL(string: manifest.packageUrl) else {
            throw RemoteUpdateError.invalidManifest("invalid package url")
        }

        let (downloadedURL, response) = try await downloadFile(url: url)
        if let httpResponse = response as? HTTPURLResponse,
           !(200..<300).contains(httpResponse.statusCode) {
            throw RemoteUpdateError.network("package download failed: HTTP \(httpResponse.statusCode)")
        }

        let targetPath = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("\(manifest.appId)-\(manifest.versionCode).zip")
        if FileManager.default.fileExists(atPath: targetPath) {
            try FileManager.default.removeItem(atPath: targetPath)
        }
        try FileManager.default.moveItem(at: downloadedURL, to: URL(fileURLWithPath: targetPath))
        return targetPath
    }

    private func installPackage(manifest: RemoteUpdateManifest, zipPath: String) throws {
        let sandboxPath = DMPSandboxManager.sandboxPath()
        let stagingPath = (sandboxPath as NSString)
            .appendingPathComponent(".remote/\(manifest.appId)-\(manifest.versionCode)")
        let targetPath = DMPSandboxManager.appBundlePath(manifest.appId)
        let backupPath = (sandboxPath as NSString)
            .appendingPathComponent(".backup/\(manifest.appId)-\(Int(Date().timeIntervalSince1970 * 1000))")

        defer {
            DMPFileUtil.removeItem(at: stagingPath)
            DMPFileUtil.removeItem(at: zipPath)
        }

        DMPFileUtil.removeItem(at: stagingPath)
        guard DMPFileUtil.unzipFile(at: zipPath, to: stagingPath) else {
            throw RemoteUpdateError.install("failed to unzip package")
        }

        try writeConfig(manifest: manifest, to: (stagingPath as NSString).appendingPathComponent("config.json"))
        try validatePackage(at: stagingPath)

        try FileManager.default.createDirectory(
            atPath: (backupPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true,
            attributes: nil
        )

        do {
            if FileManager.default.fileExists(atPath: targetPath) {
                try FileManager.default.moveItem(atPath: targetPath, toPath: backupPath)
            }
            try FileManager.default.moveItem(atPath: stagingPath, toPath: targetPath)
            DMPFileUtil.removeItem(at: backupPath)
            DMPSandboxManager.initBundleDirectoryForApp(appId: manifest.appId)
        } catch {
            if !FileManager.default.fileExists(atPath: targetPath),
               FileManager.default.fileExists(atPath: backupPath) {
                try? FileManager.default.moveItem(atPath: backupPath, toPath: targetPath)
            }
            throw error
        }
    }

    private func writeConfig(manifest: RemoteUpdateManifest, to path: String) throws {
        let config: [String: Any] = [
            "appId": manifest.appId,
            "name": manifest.name,
            "path": manifest.path,
            "versionCode": manifest.versionCode,
            "versionName": manifest.versionName,
        ]
        let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted])
        try FileManager.default.createDirectory(
            atPath: (path as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true,
            attributes: nil
        )
        try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    }

    private func requestData(url: URL) async throws -> (Data, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.dataTask(with: url) { data, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let data, let response else {
                    continuation.resume(throwing: RemoteUpdateError.network("empty response"))
                    return
                }
                continuation.resume(returning: (data, response))
            }.resume()
        }
    }

    private func downloadFile(url: URL) async throws -> (URL, URLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            URLSession.shared.downloadTask(with: url) { url, response, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let url, let response else {
                    continuation.resume(throwing: RemoteUpdateError.network("empty download response"))
                    return
                }
                continuation.resume(returning: (url, response))
            }.resume()
        }
    }

    private func validatePackage(at packagePath: String) throws {
        let requiredFiles = [
            "config.json",
            "main/app-config.json",
            "main/logic.js",
        ]

        for file in requiredFiles {
            let path = (packagePath as NSString).appendingPathComponent(file)
            guard FileManager.default.fileExists(atPath: path) else {
                throw RemoteUpdateError.install("package missing required file: \(file)")
            }
        }
    }

    private func currentVersionCode(appId: String) -> Int {
        let config = DMPFileUtil.loadJSONFromFile(filePath: DMPSandboxManager.appBundleConfigPath(appId: appId))
        return config?["versionCode"] as? Int ?? 0
    }

    private func verifySha256(filePath: String, expectedSha256: String) throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA256(buffer.baseAddress, CC_LONG(data.count), &digest)
        }
        let actualSha256 = digest.map { String(format: "%02x", $0) }.joined()
        guard actualSha256.lowercased() == expectedSha256.lowercased() else {
            throw RemoteUpdateError.install("package sha256 mismatch")
        }
    }

    private struct RemoteUpdateManifest {
        let appId: String
        let name: String
        let path: String
        let versionCode: Int
        let versionName: String
        let packageUrl: String
        let sha256: String?

        init(json: [String: Any]) throws {
            guard let appId = json["appId"] as? String, !appId.isEmpty else {
                throw RemoteUpdateError.invalidManifest("manifest missing appId")
            }
            guard let path = json["path"] as? String, !path.isEmpty else {
                throw RemoteUpdateError.invalidManifest("manifest missing path")
            }
            guard let versionCode = json["versionCode"] as? Int else {
                throw RemoteUpdateError.invalidManifest("manifest missing versionCode")
            }

            let packageUrl = (json["packageUrl"] as? String)
                ?? (json["downloadUrl"] as? String)
                ?? (json["url"] as? String)
                ?? ""
            guard !packageUrl.isEmpty else {
                throw RemoteUpdateError.invalidManifest("manifest missing packageUrl")
            }

            self.appId = appId
            self.name = json["name"] as? String ?? ""
            self.path = path
            self.versionCode = versionCode
            self.versionName = json["versionName"] as? String ?? ""
            self.packageUrl = packageUrl
            self.sha256 = json["sha256"] as? String
        }
    }

    private enum RemoteUpdateError: Error {
        case invalidManifest(String)
        case network(String)
        case install(String)
    }
}
