//
//  DMPRender.swift
//  dimina
//
//  Created by Lehem on 2025/4/22.
//

import Foundation
import SwiftUI
import WebKit

public class DMPRender: DMPWebViewDelegate {
    private var webviewsMap: [Int: DMPWebview] = [:]
    private weak var app: DMPApp?

    private lazy var invokeHandler: DMPWebViewInvoke = DMPWebViewInvoke(render: self)
    private lazy var publishHandler: DMPWebViewPublish = DMPWebViewPublish(render: self)

    public init(app: DMPApp? = nil) {
        self.app = app
    }

    public func getApp() -> DMPApp? {
        return app
    }

    @MainActor
    public func createWebView(appName: String) -> DMPWebview {
        let webview = DMPWebViewPool.shared.acquireWebView(
            delegate: self, 
            appName: appName, 
            appId: app?.getAppId() ?? ""
        )
        webviewsMap[webview.getWebViewId()] = webview
        return webview
    }
    
    // Release WebView instance
    @MainActor
    public func releaseWebView(_ webview: DMPWebview) {
        let webViewId = webview.getWebViewId()
        NativeComponentAPI.clear(webViewId: webViewId)
        webviewsMap.removeValue(forKey: webViewId)
        DMPWebViewPool.shared.releaseWebView(webview)
    }

    public func getWebView(byId id: Int) -> DMPWebview? {
        return webviewsMap[id]
    }

    // Execute JavaScript code
    public func executeJavaScript(webViewId: Int, _ script: String, completionHandler: ((Any?, Error?) -> Void)? = nil) -> Void {
        webviewsMap[webViewId]?.executeJavaScript(script, completionHandler: completionHandler)
    }

    // JavaScriptCore runs on the service thread. Keep the main run loop free to
    // execute the queued drawing commands and return the actual WebGL result.
    func canvasNodeSync(webViewId: Int, request: DMPMap) -> Any {
        guard !Thread.isMainThread else { return ["error": "Canvas query requires the service thread"] }
        let reply = CanvasSyncReply()
        let semaphore = DispatchSemaphore(value: 0)
        let json = request.toJsonString()
        guard let quoted = try? JSONSerialization.data(withJSONObject: json, options: [.fragmentsAllowed]),
              let argument = String(data: quoted, encoding: .utf8) else {
            return ["error": "Invalid canvas request"]
        }
        DispatchQueue.main.async { [weak self] in
            guard reply.isActive() else { return }
            guard let webview = self?.webviewsMap[webViewId] else {
                reply.set(["error": "Canvas page has been disposed"])
                semaphore.signal()
                return
            }
            let script = "(function(){try{return __diminaCanvasSync(JSON.parse(\(argument)))}catch(e){return {error:String(e)}}})()"
            webview.executeJavaScript(script) { value, error in
                reply.set(value ?? ["error": error?.localizedDescription ?? "Canvas renderer returned no result"])
                semaphore.signal()
            }
        }
        guard semaphore.wait(timeout: .now() + 5) == .success else {
            reply.cancel()
            return ["error": "Canvas query timed out"]
        }
        return reply.get()
    }

    // Register JavaScript method to allow Native to listen to JavaScript calls
    public func registerJSHandler(webViewId: Int, handlerName: String, callback: @escaping (Any) -> Void) {
        webviewsMap[webViewId]?.registerJSHandler(handlerName: handlerName, callback: callback)
    }

    // Set up JS bridge for single WebView
    public func setupJSBridge(webViewId: Int) {
        guard let webview = webviewsMap[webViewId] else { return }

        // Register handlers
        invokeHandler.registerInvokeHandler(webview: webview, webViewId: webViewId)
        publishHandler.registerPublishHandler(webview: webview)

        // Inject JavaScript code
        invokeHandler.injectInvokeJavaScript(webview: webview)
        publishHandler.injectPublishJavaScript(webview: webview)
    }

    // Provide WebView view for DMPPage
    public func getWebViewRepresentable(webViewId: Int) -> AnyView {
        if let webview = webviewsMap[webViewId] {
            // Use createWebView() method to create complete view
            return AnyView(webview.createWebView())
        }
        return AnyView(Text("WebView not initialized").padding())
    }

    // DMPWebViewDelegate protocol implementation - Handle WebView load completion event
    public func webViewDidFinishLoad(webViewId: Int) {
        DMPLogger.debug("🔴 DMPRender: WebView load completed \(webViewId)")
        let webview = webviewsMap[webViewId]

        guard let webview = webview else {
            DMPLogger.debug("🟡DMPRender: WebView (ID: \(webViewId)) not found in map")
            return
        }
        
        if webview.poolState != .loading {
            DMPLogger.debug("🟡 DMPRender: WebView (ID: \(webViewId)) is not in loading state (\(webview.poolState.description)), skip resource loading")
            return
        }
        
        let currentPagePath = webview.getPagePath()
        if currentPagePath.isEmpty || currentPagePath == "resetting" {
            DMPLogger.debug("🟡 DMPRender: WebView (ID: \(webViewId)) has invalid page path '\(currentPagePath)', skip resource loading")
            return
        }
        
        DMPLogger.debug("✅ DMPRender: WebView (ID: \(webViewId)) ready for resource loading with path: \(currentPagePath)")
        Task { [weak self, weak webview] in
            await self?.app?.container?.loadResourceService(webViewId: webViewId, pagePath: currentPagePath)

            await MainActor.run { [weak self, weak webview] in
                guard let self = self, let webview = webview else { return }
                self.app?.container?.loadResourceRender(webViewId: webViewId, pagePath: currentPagePath)
                webview.poolState = .ready
                DMPLogger.debug("✅ DMPRender: WebView (ID: \(webViewId)) marked as ready")
            }
        }
    }

    // DMPWebViewDelegate protocol implementation - Handle WebView load failure event
    public func webViewDidFailLoad(webViewId: Int, error: Error) {
        DMPLogger.debug("🔴 DMPRender: WebView load failed: \(error.localizedDescription)")
    }

    public func fromContainer(data: DMPMap, webViewId: Int) {
        let webview = webviewsMap[webViewId]
        let dataString = data.toJsonString()
        
        DispatchQueue.main.async {
            webview?.executeJavaScript("DiminaRenderBridge.onMessage(\(dataString))", completionHandler: nil)
        }
    }

    public func fromService(msg: String, webViewId: Int) {
        let webview = webviewsMap[webViewId]
        
        DispatchQueue.main.async {
            webview?.executeJavaScript("DiminaRenderBridge.onMessage(\(msg))", completionHandler: nil)
        }
    }
}

private final class CanvasSyncReply: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var value: Any = ["error": "Canvas renderer returned no result"]
    func isActive() -> Bool { lock.lock(); defer { lock.unlock() }; return active }
    func cancel() { lock.lock(); defer { lock.unlock() }; active = false }
    func set(_ value: Any) { lock.lock(); defer { lock.unlock() }; if active { self.value = value } }
    func get() -> Any { lock.lock(); defer { lock.unlock() }; return value }
}
