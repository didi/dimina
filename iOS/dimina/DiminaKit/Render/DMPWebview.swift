//
//  DMPWebview.swift
//  dimina
//
//  Created by Lehem on 2025/4/22.
//

import Foundation
import WebKit
import SwiftUI

/// WebView state enum
public enum DMPWebViewState {
    case available          // Available state, can be reused
    case configuring        // Configuring, setting page path and parameters
    case loading            // Loading, loading page content
    case ready              // Ready state, page load completed, can interact
    case reseting           // Resetting, clearing state, cannot be reused
    
    var description: String {
        switch self {
        case .available: return "available"
        case .configuring: return "configuring"
        case .loading: return "loading"
        case .ready: return "ready"
        case .reseting: return "reseting"
        }
    }
    
    /// Whether it can be reused
    var canReuse: Bool {
        return self == .available
    }
    
    /// Whether it is in use
    var isInUse: Bool {
        return self == .configuring || self == .loading || self == .ready
    }
    
    /// Whether page interaction is possible
    var canInteract: Bool {
        return self == .ready
    }
    
    /// Whether it is loading
    var isLoading: Bool {
        return self == .loading
    }
}

// Define WebView delegate protocol
public protocol DMPWebViewDelegate: AnyObject {
    func webViewDidFinishLoad(webViewId: Int)
    func webViewDidFailLoad(webViewId: Int, error: Error)
}

public class DMPWebview: NSObject, WKNavigationDelegate, WKScriptMessageHandler, ObservableObject {
    private var webView: WKWebView
    private weak var delegate: DMPWebViewDelegate?
    internal var jsBridgeCallbacks: [String: (Any) -> Void] = [:]

    // Add WebViewLogger member variable
    internal var logger: DMPWebViewLogger?

    private var webViewId: Int
    internal var pagePath: String
    internal var query: [String: Any] = [:]
    
    public let createdAt: Date = Date()
    
    // Add default configuration method
    private static func defaultConfiguration(appId: String, processPool: WKProcessPool? = nil) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        
        // Use performance optimizer to apply all optimization configurations
        DMPWebViewOptimizer.shared.applyOptimizations(to: config, appId: appId, processPool: processPool)
        
