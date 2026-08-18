//
//  DMPWebViewPool.swift
//  dimina
//
//  Created by Lehem on 2025/5/15.
//

import Foundation
import WebKit
import UIKit

/// WebView cache pool management class
/// Responsible for pre-creating, caching and reusing WebView instances to improve page opening speed
@MainActor
public class DMPWebViewPool {
    // MARK: - Singleton
    public static let shared = DMPWebViewPool()
    
    // MARK: - Properties
    private var webViews: [DMPWebview] = []
    private let maxPoolSize: Int = 4
    private let minPoolSize: Int = 1
    
    // Shared WKProcessPool instance - ensure creation on main thread
    internal static let sharedProcessPool: WKProcessPool = {
        // Ensure creation on main thread
        assert(Thread.isMainThread, "WKProcessPool must be created on main thread")
        let processPool = WKProcessPool()
        DMPLogger.debug("🔧 WebViewPool: Created shared WKProcessPool")
        return processPool
    }()
    
    // MARK: - Initialization
    private init() {
        setupNotifications()
    }
    
    deinit {
        NotificationCenter.default.removeObserver(self)
        webViews.removeAll()
        DMPLogger.debug("🧹 WebViewPool: Clear pool during deallocation")
    }
    
    // MARK: - Notification Setup
    private func setupNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationDidReceiveMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
        
