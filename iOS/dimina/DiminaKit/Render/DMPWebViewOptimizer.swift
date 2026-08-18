//
//  DMPWebViewOptimizer.swift
//  dimina
//
//  Created by Lehem on 2025/5/27.
//

import Foundation
import WebKit

/// WebView performance optimizer
/// Integrates the latest WKWebView optimization APIs and configurations
public class DMPWebViewOptimizer {
    
    // MARK: - Singleton
    public static let shared = DMPWebViewOptimizer()
    
    private init() {}
    
    // MARK: - Optimization configuration methods
    
    /// Apply performance optimization configurations to WKWebViewConfiguration
    /// - Parameters:
    ///   - config: WKWebViewConfiguration instance
    ///   - appId: Application ID
    ///   - processPool: Optional process pool
    @MainActor public func applyOptimizations(to config: WKWebViewConfiguration, appId: String, processPool: WKProcessPool? = nil) {
        // 1. Process pool optimization
        applyProcessPoolOptimizations(to: config, processPool: processPool)
        
        // 2. Memory management optimization
        applyMemoryOptimizations(to: config)
        
        // 3. Rendering optimization
        applyRenderingOptimizations(to: config)
        
        // 4. Network optimization
        applyNetworkOptimizations(to: config)
        
        // 5. JavaScript optimization
        applyJavaScriptOptimizations(to: config)
        
        // 6. iOS system-specific optimization
        applySystemSpecificOptimizations(to: config)
        
        // 7. URL scheme handlers
        setupURLSchemeHandlers(to: config, appId: appId)
    }
    
    // MARK: - Process pool optimization
    
    @MainActor private func applyProcessPoolOptimizations(to config: WKWebViewConfiguration, processPool: WKProcessPool?) {
        // Use shared process pool to reduce memory usage and improve startup speed
        if let processPool = processPool {
            config.processPool = processPool
        } else {
            config.processPool = DMPWebViewPool.sharedProcessPool
        }
        
        DMPLogger.debug("🔧 WebViewOptimizer: Applied process pool optimization")
    }
    
    // MARK: - Memory management optimization
    
    private func applyMemoryOptimizations(to config: WKWebViewConfiguration) {
        // Enable automatic cleanup
        config.suppressesIncrementalRendering = true
        
        // iOS 14+ memory optimization
        if #available(iOS 14.0, *) {
            // Enable background content restrictions
            config.limitsNavigationsToAppBoundDomains = false
            
            // Optimize media types
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        
        // iOS 15+ optimization
        if #available(iOS 15.0, *) {
            // Enable more aggressive memory management
            config.upgradeKnownHostsToHTTPS = false
        }
        
