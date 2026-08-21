//
//  DMPPageLifecycle.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

public class DMPPageLifecycle {
    var app: DMPApp
    
    init(app: DMPApp) {
        self.app = app
    }
        
    public func onShow(webviewId: Int) {
        DMPChannelProxy.containerToService(msg: pageShowMessage(webviewId: webviewId), app: app)
    }

    /// Used when pageShow must be ordered after an orientation geometry snapshot in the same task.
    public func onShowAsync(webviewId: Int) async {
        await app.service?.postMessage(data: pageShowMessage(webviewId: webviewId))
    }

    private func pageShowMessage(webviewId: Int) -> DMPMap {
        DMPMap([
            "type": "pageShow",
            "body": [
                "bridgeId": webviewId
            ]
        ])
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
