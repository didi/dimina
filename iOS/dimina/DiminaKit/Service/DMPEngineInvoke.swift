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
        let invoke: @convention(block) (JSValue) -> JSValue? = { d in
            let msg = d.toDictionary()
            let type = msg!["type"] as! String
            let body = DMPMap.fromDict(dict:  msg!["body"] as! [String : Any])
            let target = msg!["target"] as! String

            guard let app = appResolver() else {
                return JSValue(nullIn: context)
            }
            let result = DMPChannelProxy.messageHandler(
                type: type,
                body: body,
                target: target,
                app: app
            )

            if let syncResult = result as? DMPSyncResult {
                return DMPBridgeParam.from(rawValue: syncResult.value).getJSValue(context: context)
            } else {
                return JSValue(nullIn: context)
            }
        }
        
        let global = context.globalObject
        let bridge = global?.objectForKeyedSubscript("DiminaServiceBridge")
        
        bridge?.setObject(invoke, forKeyedSubscript: "invoke" as NSString)
        
        DMPLogger.debug("registerInvoke 完成")
    }
}
