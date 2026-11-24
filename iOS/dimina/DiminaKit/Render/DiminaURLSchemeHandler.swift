//
//  DiminaURLSchemeHandler.swift
//  dimina
//
//  Created by Lehem on 2025/4/25.
//

import Foundation
import UIKit
import WebKit

struct DMPWebResourcePayload {
    let data: Data
    let mimeType: String
}

enum DMPWebResourceLoader {
    static func load(path: String) throws -> DMPWebResourcePayload {
        let fileURL = URL(fileURLWithPath: path)
        let pathExtension = fileURL.pathExtension
        let isVideo = mimeType(forExtension: pathExtension).hasPrefix("video/")
        let data = try Data(contentsOf: fileURL, options: isVideo ? .mappedIfSafe : [])
        return try makePayload(
            data: data,
            pathExtension: pathExtension,
            webKitSupportsHEIF: webKitSupportsHEIF
        )
    }

    static func sendVideoRange(_ task: WKURLSchemeTask, url: URL, path: String, allowsOctetStream: Bool = false) throws -> Bool {
        let fileURL = URL(fileURLWithPath: path)
        let mimeType = mimeType(forExtension: fileURL.pathExtension)
        guard mimeType.hasPrefix("video/") || (allowsOctetStream && mimeType == "application/octet-stream"),
              let header = task.request.value(forHTTPHeaderField: "Range"),
              header.hasPrefix("bytes=") else { return false }

        let file = try FileHandle(forReadingFrom: fileURL)
        defer { try? file.close() }
        let size = try file.seekToEnd()
        guard let range = videoByteRange(header.dropFirst("bytes=".count), size: size),
              let count = Int(exactly: range.upperBound - range.lowerBound),
              let response = HTTPURLResponse(url: url, statusCode: 206, httpVersion: nil, headerFields: [
                "Content-Type": mimeType,
                "Accept-Ranges": "bytes",
                "Content-Length": String(count),
                "Content-Range": "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(size)",
              ]) else { return false }

        try file.seek(toOffset: range.lowerBound)
        guard let data = try file.read(upToCount: count), data.count == count else {
            throw CocoaError(.fileReadCorruptFile)
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
        return true
    }

    private static func videoByteRange(_ value: Substring, size: UInt64) -> Range<UInt64>? {
        let bounds = value.split(separator: "-", omittingEmptySubsequences: false)
        guard size > 0, bounds.count == 2 else { return nil }
        if bounds[0].isEmpty {
            guard let length = UInt64(bounds[1]), length > 0 else { return nil }
            return (size - min(length, size))..<size
        }
        guard let start = UInt64(bounds[0]), start < size else { return nil }
        if bounds[1].isEmpty { return start..<size }
        guard let end = UInt64(bounds[1]), end >= start else { return nil }
        return start..<(min(end, size - 1) + 1)
    }

    static func makePayload(
        data: Data,
        pathExtension: String,
        webKitSupportsHEIF: Bool
    ) throws -> DMPWebResourcePayload {
        guard requiresHEIFTranscode(
            pathExtension: pathExtension,
            webKitSupportsHEIF: webKitSupportsHEIF
        ) else {
            return DMPWebResourcePayload(
                data: data,
                mimeType: mimeType(forExtension: pathExtension)
            )
        }

        guard let image = UIImage(data: data),
              let jpegData = image.jpegData(compressionQuality: 1.0) else {
            throw NSError(
                domain: "DiminaErrorDomain",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "Unable to decode HEIF image resource"]
            )
        }
        return DMPWebResourcePayload(data: jpegData, mimeType: "image/jpeg")
    }

    static func requiresHEIFTranscode(
        pathExtension: String,
        webKitSupportsHEIF: Bool
    ) -> Bool {
        let normalizedExtension = pathExtension.lowercased()
        let isHEIFFamily = normalizedExtension == "heic" || normalizedExtension == "heif"
        return isHEIFFamily && !webKitSupportsHEIF
    }

    static func mimeType(forExtension pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "html", "htm":
            return "text/html"
        case "css":
            return "text/css"
        case "js":
            return "application/javascript"
        case "jpg", "jpeg":
            return "image/jpeg"
        case "png":
            return "image/png"
        case "gif":
            return "image/gif"
        case "svg":
            return "image/svg+xml"
        case "webp", "bmp", "avif":
            return "image/\(pathExtension.lowercased())"
        case "ico":
            return "image/x-icon"
        case "heic":
            return "image/heic"
        case "heif":
            return "image/heif"
        case "mp4", "m4v":
            return "video/mp4"
        case "mov":
            return "video/quicktime"
        case "json":
            return "application/json"
        case "ttf", "otf", "woff", "woff2":
            return "font/\(pathExtension.lowercased())"
        default:
            return "application/octet-stream"
        }
    }

    private static var webKitSupportsHEIF: Bool {
        if #available(iOS 17.0, *) {
            return true
        }
        return false
    }
}

@available(iOS 11.0, *)
class DiminaURLSchemeHandler: NSObject, WKURLSchemeHandler {
    private static let localMediaPath = "/__dimina_media"
    private let appId: String
    let canvasResources = DMPCanvasResources()
    