        // Add application termination notification
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(applicationWillTerminate),
            name: UIApplication.willTerminateNotification,
            object: nil
        )
    }
    
    // MARK: - Public Methods
    
    /// Get a usable WebView instance
    /// - Parameters:
    ///   - delegate: WebView delegate
    ///   - appName: Application name
    ///   - appId: Application ID
    /// - Returns: Configured DMPWebview instance
    public func acquireWebView(delegate: DMPWebViewDelegate?, appName: String, appId: String) -> DMPWebview {
        let availableCount = webViews.filter { $0.poolState.canReuse }.count
        let inUseCount = webViews.filter { $0.poolState.isInUse }.count
        let resetingCount = webViews.filter { $0.poolState == .reseting }.count
        
        DMPLogger.debug("🟦 WebViewPool: Requesting WebView, pool status - Available: \(availableCount), InUse: \(inUseCount), Reseting: \(resetingCount)")
        
        let webview: DMPWebview
        
        if let availableWebView = findAvailableWebView(appId: appId) {
            // Reuse existing WebView
            webview = availableWebView
            
            // Update status to configuring
            webview.poolState = .configuring
            
            webview.regenerateWebViewId()
            webview.setDelegate(delegate)
            
            // Synchronously execute reset logic to ensure correct state setting
            webview.resetForReuse(appName: appName, appId: appId)
            
            DMPLogger.debug("🟢 WebViewPool: Reuse WebView (ID: \(webview.getWebViewId())), state: \(webview.poolState.description)")
        } else {
            // Create new WebView
            webview = createNewWebView(delegate: delegate, appName: appName, appId: appId)
            webview.regenerateWebViewId()
            webview.poolState = .configuring
            
            // Add to pool
            webViews.append(webview)
            
            DMPLogger.debug("🟡 WebViewPool: Create new WebView (ID: \(webview.getWebViewId())), state: \(webview.poolState.description)")
        }
        
        let newAvailableCount = webViews.filter { $0.poolState.canReuse }.count
        let newInUseCount = webViews.filter { $0.poolState.isInUse }.count
        let newResetingCount = webViews.filter { $0.poolState == .reseting }.count
        
        DMPLogger.debug("🟦 WebViewPool: WebView allocated, pool status - Available: \(newAvailableCount), InUse: \(newInUseCount), Reseting: \(newResetingCount)")
        
        // Asynchronous preload more WebViews - on main thread
        Task { @MainActor in
            await preloadWebViewsIfNeeded(appId: appId)
        }
        
        return webview
    }
    
    /// Release WebView instance back to pool
    /// - Parameter webview: WebView to release
    public func releaseWebView(_ webview: DMPWebview) {
        let webViewId = webview.getWebViewId()
        
        let availableCount = webViews.filter { $0.poolState.canReuse }.count
        let inUseCount = webViews.filter { $0.poolState.isInUse }.count
        let resetingCount = webViews.filter { $0.poolState == .reseting }.count
        
        DMPLogger.debug("🟦 WebViewPool: Requesting to release WebView (ID: \(webViewId)), pool status - Available: \(availableCount), InUse: \(inUseCount), Reseting: \(resetingCount)")
        
        // Find corresponding webview
        guard let targetWebView = webViews.first(where: { $0.getWebViewId() == webViewId && $0.poolState.isInUse }) else {
            DMPLogger.debug("⚠️ WebViewPool: Warning - Trying to release WebView that's not in use (ID: \(webViewId))")
            return
        }
        
        // Immediately set to resetting state to prevent reuse
        targetWebView.poolState = .reseting
        DMPLogger.debug("🔄 WebViewPool: WebView (ID: \(webViewId)) marked as reseting")
        
        // Asynchronously clean WebView state to avoid blocking main thread
        Task { @MainActor in
            // Clean WebView state
            targetWebView.prepareForReuse()
            
            // Add short delay to ensure cleanup is complete
            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            
            // Check if pool is full
            let totalCount = self.webViews.count
            if totalCount <= self.maxPoolSize {
                // Mark as available state
                targetWebView.poolState = .available
                DMPLogger.debug("🔵 WebViewPool: WebView returned to pool (ID: \(webViewId)), state: \(targetWebView.poolState.description)")
            } else {
                // Pool is full, destroy WebView
                self.webViews.removeAll { $0.getWebViewId() == webViewId }
                self.cleanupWebView(targetWebView)
                DMPLogger.debug("🔴 WebViewPool: Pool is full, destroy WebView (ID: \(webViewId))")
            }
            
            let newAvailableCount = self.webViews.filter { $0.poolState.canReuse }.count
            let newInUseCount = self.webViews.filter { $0.poolState.isInUse }.count
            let newResetingCount = self.webViews.filter { $0.poolState == .reseting }.count
            
            DMPLogger.debug("🟦 WebViewPool: WebView released, pool status - Available: \(newAvailableCount), InUse: \(newInUseCount), Reseting: \(newResetingCount)")
        }
    }
    
    /// Warm up WebView pool
    public func warmUp(appId: String = "") {
        Task { @MainActor in
            await preloadWebViews(appId: appId)
        }
    }
    
    /// Clear pool
    public func clearPool() {
        let availableCount = webViews.filter { $0.poolState.canReuse }.count
        let inUseCount = webViews.filter { $0.poolState.isInUse }.count
        let resetingCount = webViews.filter { $0.poolState == .reseting }.count
        
        DMPLogger.debug("🧹 WebViewPool: Start clearing pool, current status - Available: \(availableCount), InUse: \(inUseCount), Reseting: \(resetingCount)")
        
        // 1. Clean all non-using WebViews
        for webview in webViews {
            if !webview.poolState.isInUse {
                cleanupWebView(webview)
            }
        }
        
        // 2. Remove all non-using WebViews
        webViews.removeAll { !$0.poolState.isInUse }
        
        // 3. Warning for still using WebViews
        let stillInUseCount = webViews.filter { $0.poolState.isInUse }.count
        if stillInUseCount > 0 {
            DMPLogger.debug("⚠️ WebViewPool: Warning - Still \(stillInUseCount) WebViews in use")
        }
        
        DMPLogger.debug("🧹 WebViewPool: Pool cleared")
    }
    
    /// Completely clean single WebView
    private func cleanupWebView(_ webview: DMPWebview) {
        DMPLogger.debug("🧹 WebViewPool: Clean WebView (ID: \(webview.getWebViewId()))")
        
        webview.getWebView().endEditing(true)
        webview.getWebView().scrollView.endEditing(true)
        // Stop all network requests
        webview.getWebView().stopLoading()
        
        // Clean logger
        webview.logger?.cleanup()
        
        // Clean all message processors
        let userContentController = webview.getWebView().configuration.userContentController
        userContentController.removeAllUserScripts()
        
        // Clean all possible processors
        let allPossibleHandlers = ["invokeHandler", "publishHandler", "consoleLog", "consoleError", 
                                 "consoleWarn", "consoleInfo", "jsError", "networkError", "resourceError"]
        
        for handlerName in allPossibleHandlers {
            do {
                userContentController.removeScriptMessageHandler(forName: handlerName)
            } catch {
                // Ignore cleanup error
            }
        }
        
        // Clean custom JS bridges
        for handlerName in webview.jsBridgeCallbacks.keys {
            if !allPossibleHandlers.contains(handlerName) {
                do {
                    userContentController.removeScriptMessageHandler(forName: handlerName)
                } catch {
                    // Ignore cleanup error
                }
            }
        }
        webview.jsBridgeCallbacks.removeAll()
        
        // Navigate to blank page
        webview.getWebView().loadHTMLString("<html><body></body></html>", baseURL: nil)
        
        DMPLogger.debug("🧹 WebViewPool: WebView (ID: \(webview.getWebViewId())) cleaned")
    }
    
    /// Get pool status information
    public func getPoolStatus() -> (available: Int, used: Int) {
        let availableCount = webViews.filter { $0.poolState.canReuse }.count
        let inUseCount = webViews.filter { $0.poolState.isInUse }.count
        return (available: availableCount, used: inUseCount)
    }
    
    /// Get detailed pool status for debugging
    public func getDetailedPoolStatus() -> (available: Int, inUse: Int, reseting: Int, total: Int) {
        let availableCount = webViews.filter { $0.poolState.canReuse }.count
        let inUseCount = webViews.filter { $0.poolState.isInUse }.count
        let resetingCount = webViews.filter { $0.poolState == .reseting }.count
        return (available: availableCount, inUse: inUseCount, reseting: resetingCount, total: webViews.count)
    }
    
    // MARK: - Private Methods
    
    /// Preload WebViews
    private func preloadWebViews(appId: String) async {
        guard !appId.isEmpty else {
            DMPLogger.debug("🔧 WebViewPool: Skip preload without appId")
            return
        }

        let currentCount = webViews.filter { $0.appId == appId }.count
        let neededCount = max(0, minPoolSize - currentCount) // Ensure not negative
        
        DMPLogger.debug("🔧 WebViewPool: Current pool has \(currentCount) WebViews, need to preload \(neededCount)")
        
        // Create only when needed
        guard neededCount > 0 else {
            DMPLogger.debug("🔧 WebViewPool: WebView pool count meets minimum requirement, no need to preload")
            return
        }
        
        for i in 0..<neededCount {
            // Double check, ensure not exceed max pool size
            if webViews.count >= maxPoolSize {
                DMPLogger.debug("🔧 WebViewPool: Already reached max pool size, stop preloading")
                break
            }
            
            let webview = createNewWebView(delegate: nil, appName: "", appId: appId)
            webview.poolState = .available  // Preloaded WebViews should be available state
            webViews.append(webview)
            DMPLogger.debug("🔧 WebViewPool: Preload WebView \(i+1)/\(neededCount) (ID: \(webview.getWebViewId())), state: \(webview.poolState.description)")
        }
        
        DMPLogger.debug("🔧 WebViewPool: Preload completed, current pool has \(webViews.count) WebViews")
    }
    
    /// Preload more WebViews as needed
    private func preloadWebViewsIfNeeded(appId: String) async {
        guard !appId.isEmpty else {
            return
        }

        let currentCount = webViews.count
        let availableCount = webViews.filter { $0.poolState.canReuse && $0.appId == appId }.count
        
        // Only preload when available WebViews are less than minimum and total count is less than max
        if availableCount < minPoolSize && currentCount < maxPoolSize {
            let webview = createNewWebView(delegate: nil, appName: "", appId: appId)
            webview.poolState = .available  // Preloaded WebViews should be available state
            webViews.append(webview)
            DMPLogger.debug("🔧 WebViewPool: Preload WebView as needed (ID: \(webview.getWebViewId())), state: \(webview.poolState.description), current pool has \(webViews.count) WebViews")
        } else {
            DMPLogger.debug("🔧 WebViewPool: Pool status good, no need to preload - Available: \(availableCount), Total: \(currentCount), Min: \(minPoolSize), Max: \(maxPoolSize)")
        }
    }
    
    /// Create new WebView instance - must be called on main thread
    private func createNewWebView(delegate: DMPWebViewDelegate?, appName: String, appId: String) -> DMPWebview {
        assert(Thread.isMainThread, "WebView must be created on main thread")
        
        let webview = DMPWebview(
            delegate: delegate,
            appName: appName,
            appId: appId,
            processPool: Self.sharedProcessPool
        )
        return webview
    }
    
    /// Find available WebView
    private func findAvailableWebView(appId: String) -> DMPWebview? {
        // Select from WebViews in reusable state
        for webview in webViews where webview.poolState.canReuse {
            if webview.appId != appId {
                DMPLogger.debug("🟡 WebViewPool: WebView (ID: \(webview.getWebViewId())) appId mismatch, skipping")
                continue
            }

            // Check if WebView is in a state suitable for reuse
            if webview.getWebView().isLoading {
                DMPLogger.debug("🟡 WebViewPool: WebView (ID: \(webview.getWebViewId())) is still loading, skipping")
                continue
            }
            
            DMPLogger.debug("🟢 WebViewPool: Found available WebView (ID: \(webview.getWebViewId())) for reuse")
            return webview
        }
        
        DMPLogger.debug("🔍 WebViewPool: No available WebView found, will create new one")
        return nil
    }
    
    // MARK: - Notification Handlers
    
    @objc private func applicationDidEnterBackground() {
        // When app enters background, consider cleaning some WebViews to save memory
        DMPLogger.debug("🌙 WebViewPool: App entering background")
    }
    
    @objc private func applicationWillEnterForeground() {
        // When app is about to enter foreground, warm up WebView pool
        DMPLogger.debug("🌅 WebViewPool: App about to enter foreground, warming up pool")
        warmUp()
    }
    
    @objc private func applicationDidReceiveMemoryWarning() {
        // When receive memory warning, clean some WebViews
        DMPLogger.debug("⚠️ WebViewPool: Received memory warning, cleaning pool")
        
        // Only keep minimum number of available WebViews, remove others
        let availableWrappers = webViews.filter { $0.poolState.canReuse }
        let keepCount = min(minPoolSize, availableWrappers.count)
        
        if availableWrappers.count > keepCount {
            let wrappersToRemove = Array(availableWrappers.dropFirst(keepCount))
            for wrapper in wrappersToRemove {
                cleanupWebView(wrapper)
            }
            webViews.removeAll { wrapper in
                wrapper.poolState.canReuse && wrappersToRemove.contains { $0.getWebViewId() == wrapper.getWebViewId() }
            }
            DMPLogger.debug("⚠️ WebViewPool: Cleaned \(wrappersToRemove.count) available WebViews due to memory warning")
        }
    }
    
    @objc private func applicationWillTerminate() {
        // When app is about to terminate, clean all WebViews
        DMPLogger.debug("🌙 WebViewPool: App about to terminate, cleaning all WebViews")
        clearPool()
    }
    
    /// Get shared process pool
    internal func getSharedProcessPool() -> WKProcessPool {
        return Self.sharedProcessPool
    }
}

