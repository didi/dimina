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
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let pathExtension = URL(fileURLWithPath: path).pathExtension
        return try makePayload(
            data: data,
            pathExtension: pathExtension,
            webKitSupportsHEIF: webKitSupportsHEIF
        )
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
        case "heic":
            return "image/heic"
        case "heif":
            return "image/heif"
        case "json":
            return "application/json"
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

        if path == "/pageFrame.html" {
            return DMPFileUtil.confinedPath(
                rootPath: DMPSandboxManager.sdkMainBundlePath(),
                relativePath: "pageFrame.html"
            )
        }

        if path.hasPrefix("/assets/") {
            return DMPFileUtil.confinedPath(
                rootPath: DMPSandboxManager.sdkMainBundlePath(),
                relativePath: path
            )
        }

        let appPrefix = "/\(appId)/"
        let appRelativePath = path.hasPrefix(appPrefix)
            ? String(path.dropFirst(appPrefix.count))
            : path
        return DMPFileUtil.confinedPath(
            rootPath: DMPSandboxManager.appBundlePath(appId),
            relativePath: appRelativePath
        )
    }
    
}
