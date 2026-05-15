//
//  ScrollAPI.swift
//  dimina
//
//  Created by DosLin on 2025/5/10.
//

import Foundation
import UIKit

/**
 * UI - Scroll API
 */
public class ScrollAPI: DMPContainerApi {
    
    // API method names
    private static let PAGE_SCROLL_TO = "pageScrollTo"
    
    // Page scroll to
    @BridgeMethod(PAGE_SCROLL_TO)
    var pageScrollTo: DMPBridgeMethodHandler = { param, env, callback in
        let param = param.getMap()
        let scrollTop = param["scrollTop"] as? CGFloat ?? 0
        let duration = param["duration"] as? CGFloat ?? 300
        
        guard let app = DMPAppManager.sharedInstance().getApp(appIndex: env.appIndex) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "invalid app")
            return DMPAsyncResult()
        }

        guard let render = app.render,
              let webview = render.getWebView(byId: env.webViewId) else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "invalid render or webview")
            return DMPAsyncResult()
        }
        
        let wkWebView = webview.getWebView()

        Task { @MainActor in
            UIView.animate(withDuration: duration / 1000) {
                wkWebView.scrollView.setContentOffset(CGPoint(x: 0, y: scrollTop), animated: false)
            } completion: { finished in
                DMPContainerApi.invokeSuccess(callback: callback, param: nil)
            }
        }
        
        return DMPAsyncResult()
    }
}
