//
//  DMPEngineInvoke.swift
//  dimina
//
//  Created by Lehem on 2025/4/18.
//

import Foundation
import JavaScriptCore

public class DMPEngineInvoke {
    
    private static var appResolver: (() -> DMPApp?)?
    
    public static func registerAppResolver(_ resolver: @escaping () -> DMPApp?) {
        appResolver = resolver
    }
    
    public static func registerInvoke(to context: JSContext) {
        let invoke: @convention(block) (JSValue) -> JSValue? = { d in
            let msg = d.toDictionary()
            let type = msg!["type"] as! String
            let body = DMPMap.fromDict(dict:  msg!["body"] as! [String : Any])
            let target = msg!["target"] as! String

            let app = appResolver?()
            let result = DMPChannelProxy.messageHandler(type: type, body: body, target: target, app: app!)

            if let syncResult = result as? DMPSyncResult {
                return DMPBridgeParam.from(rawValue: syncResult.value).getJSValue(context: context)
            } else {
                return JSValue(nullIn: context)
            }
        }
        
        let global = context.globalObject
        let bridge = global?.objectForKeyedSubscript("DiminaServiceBridge")
        
        bridge?.setObject(invoke, forKeyedSubscript: "invoke" as NSString)
        
        print("registerInvoke 完成")
    }
}