    init(appId: String) {
        self.appId = appId
        super.init()
    }
    
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "DiminaErrorDomain", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"]))
            return
        }

        if url.scheme == "dimina", url.host == nil, url.path.hasPrefix(DMPHostImages.resourcePath) {
            do {
                let key = String(url.path.dropFirst(DMPHostImages.resourcePath.count))
                let payload = try DMPHostImages.load(key)
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: payload.mimeType,
                                                    expectedContentLength: payload.data.count, textEncodingName: nil))
                urlSchemeTask.didReceive(payload.data)
                urlSchemeTask.didFinish()
            } catch {
                urlSchemeTask.didFailWithError(error)
            }
            return
        }

        if url.scheme == "dimina", url.host == nil, url.path.hasPrefix(DMPHostFonts.resourcePath) {
            do {
                let id = String(url.path.dropFirst(DMPHostFonts.resourcePath.count))
                let payload = try DMPHostFonts.load(id)
                urlSchemeTask.didReceive(URLResponse(url: url, mimeType: payload.mimeType,
                                                    expectedContentLength: payload.data.count, textEncodingName: nil))
                urlSchemeTask.didReceive(payload.data)
                urlSchemeTask.didFinish()
            } catch {
                urlSchemeTask.didFailWithError(error)
            }
            return
        }
        
        if url.scheme == "dimina", url.host == nil, url.path.hasPrefix("/__canvas_packet/") {
            guard let data = canvasResources.take(url, for: webView) else {
                urlSchemeTask.didFailWithError(NSError(domain: "Canvas packet expired or unavailable", code: 404)); return
            }
            urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "application/octet-stream", expectedContentLength: data.count, textEncodingName: nil))
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
            return
        }
        guard let path = resolvePath(for: url) else {
            urlSchemeTask.didFailWithError(NSError(
                domain: "DiminaErrorDomain",
                code: 403,
                userInfo: [NSLocalizedDescriptionKey: "Resource path is outside the application sandbox"]
            ))
            return
        }
        DMPLogger.debug("📦 DiminaURLSchemeHandler loading resource: \(path)")
        
        // Check if the file exists
        guard FileManager.default.fileExists(atPath: path) else {
            let errorMessage = "Resource does not exist: \(path)"
            DMPLogger.debug("❌ \(errorMessage)")
            urlSchemeTask.didFailWithError(NSError(domain: "DiminaErrorDomain", code: 404, userInfo: [NSLocalizedDescriptionKey: errorMessage]))
            return
        }
        
        do {
            if try DMPWebResourceLoader.sendVideoRange(
                urlSchemeTask, url: url, path: path, allowsOctetStream: url.path == Self.localMediaPath
            ) { return }
            let payload = try DMPWebResourceLoader.load(path: path)
            let response = URLResponse(
                url: url,
                mimeType: payload.mimeType,
                expectedContentLength: payload.data.count,
                textEncodingName: "UTF-8"
            )
            
            // Return response and data
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(payload.data)
            urlSchemeTask.didFinish()
            
            DMPLogger.debug("✅ Resource loaded successfully: \(url.absoluteString)")
        } catch {
            DMPLogger.debug("❌ Resource loading failed: \(error.localizedDescription)")
            urlSchemeTask.didFailWithError(error)
        }
    }
    
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Cleanup operations when the task is stopped
        DMPLogger.debug("🛑 Stopping resource loading")
    }

    private func resolvePath(for url: URL) -> String? {
        guard url.scheme?.lowercased() == "dimina",
              url.user == nil,
              url.password == nil,
              url.host == nil || url.host?.isEmpty == true else {
            return nil
        }
        let path = url.path

        if path == Self.localMediaPath {
            guard let source = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "source" })?.value else { return nil }
            return DMPFileUtil.appAccessiblePath(from: source, appId: appId)
        }

        if path == "/pageFrame.html" {
            return DMPFileUtil.confinedPath(
                rootPath: DMPSandboxManager.sdkMainBundlePath(),
                relativePath: "pageFrame.html"
            )
        }

        let isVideo = DMPWebResourceLoader.mimeType(forExtension: url.pathExtension).hasPrefix("video/")
        if path.hasPrefix("/assets/") {
            let sdkPath = DMPFileUtil.confinedPath(
                rootPath: DMPSandboxManager.sdkMainBundlePath(),
                relativePath: path
            )
            guard isVideo, let sdkPath, !FileManager.default.fileExists(atPath: sdkPath) else {
                return sdkPath
            }
        }

        let appPrefix = "/\(appId)/"
        let appRelativePath = path.hasPrefix(appPrefix)
            ? String(path.dropFirst(appPrefix.count))
            : path
        let rootPath = DMPSandboxManager.appBundlePath(appId)
        let bundlePath = DMPFileUtil.confinedPath(rootPath: rootPath, relativePath: appRelativePath)
        guard isVideo, let bundlePath, !FileManager.default.fileExists(atPath: bundlePath) else {
            return bundlePath
        }
        // Inline video also accepts package-relative paths such as assets/clip.mp4.
        return DMPFileUtil.confinedPath(
            rootPath: rootPath,
            relativePath: "main/\(appRelativePath.trimmingCharacters(in: CharacterSet(charactersIn: "/")))"
        )
    }
    
}
