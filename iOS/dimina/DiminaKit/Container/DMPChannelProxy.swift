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
        DMPLogger.debug("🔴 messageHandler:type=\(type) target=\(target) body=\(body.toJsonString())")

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
                guard let container = app.container else {
                    DMPLogger.debug("resourceLoaded ignored: runtime container is unavailable")
                    return DMPMap()
                }
                let resourceType: ResourceLoadType =
                    type == "serviceResourceLoaded" ? .serviceLoaded : .renderLoaded
                container.hasLoadResource(webViewId: webViewId, type: resourceType)

                if container.isResourceLoaded(webViewId: webViewId) {
                    let launchConfig = app.getCurrentLaunchConfig()
                    body.set("scene", launchConfig?.scene ?? DMPScene.fromMainEntry.rawValue)
                    if let referrerInfo = launchConfig?.referrerInfo {
                        body.set("referrerInfo", referrerInfo)
                    }

                    transMsg.set("type", "resourceLoaded")
                    transMsg.set("body", body.toDictionary())

                    Task { @MainActor in
                        await app.service?.postMessage(data: transMsg)
                    }
                    DMPLogger.debug(
                        "send \(resourceType == .serviceLoaded ? "service" : "render") resourceLoaded"
                    )
                    return DMPMap()
                } else {
                    DMPLogger.debug("isResourceLoaded false")
                    return DMPMap()
                }
            } else {
                DMPLogger.debug("🔴🔴🔴 DMPChannelProxy.postMessage")
                Task { @MainActor in
                    await app.service?.postMessage(data: transMsg)
                }
            }
        } else if target == "container" {
            if type == "invokeAPI" {
                guard let name = body.get("name") as? String, !name.isEmpty else {
                    DMPLogger.debug("参数格式错误：name为空")
                    return DMPMap()
                }
                guard let container = app.container else {
                    DMPLogger.debug("invokeAPI ignored: runtime container is unavailable")
                    return DMPMap()
                }

                let param: DMPBridgeParam = DMPBridgeParam(value: body.get("params") as Any)
                return container.callBridgeMethod(
                    methodName: name,
                    webViewId: webViewId,
                    param: param,
                    app: app
                )
            } else if type == "domReady" {
                app.container?.isNavigating = false
                if let webview = webview {
                    webview.hideLoading()
                }
                DMPLogger.debug("domReady")
            }
        } else if target == "webview" {
            // 处理 来自h5 jssdk 的消息
            // if type == "invokeAPI" {
            //     let name: String = body.get("name") as? String ?? ""

            //     if let params = body.get("params"),
            //        (params is String || params is Int || params is Bool || params is [Any]) {
            //         return app.container?.callBridgeMethods(methodName: name, webViewId: webViewId, params: params, app: app)
            //     } else {
            //         DMPLogger.debug("params is not String, Int, Bool, [Any]")
            //     }
            // }
        }

        return DMPMap()
    }

    static func containerToService(msg: DMPMap, app: DMPApp?) {
        DMPLogger.debug("🔴 DMPChannelProxy.containerToService: \(msg.toJsonString()) \(app)")
        app?.service?.fromContainer(data: msg)
    }

    static func containerToRender(msg: DMPMap, app: DMPApp?, webViewId: Int) {
        DMPLogger.debug("🔴 DMPChannelProxy.containerToRender: \(msg.toJsonString()) \(app) \(webViewId)")
        app?.render?.fromContainer(data: msg, webViewId: webViewId)
    }

    static func serviceToRender(msg: String, webViewId: Int, app: DMPApp?) {
        DMPLogger.debug("🔴 DMPChannelProxy.serviceToRender: \(msg) \(webViewId) \(app)")
        app?.render?.fromService(msg: msg, webViewId: webViewId)
    }

    static func renderToService(msg: String, app: DMPApp?) {
        DMPLogger.debug("🔴 DMPChannelProxy.renderToService: \(msg) \(app)")
        app?.service?.fromRender(data: msg)
    }
}