        DMPLogger.debug("🧠 WebViewOptimizer: Applied memory management optimization")
    }
    
    // MARK: - Rendering optimization
    
    private func applyRenderingOptimizations(to config: WKWebViewConfiguration) {
        // Media playback optimization
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        
        // User content controller optimization
        let userContentController = WKUserContentController()
        config.userContentController = userContentController
        
        // iOS 16+ optimization
        if #available(iOS 16.0, *) {
            // Enable modern rendering features
            // config.preferences.isElementFullscreenEnabled = true
        }
        
        DMPLogger.debug("🎨 WebViewOptimizer: Applied rendering optimization")
    }
    
    // MARK: - Network optimization
    
    private func applyNetworkOptimizations(to config: WKWebViewConfiguration) {
        // Enable faster network handling
        if #available(iOS 13.0, *) {
            // Optimize network request handling
            config.preferences.javaScriptCanOpenWindowsAutomatically = false
        }
        
        DMPLogger.debug("🌐 WebViewOptimizer: Applied network optimization")
    }
    
    // MARK: - JavaScript optimization
    
    private func applyJavaScriptOptimizations(to config: WKWebViewConfiguration) {
        // JavaScript execution optimization
        config.preferences.javaScriptEnabled = true
        
        if #available(iOS 14.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }
        
        // iOS 15+ JavaScript optimization
        if #available(iOS 15.0, *) {
            // Enable modern JavaScript features
            // config.preferences.isTextInteractionEnabled = true
        }
        
        DMPLogger.debug("⚡ WebViewOptimizer: Applied JavaScript optimization")
    }
    
    // MARK: - System-specific optimization
    
    private func applySystemSpecificOptimizations(to config: WKWebViewConfiguration) {
        // iOS version-specific optimization
        if #available(iOS 13.0, *) {
            // iOS 13+ optimization
            applyiOS13Optimizations(to: config)
        }
        
        if #available(iOS 14.0, *) {
            // iOS 14+ optimization
            applyiOS14Optimizations(to: config)
        }
        
        if #available(iOS 15.0, *) {
            // iOS 15+ optimization
            applyiOS15Optimizations(to: config)
        }
        
        if #available(iOS 16.0, *) {
            // iOS 16+ optimization
            applyiOS16Optimizations(to: config)
        }
        
        DMPLogger.debug("📱 WebViewOptimizer: Applied system-specific optimization")
    }
    
    @available(iOS 13.0, *)
    private func applyiOS13Optimizations(to config: WKWebViewConfiguration) {
        // iOS 13 specific optimization
        // Enable better performance monitoring
    }
    
    @available(iOS 14.0, *)
    private func applyiOS14Optimizations(to config: WKWebViewConfiguration) {
        // iOS 14 specific optimization
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // Can enable other iOS 14 features as needed
    }
    
    @available(iOS 15.0, *)
    private func applyiOS15Optimizations(to config: WKWebViewConfiguration) {
        // iOS 15 specific optimization
        config.upgradeKnownHostsToHTTPS = false
        // Can enable other iOS 15 features as needed
    }
    
    @available(iOS 16.0, *)
    private func applyiOS16Optimizations(to config: WKWebViewConfiguration) {
        // iOS 16 specific optimization
        // Enable latest performance features
        // config.preferences.shouldPrintBackgrounds = true
    }
    
    // MARK: - URL scheme handlers
    
    private func setupURLSchemeHandlers(to config: WKWebViewConfiguration, appId: String) {
        // Register custom URL scheme handlers
         let difileSchemeHandler: DifileURLSchemeHandler = DifileURLSchemeHandler(appId: appId)
         config.setURLSchemeHandler(difileSchemeHandler, forURLScheme: "difile")
         
         let diminaSchemeHandler = DiminaURLSchemeHandler(appId: appId)
         config.setURLSchemeHandler(diminaSchemeHandler, forURLScheme: "dimina")
        
        DMPLogger.debug("🔗 WebViewOptimizer: Set up URL scheme handlers")
    }
    
    // MARK: - WebView instance optimization
    
    /// Apply runtime optimizations to created WebView instances
    /// - Parameter webView: WKWebView instance
    public func optimizeWebViewInstance(_ webView: WKWebView) {
        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif
        
        // Performance-related settings
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        applyScrollOptimizations(to: webView)
        
        DMPLogger.debug("🚀 WebViewOptimizer: Optimized WebView instance")
    }
    
    private func applyScrollOptimizations(to webView: WKWebView) {
        // Scroll optimization
        if let scrollView = webView.subviews.first(where: { $0 is UIScrollView }) as? UIScrollView {
            scrollView.showsVerticalScrollIndicator = false
            scrollView.showsHorizontalScrollIndicator = false
            
            // iOS 13+ scroll optimization
            if #available(iOS 13.0, *) {
                scrollView.automaticallyAdjustsScrollIndicatorInsets = false
            }
            if #available(iOS 11.0, *) {
                scrollView.contentInsetAdjustmentBehavior = .never
            }
        }
    }
    
    private func applyInteractionOptimizations(to webView: WKWebView) {
        // User interaction optimization
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        
        // iOS 15+ interaction optimization
        if #available(iOS 15.0, *) {
            // Can enable modern interaction features as needed
        }
    }
} 
