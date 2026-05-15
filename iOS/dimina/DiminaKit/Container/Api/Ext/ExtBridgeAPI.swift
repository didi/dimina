//
//  ExtBridgeAPI.swift
//  dimina
//

import Foundation

/// 处理 service 侧 `extBridge` 一次性调用。
///
/// service 侧调用链：
///   `extBridge({ event, module, data, success, fail, complete })`
///   → `invokeAPI(name=event, params={ module, data, success, fail, complete })`
///   → container: `methodName=event`, `param.module=模块名`
///
/// 本类不通过 `@BridgeMethod` 注册固定方法名，
/// 而是由 `DMPContainer.callBridgeMethod` 在未命中已知 API 时，
/// 检测 `param` 中存在 `"module"` 字段后调用 `handleExtBridge`。
public class ExtBridgeAPI: DMPContainerApi {

    /// 处理一次性 extBridge 调用。
    /// - Parameters:
    ///   - methodName: 即 service 侧 event 值（如 `"getUserInfo"`）
    ///   - param:      桥参数，包含 `module`、`data`、`success`、`fail`、`complete`
    ///   - env:        当前 bridge 上下文
    ///   - callback:   已由 DMPContainer 组装好的 triggerCallback 分发函数
    ///   - extModules: 宿主注册的模块表
    public static func handle(
        methodName: String,
        param: DMPBridgeParam,
        env: DMPBridgeEnv,
        callback: DMPBridgeCallback?,
        extModules: [String: DMPExtModuleHandler]
    ) {
        let map = param.getMap()
        let module = map["module"] as? String ?? ""
        let data = DMPMap(map["data"] as? [String: Any] ?? [:])

        guard let handler = extModules[module] else {
            let errMap = DMPMap(["errMsg": "extBridge:fail module \"\(module)\" not registered"])
            callback?(errMap, .fail)
            callback?(DMPMap(), .complete)
            return
        }

        let extCallback = DMPExtCallback(
            onSuccess: { result in
                result.set("errMsg", "\(methodName):ok")
                callback?(result, .success)
                callback?(DMPMap(), .complete)
            },
            onFail: { error in
                if error["errMsg"] == nil {
                    error.set("errMsg", "\(methodName):fail")
                }
                callback?(error, .fail)
                callback?(DMPMap(), .complete)
            }
        )

        _ = handler(methodName, data, extCallback)
    }
}