// MARK: - WebView Pool Extensions
extension DMPWebview {
    /// Prepare WebView for reuse
    @MainActor
    fileprivate func prepareForReuse() {
        DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) start preparing for reuse")
        
        getWebView().endEditing(true)
        getWebView().scrollView.endEditing(true)
        getWebView().stopLoading()
        
        let userContentController = getWebView().configuration.userContentController
        userContentController.removeAllUserScripts()
        DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) cleaned user scripts")
        
        let allHandlerNames = [
            // JS bridge handlers
            "invokeHandler", "publishHandler",
            // Log handlers
            "consoleLog", "consoleError", "consoleWarn", "consoleInfo",
            // Error handlers
            "jsError", "networkError", "resourceError"
        ]
        
        // First clean known standard handlers
        for handlerName in allHandlerNames {
            do {
                userContentController.removeScriptMessageHandler(forName: handlerName)
                DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) cleaned handler: \(handlerName)")
            } catch {
                // If handler doesn't exist, ignore error
                DMPLogger.debug("🟡 WebView (ID: \(getWebViewId())) handler \(handlerName) doesn't exist, skip cleanup")
            }
        }
        
        // Then clean custom handlers recorded in jsBridgeCallbacks
        for handlerName in jsBridgeCallbacks.keys {
            if !allHandlerNames.contains(handlerName) {
                do {
                    userContentController.removeScriptMessageHandler(forName: handlerName)
                    DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) cleaned custom handler: \(handlerName)")
                } catch {
                    DMPLogger.debug("🟡 WebView (ID: \(getWebViewId())) custom handler cleanup failed: \(handlerName), error: \(error)")
                }
            }
        }
        
        // Clear callback records
        jsBridgeCallbacks.removeAll()
        DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) cleaned all JS bridge callbacks")
        
        if logger != nil {
            DMPLogger.debug("🧽 WebView (ID: \(getWebViewId())) keep existing logger to avoid double cleanup")
        }
        
        // Use minimized HTML to ensure WebView status is normal, but avoid completely blank page that might cause issues
        getWebView().loadHTMLString("""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Preparing...</title>
        </head>
        <body>
            <script>
                // Clear potentially remaining global variables and event listeners
                if (typeof window.DiminaRenderBridge !== 'undefined') {
                    delete window.DiminaRenderBridge;
                }
                if (typeof window.DiminaServiceBridge !== 'undefined') {
                    delete window.DiminaServiceBridge;
                }
                
                // Remove all event listeners
                window.removeEventListener = function() {};
                document.removeEventListener = function() {};
                
            </script>
        </body>
        </html>
        """, baseURL: nil)
    }
    
    /// Reset WebView for new application
    @MainActor
    fileprivate func resetForReuse(appName: String, appId: String) {
        DMPLogger.debug("🔄 WebView (ID: \(getWebViewId())) start reset for app: \(appName)")
        
        // Update application information
        self.appName = appName
        self.appId = appId
        
        #if DEBUG
        if self.logger == nil {
            // Re-initialize logger (only when no logger exists)
            self.logger = DMPWebViewLogger(webView: self.getWebView(), webViewId: self.getWebViewId())
            DMPLogger.debug("🔄 WebView (ID: \(getWebViewId())) re-initialized logger")
        } else {
            DMPLogger.debug("🔄 WebView (ID: \(getWebViewId())) logger already exists, skip re-initialization")
            // Ensure existing logger is in good state, update webViewId
            self.logger?.updateWebViewId(self.getWebViewId())
            DMPLogger.debug("🔄 WebView (ID: \(getWebViewId())) updated logger webViewId")
        }
        #endif
        
        // Page path will be correctly set in DMPPageController.configWebView()
        self.query.removeAll()
        self.pagePath = ""
        DMPLogger.debug("🔄 WebView (ID: \(getWebViewId())) cleared query parameters and page path")
    }
} 
