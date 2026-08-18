//
//  DiminaURLSchemeHandler.swift
//  dimina
//
//  Created by Lehem on 2025/4/25.
//

import Foundation
import WebKit

@available(iOS 11.0, *)
class DiminaURLSchemeHandler: NSObject, WKURLSchemeHandler {
    private let appId: String
    
    init(appId: String) {
        self.appId = appId
        super.init()
    }
    
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "DiminaErrorDomain", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid URL"]))
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
            // Read file data
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            
            let mimeType = mimeTypeForPath(path)
            let response = URLResponse(url: url, mimeType: mimeType, expectedContentLength: data.count, textEncodingName: "UTF-8")
            
            // Return response and data
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
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
    
    // Get MIME type based on file path
    private func mimeTypeForPath(_ path: String) -> String {
        let pathExtension = URL(fileURLWithPath: path).pathExtension.lowercased()
        
        switch pathExtension {
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
        case "json":
            return "application/json"
        default:
            return "application/octet-stream"
        }
    }
}
