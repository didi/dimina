//
//  DMPExtModuleHandler.swift
//  dimina
//

import Foundation

/// 第三方扩展 bridge 模块的事件回调。
/// 框架在收到 native 结果后通过此对象将数据回传给 JS 层。
public class DMPExtCallback {
    private let onSuccessFn: (DMPMap) -> Void
    private let onFailFn: (DMPMap) -> Void

    init(
        onSuccess: @escaping (DMPMap) -> Void,
        onFail: @escaping (DMPMap) -> Void
    ) {
        self.onSuccessFn = onSuccess
        self.onFailFn = onFail
    }

    /// 调用成功回调，将 result 传回 JS 层
    public func onSuccess(_ result: DMPMap = DMPMap()) {
        onSuccessFn(result)
    }

    /// 调用失败回调，将 error 传回 JS 层
    public func onFail(_ error: DMPMap) {
        onFailFn(error)
    }
}

/// 第三方扩展 bridge 模块的处理器协议。
///
/// 宿主通过 `DMPAppManager.sharedInstance().registerExtModule(_:handler:)` 注册实现，
/// 框架在收到 `extBridge` / `extOnBridge` 调用时触发 `handle(event:data:callback:)`。
///
/// - 一次性调用（extBridge）：执行后调用 `callback.onSuccess / onFail`，返回 `nil`。
/// - 持续订阅（extOnBridge）：启动监听，返回取消函数；取消函数会在 `extOffBridge`
///   或小程序销毁时自动被调用。
///
/// 示例（Swift）：
/// ```swift
/// DMPAppManager.sharedInstance().registerExtModule("MyModule") { event, data, callback in
///     switch event {
///     case "getUserInfo":
///         callback.onSuccess(DMPMap(["name": "Alice"]))
///         return nil
///     case "onDataChange":
///         let token = NotificationCenter.default.addObserver(
///             forName: .myDataChanged, object: nil, queue: .main
///         ) { _ in callback.onSuccess(DMPMap(["ts": Date().timeIntervalSince1970])) }
///         return { NotificationCenter.default.removeObserver(token) }
///     default:
///         callback.onFail(DMPMap(["errMsg": "unknown event: \(event)"]))
///         return nil
///     }
/// }
/// ```
public typealias DMPExtModuleHandler = (
    _ event: String,
    _ data: DMPMap,
    _ callback: DMPExtCallback
) -> (() -> Void)?
