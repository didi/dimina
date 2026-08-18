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
        // 定义publish函数
        let publish: @convention(block) (Int, JSValue) -> Void = { webViewId, d in     
            DMPLogger.debug("🔵 DiminaServiceBridge.publish调用: webViewId=\(webViewId), data=\(d)")

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
