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
        
        let path = resolvePath(for: url)
        print("📦 DiminaURLSchemeHandler loading resource: \(path)")
        
        // Check if the file exists
        guard FileManager.default.fileExists(atPath: path) else {
            let errorMessage = "Resource does not exist: \(path)"
            print("❌ \(errorMessage)")
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
            
            print("✅ Resource loaded successfully: \(url.absoluteString)")
        } catch {
            print("❌ Resource loading failed: \(error.localizedDescription)")
            urlSchemeTask.didFailWithError(error)
        }
    }
    
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Cleanup operations when the task is stopped
        print("🛑 Stopping resource loading")
    }

    private func resolvePath(for url: URL) -> String {
        let path = url.path

        if path == "/pageFrame.html" || path.contains("vconsole") {
            return sdkPath(for: path)
        }

        if path.hasPrefix("/assets/") {
            let sdkResourcePath = sdkPath(for: path)
            if FileManager.default.fileExists(atPath: sdkResourcePath) {
                return sdkResourcePath
            }
        }

        return DMPSandboxManager.sandboxPath() + path
    }

    private func sdkPath(for path: String) -> String {
        return DMPSandboxManager.sdkMainBundlePath() + path
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
