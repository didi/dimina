//
//  DMPChannelProxy.swift
//  dimina
//
//  Created by Lehem on 2025/4/22.
//

import Foundation

class DMPChannelProxy {
    public static func messageHandler(
        type: String, body: DMPMap,
        target: String, app: DMPApp
    ) -> Any {
        print("🔴 messageHandler:type=\(type) target=\(target) body=\(body.toJsonString())")

        let webViewId: Int = body.get("bridgeId") as? Int ?? 0
        let webview = app.render?.getWebView(byId: webViewId)
        if webViewId != 0 && webview != nil {
            body.set("pagePath", webview!.getPagePath())
            body.set("query", webview!.getQuery())
        }

        if target == "service" {
            let transMsg = DMPMap([
                "type": type,
                "body": body.toDictionary(),
            ])

            if type == "serviceResourceLoaded" || type == "renderResourceLoaded" {
                let resourceType: ResourceLoadType =
                    type == "serviceResourceLoaded" ? .serviceLoaded : .renderLoaded
                app.container!.hasLoadResource(webViewId: webViewId, type: resourceType)

                if app.container!.isResourceLoaded(webViewId: webViewId) {
                    body.set("scene", DMPScene.fromMainEntry.rawValue)

                    transMsg.set("type", "resourceLoaded")

                    Task { @MainActor in
                        await app.service?.postMessage(data: transMsg)
                    }
                    print(
                        "send \(resourceType == .serviceLoaded ? "service" : "render") resourceLoaded"
                    )
                    return DMPMap()
                } else {
                    print("isResourceLoaded false")
                    return DMPMap()
                }
            } else {
                print("🔴🔴🔴 DMPChannelProxy.postMessage")
                Task { @MainActor in
                    await app.service?.postMessage(data: transMsg)
                }
            }
        } else if target == "container" {
            if type == "invokeAPI" {
                guard let name = body.get("name") as? String, !name.isEmpty else {
                    print("参数格式错误：name为空")
                    return DMPMap()
                }

                let param: DMPBridgeParam = DMPBridgeParam(value: body.get("params") as Any)
                return app.container!.callBridgeMethod(methodName: name, webViewId: webViewId, param: param, app: app)
            } else if type == "domReady" {
                app.container?.isNavigating = false
                if let webview = webview {
                    webview.hideLoading()
                }
                print("domReady")
            }
        } else if target == "webview" {
            // 处理 来自h5 jssdk 的消息
            // if type == "invokeAPI" {
            //     let name: String = body.get("name") as? String ?? ""

            //     if let params = body.get("params"),
            //        (params is String || params is Int || params is Bool || params is [Any]) {
            //         return app.container?.callBridgeMethods(methodName: name, webViewId: webViewId, params: params, app: app)
            //     } else {
            //         print("params is not String, Int, Bool, [Any]")
            //     }
            // }
        }

        return DMPMap()
    }

    static func containerToService(msg: DMPMap, app: DMPApp?) {
        print("🔴 DMPChannelProxy.containerToService: \(msg.toJsonString()) \(app)")
        app?.service?.fromContainer(data: msg)
    }

    static func containerToRender(msg: DMPMap, app: DMPApp?, webViewId: Int) {
        print("🔴 DMPChannelProxy.containerToRender: \(msg.toJsonString()) \(app) \(webViewId)")
        app?.render?.fromContainer(data: msg, webViewId: webViewId)
    }

    static func serviceToRender(msg: String, webViewId: Int, app: DMPApp?) {
        print("🔴 DMPChannelProxy.serviceToRender: \(msg) \(webViewId) \(app)")

        // Canvas message interception — execute natively instead of forwarding to WebView
        if CanvasManager.shouldIntercept(msg) {
            DispatchQueue.main.async {
                CanvasManager.shared.handleMessage(msg, app: app)
            }
            return
        }

        app?.render?.fromService(msg: msg, webViewId: webViewId)
    }

    static func renderToService(msg: String, app: DMPApp?) async {
        print("🔴 DMPChannelProxy.renderToService: \(msg) \(app)")
        await app?.service?.fromRender(data: msg)
    }
}
