//
//  DMPPageLifecycle.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

/// 拆掉页面的两种原因。微信里 unloadPage 只有路由事件（reLaunch/redirectTo/
/// navigateBack/switchTab）会触发，退出小程序走的是 onAppEnterBackground，
/// 只派发 App.onHide，页面不收 onUnload。
public enum DMPPageStateTeardown {
    /// 路由卸载页面：页面确实被路由销毁。
    case routing
    /// 退出小程序或整体换运行时：运行时随后整体销毁，页面不派发 onUnload。
    case exit
}

public class DMPPageLifecycle {
    var app: DMPApp
    
    init(app: DMPApp) {
        self.app = app
    }
        
    public func onShow(webviewId: Int) {
        let msg = DMPMap([
            "type": "pageShow",
            "body": [
                "bridgeId": webviewId
            ]
        ])
        DMPChannelProxy.containerToService(msg: msg, app: app)
    }
    
    public func onHide(webviewId: Int) {
        if webviewId <= 0 {
            return
        }
        
        let msg = DMPMap([
            "type": "pageHide",
            "body": [
                "bridgeId": webviewId
            ]
        ])
        DMPChannelProxy.containerToService(msg: msg, app: app)
    }
    
    public func onUnload(webviewId: Int) {
        let msg = DMPMap([
            "type": "pageUnload",
            "body": [
                "bridgeId": webviewId
            ]
        ])
        DMPChannelProxy.containerToService(msg: msg, app: app)
    }
    
}
