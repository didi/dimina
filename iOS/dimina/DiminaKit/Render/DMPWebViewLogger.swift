//
//  DMPWebViewLogger.swift
//  dimina
//
//  Created by Lehem on 2025/4/22.
//

import Foundation
import WebKit

// Log level definition
public enum DMPLogLevel: String {
    case log = "LOG"
    case error = "ERROR"
    case warn = "WARN"
    case info = "INFO"
    case network = "NETWORK"
    case resource = "RESOURCE"
}

// WebView log delegate protocol
public protocol DMPWebViewLoggerDelegate: AnyObject {
    func webViewDidLog(webViewId: Int, level: DMPLogLevel, message: String)
}

// Provide default implementation for log methods
public extension DMPWebViewLoggerDelegate {
    func webViewDidLog(webViewId: Int, level: DMPLogLevel, message: String) {
        DMPLogger.debug("🔵 WebView[\(webViewId)] [\(level.rawValue)]: \(message)")
    }
}

public class DMPWebViewLogger: NSObject, WKScriptMessageHandler {
    private var webView: WKWebView
    private weak var delegate: DMPWebViewLoggerDelegate?
    private var webViewId: Int
    
    public init(webView: WKWebView, webViewId: Int, delegate: DMPWebViewLoggerDelegate? = nil) {
        self.webView = webView
        self.webViewId = webViewId
        self.delegate = delegate
        super.init()
        
        setupLogHandlers()
    }
    
    // Set up log handlers
    private func setupLogHandlers() {
        // Clean up possible old handlers first to avoid duplicate registration
        cleanupHandlers()
        
        // Register message handlers
        webView.configuration.userContentController.add(self, name: "consoleLog")
        webView.configuration.userContentController.add(self, name: "consoleError")
        webView.configuration.userContentController.add(self, name: "consoleWarn")
        webView.configuration.userContentController.add(self, name: "consoleInfo")
        webView.configuration.userContentController.add(self, name: "jsError")
        webView.configuration.userContentController.add(self, name: "networkError")
        webView.configuration.userContentController.add(self, name: "resourceError")
        
        DMPLogger.debug("🔧 WebViewLogger[\(webViewId)]: Log handlers registered")
        
        // Configure WebView security settings
        if #available(iOS 14.0, *) {
            // Use standard API for newer iOS versions
            let pagePrefs = WKWebpagePreferences()
            pagePrefs.allowsContentJavaScript = true
            webView.configuration.defaultWebpagePreferences = pagePrefs
            
            #if DEBUG
            if #available(iOS 16.4, *) {
                webView.isInspectable = true
            }
            #endif
            
