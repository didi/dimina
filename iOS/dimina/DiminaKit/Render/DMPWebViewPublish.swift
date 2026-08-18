//
//  DMPWebViewPublish.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

import Foundation
import WebKit

public class DMPWebViewPublish {
    // 保存webView实例的引用
    private weak var render: DMPRender?
        
    public init(render: DMPRender) {
        self.render = render
    }
    
    public func registerPublishHandler(webview: DMPWebview) {
        webview.registerJSHandler(handlerName: "publishHandler") { [weak self] data in
            guard let self = self else { return }
            
            DMPLogger.debug("🔴 DiminaRenderBridge.publish: \(data)")
            
            if let message = data as? String {   
                Task {
                    await DMPChannelProxy.renderToService(msg: message, app: self.render?.getApp())
                }
            } else {
                DMPLogger.debug("publish消息格式不正确，期望字符串类型: \(data)")
            }
        }
    }
    
    public func injectPublishJavaScript(webview: DMPWebview) {
        let publishScript = WKUserScript(source: """
        (function() {
            window.DiminaRenderBridge = window.DiminaRenderBridge || {};
            window.DiminaRenderBridge.publish = function(msg) {
                if (typeof msg !== 'string') {
                    console.error('DiminaRenderBridge.publish: 消息必须是字符串类型', msg);
                    return;
                }

                if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.publishHandler) {
                    console.error('DiminaRenderBridge.publish: native handler not ready');
                    return;
                }

                window.webkit.messageHandlers.publishHandler.postMessage(msg);
            };
        })();
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)

        webview.getWebView().configuration.userContentController.addUserScript(publishScript)
    }    
} 
