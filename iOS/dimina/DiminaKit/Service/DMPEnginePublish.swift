//
//  DMPEnginePublish.swift
//  dimina
//
//  Created by Lehem on 2025/4/18.
//

import Foundation
import JavaScriptCore

public class DMPEnginePublish {

    public static func registerPublish(
        to context: JSContext,
        appResolver: @escaping () -> DMPApp? = { nil }
    ) {
        _ = DMPCanvasPacket.serializer(in: context)
        // 定义publish函数
        let publish: @convention(block) (Int, JSValue) -> Void = { [weak context] webViewId, d in
            guard let context else { return }
            DMPLogger.debug("🔵 DiminaServiceBridge.publish调用: webViewId=\(webViewId), data=\(d)")

            if d.forProperty("target")?.toString() == "render", d.forProperty("body")?.forProperty("name")?.toString().hasPrefix("canvasNode") == true {
                do {
                    let packet = try DMPCanvasPacket.read(d, using: DMPCanvasPacket.serializer(in: context))
                    if let render = appResolver()?.render,
                       !packet.buffers.isEmpty || render.getWebView(byId: webViewId)?.canvasBinaryReady == true {
                        try render.publishCanvasPacket(webViewId: webViewId, packet: packet)
                        return
                    }
                    if !packet.buffers.isEmpty { throw NSError(domain: "Canvas binary page is unavailable", code: 1) }
                } catch {
                    context.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: context)
                    return
                }
            }
            if let dict = d.toDictionary() {
                if let jsonString = DMPUtil.jsonEncode(from: dict) {
                    let app = appResolver()
                    DMPChannelProxy.serviceToRender(msg: jsonString, webViewId: webViewId, app: app);
                }
            }
        }
        
        let global = context.globalObject
        let bridge = global?.objectForKeyedSubscript("DiminaServiceBridge")
        
        // 设置publish方法
        bridge?.setObject(publish, forKeyedSubscript: "publish" as NSString)
        
        DMPLogger.debug("registerPublish 完成")
    }
} 