            DMPLogger.debug("WebView configured with modern security mode")
        } else {
            // Note: No longer using private APIs as they may cause crashes
            DMPLogger.debug("WebView using default security settings")
        }
        
        // Inject log capture script
        injectLoggerScript()
        
        // Inject additional JavaScript after first navigation to handle cross-origin issues
        DMPLogger.debug("WebView log handler initialization completed")
    }
    
    // Safe method to clean up handlers
    private func cleanupHandlers() {
        let handlerNames = ["consoleLog", "consoleError", "consoleWarn", "consoleInfo", "jsError", "networkError", "resourceError"]
        
        for handlerName in handlerNames {
            do {
                webView.configuration.userContentController.removeScriptMessageHandler(forName: handlerName)
                DMPLogger.debug("🧹 WebViewLogger[\(webViewId)]: Cleaned up handler \(handlerName)")
            } catch {
                // Ignore error if handler doesn't exist
                DMPLogger.debug("🟡 WebViewLogger[\(webViewId)]: Handler \(handlerName) doesn't exist, skipping cleanup")
            }
        }
    }
    
    // Inject log capture script
    private func injectLoggerScript() {
        let script = WKUserScript(source: getLoggerScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true)
        webView.configuration.userContentController.addUserScript(script)
    }
    
    // Get log capture script
    private func getLoggerScript() -> String {
        return """
        // JavaScript to override console methods and capture errors
        (function() {
            // Solve "Script error." problem - mark all scripts as cross-origin
            try {
                // Try to add global handler to make dynamically added script elements have crossorigin attribute
                document.addEventListener('beforescriptexecute', function(e) {
                    if (e.target && !e.target.hasAttribute('crossorigin')) {
                        e.target.setAttribute('crossorigin', 'anonymous');
                        console.log('Added crossorigin to:', e.target.src || 'inline script');
                    }
                }, true);
            } catch(e) {
                // beforescriptexecute may not be supported by all browsers
                console.log('CrossOrigin auto-fix not supported in this browser');
            }
            
            // Monitor dynamically created script elements and add crossorigin
            const originalCreateElement = document.createElement;
            document.createElement = function(tagName) {
                const element = originalCreateElement.call(document, tagName);
                if (tagName.toLowerCase() === 'script') {
                    setTimeout(function() {
                        if (!element.hasAttribute('crossorigin')) {
                            element.setAttribute('crossorigin', 'anonymous');
                        }
                    }, 0);
                }
                return element;
            };
            
            var originalLog = console.log;
            var originalError = console.error;
            var originalWarn = console.warn;
            var originalInfo = console.info;
            
            // Add more context when constructing messages
            function enhanceLogMessage() {
                var args = Array.from(arguments);
                var callerInfo = '';
                
                try {
                    throw new Error('_getCallerInfo_');
                } catch(e) {
                    if (e.stack) {
                        var stackLines = e.stack.split('\\n');
                        if (stackLines.length > 2) {
                            // Skip current function and console wrapper function
                            callerInfo = stackLines[2].trim();
                            // Extract source file and line number
                            var matches = callerInfo.match(/at\\s+(.+)$/);
                            if (matches && matches[1]) {
                                callerInfo = '[' + matches[1] + '] ';
                            }
                        }
                    }
                }
                
                return callerInfo + args.map(String).join(' ');
            }
            
            console.log = function() {
                var message = enhanceLogMessage.apply(this, arguments);
                window.webkit.messageHandlers.consoleLog.postMessage(message);
                originalLog.apply(console, arguments);
            };
            
            console.error = function() {
                var message = enhanceLogMessage.apply(this, arguments);
                window.webkit.messageHandlers.consoleError.postMessage(message);
                originalError.apply(console, arguments);
            };
            
            console.warn = function() {
                var message = enhanceLogMessage.apply(this, arguments);
                window.webkit.messageHandlers.consoleWarn.postMessage(message);
                originalWarn.apply(console, arguments);
            };
            
            console.info = function() {
                var message = enhanceLogMessage.apply(this, arguments);
                window.webkit.messageHandlers.consoleInfo.postMessage(message);
                originalInfo.apply(console, arguments);
            };
            
            // Enable cross-origin detailed error information
            window.addEventListener('error', function(event) {
                // Add crossorigin attribute to get more cross-origin error information
                if (event.target && (event.target.tagName === 'SCRIPT' || event.target.tagName === 'LINK' || event.target.tagName === 'IMG')) {
                    event.target.crossOrigin = 'anonymous';
                }
                
                var errorInfo = {
                    message: event.message || 'Unknown error',
                    filename: event.filename || 'Unknown file',
                    lineno: event.lineno || 0,
                    colno: event.colno || 0,
                    error: event.error ? {
                        name: event.error.name,
                        message: event.error.message,
                        stack: event.error.stack
                    } : null,
                    timestamp: Date.now(),
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    // Get more error properties
                    type: event.type,
                    target: event.target ? {
                        tagName: event.target.tagName,
                        src: event.target.src || event.target.href,
                        id: event.target.id,
                        className: event.target.className
                    } : null
                };
                
                window.webkit.messageHandlers.jsError.postMessage(JSON.stringify(errorInfo));
            }, true);  // Use capture phase to get all events
            
            // Capture unhandled Promise rejections
            window.addEventListener('unhandledrejection', function(event) {
                var rejectionInfo = {
                    type: 'unhandledrejection',
                    reason: event.reason ? (typeof event.reason === 'object' ? JSON.stringify(event.reason) : String(event.reason)) : 'Unknown reason',
                    timestamp: Date.now(),
                    userAgent: navigator.userAgent,
                    url: window.location.href,
                    // Get more Rejection details
                    promise: event.promise ? 'Promise object' : 'No promise'
                };
                
                window.webkit.messageHandlers.jsError.postMessage(JSON.stringify(rejectionInfo));
            });
            
            // Monitor and catch ResourceError
            window.addEventListener('error', function(event) {
                if (event.target !== window) {
                    var resourceErrorInfo = {
                        type: 'resourceError',
                        element: event.target.tagName,
                        source: event.target.src || event.target.href || 'Unknown source',
                        timestamp: Date.now(),
                        userAgent: navigator.userAgent,
                        url: window.location.href
                    };
                    
                    window.webkit.messageHandlers.resourceError.postMessage(JSON.stringify(resourceErrorInfo));
                }
            }, true);
            
            // Log possible causes of "Script error" errors
            if (typeof window.onerror === 'undefined') {
                console.log('window.onerror is not defined, may cause script errors to not be captured properly');
            }
            
            // Log basic page info to help with debugging
            console.log('Page loaded:', window.location.href);
            console.log('User agent:', navigator.userAgent);
            
            // Listen for XHR request errors
            (function() {
                var originalXHROpen = XMLHttpRequest.prototype.open;
                var originalXHRSend = XMLHttpRequest.prototype.send;
                
                XMLHttpRequest.prototype.open = function(method, url) {
                    this._method = method;
                    this._url = url;
                    return originalXHROpen.apply(this, arguments);
                };
                
                XMLHttpRequest.prototype.send = function() {
                    var xhr = this;
                    
                    xhr.addEventListener('error', function() {
                        var networkErrorInfo = {
                            type: 'xhrError',
                            method: xhr._method,
                            url: xhr._url,
                            status: xhr.status,
                            statusText: xhr.statusText,
                            readyState: xhr.readyState,
                            timestamp: Date.now()
                        };
                        
                        window.webkit.messageHandlers.networkError.postMessage(JSON.stringify(networkErrorInfo));
                    });
                    
                    xhr.addEventListener('load', function() {
                        // Log requests completed but with abnormal status codes
                        if (xhr.status >= 400) {
                            var networkErrorInfo = {
                                type: 'xhrHttpError',
                                method: xhr._method,
                                url: xhr._url,
                                status: xhr.status,
                                statusText: xhr.statusText,
                                readyState: xhr.readyState,
                                timestamp: Date.now()
                            };
                            
                            window.webkit.messageHandlers.networkError.postMessage(JSON.stringify(networkErrorInfo));
                        }
                    });
                    
                    return originalXHRSend.apply(this, arguments);
                };
            })();
            
            // Listen for Fetch request errors
            if (window.fetch) {
                var originalFetch = window.fetch;
                window.fetch = function() {
                    return originalFetch.apply(this, arguments).catch(function(error) {
                        var fetchErrorInfo = {
                            type: 'fetchError',
                            url: arguments[0],
                            error: error.message,
                            timestamp: Date.now()
                        };
                        
                        window.webkit.messageHandlers.networkError.postMessage(JSON.stringify(fetchErrorInfo));
                        
                        throw error;
                    });
                };
            }
        })();
        """
    }
    
    // Set delegate
    public func setDelegate(_ delegate: DMPWebViewLoggerDelegate?) {
        self.delegate = delegate
    }
    
    // WKScriptMessageHandler implementation
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Handle logs based on message type
        switch message.name {
        case "consoleLog":
            logMessage(level: .log, message: String(describing: message.body))
        case "consoleError":
            logMessage(level: .error, message: String(describing: message.body))
        case "consoleWarn":
            logMessage(level: .warn, message: String(describing: message.body))
        case "consoleInfo":
            logMessage(level: .info, message: String(describing: message.body))
        case "jsError":
            handleJSError(message: String(describing: message.body))
        case "networkError":
            handleNetworkError(message: String(describing: message.body))
        case "resourceError":
            logMessage(level: .resource, message: String(describing: message.body))
        default:
            DMPLogger.debug("🟡 WebViewLogger[\(webViewId)]: Unknown message type: \(message.name)")
        }
    }
    
    // Handle JS errors
    private func handleJSError(message: String) {
        if let errorData = message.data(using: .utf8) {
            do {
                let errorJSON = try JSONSerialization.jsonObject(with: errorData, options: [])
                logMessage(level: .error, message: "JS Error: \(errorJSON)")
            } catch {
                logMessage(level: .error, message: "Unable to parse JS error: \(message)")
            }
        }
        
        // Construct more detailed error information
        var detailedMessage = "JavaScript Error Details:\n"
        detailedMessage += "Raw Message: \(message)\n"
        detailedMessage += "WebView ID: \(webViewId)\n"
        detailedMessage += "Timestamp: \(Date())\n"
        
        if let errorData = message.data(using: .utf8) {
            do {
                if let errorDict = try JSONSerialization.jsonObject(with: errorData, options: []) as? [String: Any] {
                    detailedMessage += "Error Message: \(errorDict["message"] ?? "Unknown")\n"
                    detailedMessage += "File: \(errorDict["filename"] ?? "Unknown")\n"
                    detailedMessage += "Line: \(errorDict["lineno"] ?? "Unknown")\n"
                    detailedMessage += "Column: \(errorDict["colno"] ?? "Unknown")\n"
                    
                    if let errorObj = errorDict["error"] as? [String: Any] {
                        detailedMessage += "Error Name: \(errorObj["name"] ?? "Unknown")\n"
                        detailedMessage += "Error Stack: \(errorObj["stack"] ?? "No stack trace")\n"
                    }
                    
                    // Add other possible error properties
                    if let target = errorDict["target"] as? [String: Any] {
                        detailedMessage += "Target Element: \(target["tagName"] ?? "Unknown")\n"
                        detailedMessage += "Target Source: \(target["src"] ?? "No source")\n"
                    }
                }
            } catch {
                detailedMessage += "Error parsing error data: \(error.localizedDescription)\n"
            }
        }
        
        logMessage(level: .error, message: detailedMessage)
    }
    
    // Handle network errors
    private func handleNetworkError(message: String) {
        if let errorData = message.data(using: .utf8) {
            do {
                let errorJSON = try JSONSerialization.jsonObject(with: errorData, options: [])
                logMessage(level: .network, message: "Network Error: \(errorJSON)")
            } catch {
                logMessage(level: .network, message: "Unable to parse network error: \(message)")
            }
        }
        
        var detailedMessage = "Network Error Details:\n"
        detailedMessage += "Raw Message: \(message)\n"
        detailedMessage += "WebView ID: \(webViewId)\n"
        detailedMessage += "Timestamp: \(Date())\n"
        
        logMessage(level: .network, message: detailedMessage)
    }
    
    // Log message
    private func logMessage(level: DMPLogLevel, message: String) {
        delegate?.webViewDidLog(webViewId: webViewId, level: level, message: message)
    }
    
    // Cleanup
    public func cleanup() {
        cleanupHandlers()
        DMPLogger.debug("🧹 WebViewLogger[\(webViewId)]: Cleanup completed")
    }
    
    deinit {
        cleanup()
    }
    
    // Update webViewId method
    internal func updateWebViewId(_ newWebViewId: Int) {
        self.webViewId = newWebViewId
        DMPLogger.debug("🔄 WebViewLogger: Updated webViewId to \(newWebViewId)")
    }
} 
