//
//  DMPEngineInvoke.swift
//  dimina
//
//  Created by Lehem on 2025/4/18.
//

import Foundation
import JavaScriptCore

public class DMPEngineInvoke {

    public static func registerInvoke(
        to context: JSContext,
        appResolver: @escaping () -> DMPApp? = { nil }
    ) {
        _ = DMPCanvasPacket.serializer(in: context)
        DMPCanvasPacket.installEncoder(in: context, appResolver: appResolver)
        let invoke: @convention(block) (JSValue) -> JSValue? = { [weak context] d in
            guard let context else { return nil }
            let type = d.forProperty("type").toString() ?? ""
            let target = d.forProperty("target").toString() ?? ""
            let rawBody = d.forProperty("body")!
            if type == "canvasNodeSync", target == "container" {
                do {
                    let packet = try DMPCanvasPacket.read(rawBody, using: DMPCanvasPacket.serializer(in: context))
                    let page = rawBody.forProperty("bridgeId")!.toInt32()
                    guard let app = appResolver() else { return JSValue(nullIn: context) }
                    if !packet.buffers.isEmpty {
                        let value = app.render?.canvasPacketSync(webViewId: Int(page), packet: packet) ?? ["error": "Canvas page unavailable"]
                        return DMPBinaryBridge.encode(value, in: context)
                    }
                    let value = app.render?.canvasNodeSync(webViewId: Int(page), json: packet.json) ?? ["error": "Canvas page unavailable"]
                    return DMPBinaryBridge.encode(value, in: context)
                } catch {
                    context.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: context)
                    return JSValue(undefinedIn: context)
                }
            }
            let body: DMPMap
            if type == "invokeAPI", target == "container",
               let name = rawBody.forProperty("name")?.toString(), name.hasPrefix("FileSystemManager.") {
                body = DMPMap([
                    "name": name,
                    "bridgeId": rawBody.forProperty("bridgeId")?.toObject() ?? 0,
                    "params": DMPBinaryBridge.decodeFileParams(rawBody.forProperty("params"))
                ])
            } else {
                body = DMPMap(rawBody.toDictionary() ?? [:])
            }

            guard let app = appResolver() else {
                return JSValue(nullIn: context)
            }
            let result = DMPChannelProxy.messageHandler(
                type: type,
                body: body,
                target: target,
                app: app
            )

            if let errorResult = result as? DMPErrorResult {
                context.exception = JSValue(newErrorFromMessage: errorResult.message, in: context)
                return JSValue(undefinedIn: context)
            } else if let syncResult = result as? DMPSyncResult {
                return DMPBridgeParam.from(rawValue: syncResult.value).getJSValue(context: context)
            } else {
                return JSValue(nullIn: context)
            }
        }
        
        let global = context.globalObject
        let bridge = global?.objectForKeyedSubscript("DiminaServiceBridge")
        
        bridge?.setObject(true, forKeyedSubscript: "canvasSyncSupported" as NSString)
        bridge?.setObject(true, forKeyedSubscript: "fileBinarySupported" as NSString)
        bridge?.setObject(invoke, forKeyedSubscript: "invoke" as NSString)
        
        DMPLogger.debug("registerInvoke 完成")
    }
}