        return config
    }

    public var appName: String
    public var onLoadingStateChanged: ((Bool) -> Void)?
    
    // Publish notification when state changes
    @Published public var poolState: DMPWebViewState = .available {
        didSet {
            // When the state changes, trigger UI update
            objectWillChange.send()
            onLoadingStateChanged?(poolState.isLoading)
        }
    }
    
    // Calculate property: based on state return whether it is loading
    public var isLoading: Bool {
        return poolState.isLoading
    }

    // Modify constructor
    public init(delegate: DMPWebViewDelegate?, appName: String, appId: String, processPool: WKProcessPool? = nil) {
        let config = DMPWebview.defaultConfiguration(appId: appId, processPool: processPool)

        self.webView = WKWebView(frame: .zero, configuration: config)
        if #available(iOS 16.4, *) {
            self.webView.isInspectable = true
        }
        self.delegate = delegate
        self.webViewId = DMPIdProvider.generateWebViewId()
        self.pagePath = ""
        self.appName = appName

        super.init()

        self.webView.navigationDelegate = self

        // Apply WebView instance optimization
        DMPWebViewOptimizer.shared.optimizeWebViewInstance(self.webView)

        // Initialize log recorder
        self.logger = DMPWebViewLogger(webView: self.webView, webViewId: self.webViewId)
    }

    // Set delegate method
    public func setDelegate(_ delegate: DMPWebViewDelegate?) {
        self.delegate = delegate
    }

    // Set log handler delegate
    public func setLoggerDelegate(_ delegate: DMPWebViewLoggerDelegate?) {
        self.logger?.setDelegate(delegate)
    }

    private func injectRenderBridgeBootstrapScript() {
        let bootstrapScript = WKUserScript(source: """
        (function() {
            var bridge = window.DiminaRenderBridge = window.DiminaRenderBridge || {};
            if (bridge.__diminaOnMessageBuffered) {
                return;
            }

            var queue = [];
            var handler = typeof bridge.onMessage === 'function' ? bridge.onMessage : null;
            var handlerReady = false;
            var flushScheduled = false;

            function flushQueue() {
                if (!handler || queue.length === 0) {
                    return;
                }

                var pendingMessages = queue.splice(0, queue.length);
                for (var i = 0; i < pendingMessages.length; i++) {
                    handler(pendingMessages[i]);
                }
            }

            function scheduleFlushQueue() {
                if (flushScheduled) {
                    return;
                }

                flushScheduled = true;
                setTimeout(function() {
                    flushScheduled = false;
                    handlerReady = !!handler;
                    flushQueue();
                }, 0);
            }

            Object.defineProperty(bridge, 'onMessage', {
                configurable: true,
                enumerable: true,
                get: function() {
                    if (handler && handlerReady) {
                        return handler;
                    }

                    return function(msg) {
                        queue.push(msg);
                        if (handler) {
                            scheduleFlushQueue();
                        }
                    };
                },
                set: function(nextHandler) {
                    handler = typeof nextHandler === 'function' ? nextHandler : null;
                    handlerReady = false;
                    scheduleFlushQueue();
                }
            });

            Object.defineProperty(bridge, '__diminaOnMessageBuffered', {
                configurable: true,
                value: true
            });
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: false)

        webView.configuration.userContentController.addUserScript(bootstrapScript)
    }
    
    // Load page framework
    public func loadPageFrame(enableVConsole: Bool = false) {
        let pageFramePath = enableVConsole ? "dimina:///pageFrame.html?vconsole=1" : "dimina:///pageFrame.html"
        guard let pageFrameURL = URL(string: pageFramePath) else {
            print("❌ Invalid pageFrame URL")
            return
        }

        injectRenderBridgeBootstrapScript()
        webView.load(URLRequest(url: pageFrameURL))
    }

    // Register a JS message handler to allow JS to call native methods
    public func registerJSHandler(handlerName: String, callback: @escaping (Any) -> Void) {
        print("🔧 WebView (ID: \(getWebViewId())) trying to register handler: \(handlerName)")
        
        // Check if this handler is already registered
        if jsBridgeCallbacks[handlerName] != nil {
            print("⚠️ WebView (ID: \(getWebViewId())) handler \(handlerName) already exists, clean first then re-register")
            // Remove existing handler first
            webView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
            print("🧹 WebView (ID: \(getWebViewId())) cleaned handler: \(handlerName)")
        }
        
        // Use safe way to register handler to prevent system-level duplicate registration exceptions
        webView.configuration.userContentController.add(self, name: handlerName)
        jsBridgeCallbacks[handlerName] = callback
        print("✅ WebView (ID: \(getWebViewId())) successfully registered handler: \(handlerName)")
    }

    // Execute JavaScript code
    public func executeJavaScript(_ script: String, completionHandler: ((Any?, Error?) -> Void)? = nil) -> Void {
        if Thread.isMainThread {
            webView.evaluateJavaScript(script, completionHandler: completionHandler)
        } else {
            DispatchQueue.main.async {
                self.webView.evaluateJavaScript(script, completionHandler: completionHandler)
            }
        }
    }

    // WKScriptMessageHandler implementation
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let callback = jsBridgeCallbacks[message.name] {
            callback(message.body)
        }
    }

    // WKNavigationDelegate implementation - Use delegate pattern instead of direct dependency
    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("🔴 DMPWebview: Web page load completed \(webViewId)")
        // Notify web page load completion through delegate callback
        delegate?.webViewDidFinishLoad(webViewId: self.webViewId)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("Web page load failed: \(error.localizedDescription)")
        // Add detailed error information logging
        let errorInfo: [String: Any] = [
            "message": error.localizedDescription,
            "domain": (error as NSError).domain,
            "code": (error as NSError).code,
            "userInfo": (error as NSError).userInfo,
            "webViewId": self.webViewId
        ]
        print("Detailed error information: \(errorInfo)")
        // Notify web page load failure through delegate callback
        delegate?.webViewDidFailLoad(webViewId: self.webViewId, error: error)
    }

    // Use custom URL scheme to handle resource loading
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Empty implementation, allow all navigation requests
        decisionHandler(.allow)
    }

    // Get underlying WKWebView
    public func getWebView() -> WKWebView {
        return webView
    }

    // Get WebView's unique ID
    public func getWebViewId() -> Int {
        return webViewId
    }

    // Get WebView's page path
    public func getPagePath() -> String {
        return self.pagePath
    }

    public func setPagePath(pagePath: String) {
        self.pagePath = pagePath
    }

    public func getQuery() -> [String: Any] {
        return self.query
    }

    public func setQuery(query: [String: Any]) {
        self.query = query
    }

    // Add internal method to regenerate webViewId
    internal func regenerateWebViewId() {
        self.webViewId = DMPIdProvider.generateWebViewId()
        // Also update logger's webViewId if it exists
        if let logger = self.logger {
            logger.updateWebViewId(self.webViewId)
        }
    }

    // SwiftUI view wrapper
    public struct WebViewRepresentable: UIViewRepresentable {
        @ObservedObject var webview: DMPWebview  // Use @ObservedObject

        public init(webview: DMPWebview) {
            self.webview = webview
        }

        public func makeUIView(context: Context) -> WKWebView {
            return webview.getWebView()
        }

        public func updateUIView(_ uiView: WKWebView, context: Context) {
            // Update UI view (if needed)
        }
    }

    deinit {
        // Clean registered message handlers
        for handlerName in jsBridgeCallbacks.keys {
            webView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
        }
        // Clean log recorder
        logger?.cleanup()
        logger = nil
    }

    // Modify hideLoading method
    public func hideLoading() {
        if Thread.isMainThread {
            finishLoadingIfNeeded()
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.finishLoadingIfNeeded()
            }
        }
    }

    private func finishLoadingIfNeeded() {
        guard poolState == .loading else {
            return
        }

        withAnimation(.easeOut(duration: 0.3)) {
            poolState = .ready
        }
    }

    public struct WebViewContainer: View {
        @ObservedObject var webview: DMPWebview
        var isRoot: Bool = false

        public init(webview: DMPWebview, isRoot: Bool = false) {
            self.webview = webview
            self.isRoot = isRoot
        }

        public var body: some View {
            ZStack {
                WebViewRepresentable(webview: webview)
            }
        }
    }

    public func createWebView(isRoot: Bool = false) -> some View {
        WebViewContainer(webview: self, isRoot: isRoot)
    }
}

public struct DMPLoadingView: View {
    let appName: String
    @State private var rotation: Double = 0.0
    let timer = Timer.publish(every: 0.01, on: .main, in: .common).autoconnect()

    public var body: some View {
        ZStack {
            Color.white
                .ignoresSafeArea()

            VStack(spacing: 8) {
                ZStack {
                    Circle()
                        .stroke(Color.gray.opacity(0.3), lineWidth: 1)
                        .frame(width: 60, height: 60)

                    Circle()
                        .fill(DMPUtil.generateColorFromName(name: appName))
                        .frame(width: 40, height: 40)
                        .overlay(
                            Text(String(appName.prefix(1)))
                                .font(.system(size: 16))
                                .fontWeight(.bold)
                                .foregroundColor(.white)
                        )

                    Circle()
                        .fill(Color.green)
                        .frame(width: 6, height: 6)
                        .offset(y: -30)
                        .rotationEffect(.degrees(rotation))
                }
                .frame(width: 60, height: 60)

                Text(appName)
                    .font(.system(size: 14))
                    .fontWeight(.medium)
            }
        }
        .onReceive(timer) { _ in
            withAnimation {
                rotation += 3.0
            }
        }
    }
}

#Preview("LoadingView") {
    DMPLoadingView(appName: "Test App")
}
