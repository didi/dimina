//
//  DMPContainerApi.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

import Foundation

// 定义回调类型枚举
@objc public enum DMPBridgeCallbackType: Int {
    case success
    case fail
    case complete
}

public class DMPBridgeEnv {
    let appIndex: Int
    let appId: String
    let webViewId: Int

    init(appIndex: Int, appId: String, webViewId: Int) {
        self.appIndex = appIndex
        self.appId = appId
        self.webViewId = webViewId
    }
}

// 定义回调闭包类型
public typealias DMPBridgeCallback = (_ args: DMPMap, _ cbType: DMPBridgeCallbackType) -> Void

// 定义桥接方法处理程序类型
public typealias DMPBridgeMethodHandler = (_ param: DMPBridgeParam, _ env: DMPBridgeEnv, _ callback: DMPBridgeCallback?) -> DMPAPIResult

// 自定义属性
@propertyWrapper
struct BridgeMethod {
    let name: String
    var wrappedValue: DMPBridgeMethodHandler
    
    init(_ name: String) {
        self.name = name
        self.wrappedValue = { _, _, _ in DMPNoneResult() }
        DMPContainerApi.registerMethod(name: name)
    }
    
    init(wrappedValue: @escaping DMPBridgeMethodHandler, _ name: String) {
        self.name = name
        self.wrappedValue = wrappedValue
        DMPContainerApi.registerMethod(name: name, handler: wrappedValue)
    }
}

@objc public protocol BridgeMethodProtocol {}

public class DMPContainerApi: NSObject {
    private weak var app: DMPApp?
    static var bridgeHandlerMap: [String: DMPBridgeMethodHandler] = [:]
    
    public init(app: DMPApp? = nil) {
        self.app = app
        super.init()
    }
    
    public static func create(app: DMPApp? = nil) -> DMPContainerApi {
        // 创建并注册所有 API 实例
        _ = RouteAPI(app: app)
        _ = BaseAPI(app: app)
        _ = SystemAPI(app: app)
        _ = UpdateAPI(app: app)
        _ = NetworkAPI(app: app)
        _ = LocalNetworkAPI(app: app)
        _ = WebSocketAPI(app: app)
        _ = StorageAPI(app: app)
        _ = FileAPI(app: app)
        _ = ClipboardAPI(app: app)
        _ = ContactAPI(app: app)
        _ = KeyboardAPI(app: app)
        _ = NetworkTypeAPI(app: app)
        _ = PhoneAPI(app: app)
        _ = VibrateAPI(app: app)
        _ = ScanAPI(app: app)
        _ = BluetoothAPI(app: app)
        _ = ImageAPI(app: app)
        _ = MessageFileAPI(app: app)
        _ = VideoAPI(app: app)
        _ = InteractionAPI(app: app)
        _ = MenuAPI(app: app)
        _ = NavigationBarAPI(app: app)
        _ = ScrollAPI(app: app)
        _ = TabBarAPI(app: app)
        _ = NativeComponentAPI(app: app)
        
        // 返回一个基础 API 实例
        return DMPContainerApi(app: app)
    }
    
    public func getApp() -> DMPApp? {
        return app
    }
    
    // 统一注册方法
    public static func registerMethod(name: String, handler: DMPBridgeMethodHandler? = nil) {
        if let handler = handler {
            bridgeHandlerMap[name] = handler
        }
    }
    
    public static func getHandler(for methodName: String) -> DMPBridgeMethodHandler? {
        return bridgeHandlerMap[methodName]
    }
    
    public static func getAllRegisteredMethods() -> [String] {
        return Array(bridgeHandlerMap.keys)
    }
    
    public func invokeBridgeMethod(name: String, data: DMPBridgeParam, env: DMPBridgeEnv, callback: DMPBridgeCallback? = nil) -> DMPAPIResult {
        if let handler = Self.getHandler(for: name) {
            return handler(data, env, callback)
        }
        DMPLogger.debug("未找到方法: \(name)")
        return DMPNoneResult()
    }
    
    /// 统一的回调处理方法。
    ///
    /// `completeCarriesResult` 打开时，`complete` 收到的是与 `success` / `fail` 同一份结果对象，
    /// 而不是一个新建的空 map —— 这样 `complete: res => res.errMsg` 才拿得到东西。默认关闭：
    /// `complete` 缺结果是全 API 面的问题，逐个 API 核对语义不属于本次 socket 改动的范围，
    /// 所以这里只给出接线口，由已经核对过的调用方显式打开。
    public static func invokeCallback(_ callback: DMPBridgeCallback?, type: DMPBridgeCallbackType, param: DMPMap?,
                                      errMsg: String? = nil, completeCarriesResult: Bool = false) {
        guard let callback = callback else { return }
        
        let finalParam = param ?? DMPMap()

        if type == .fail, let errMsg = errMsg {
            finalParam.set("data", ["errMsg": errMsg])
            // JS fail callbacks read `res.errMsg` directly (same as invokeSuccess, matching
            // wx.* convention). Skip if the caller already set a top-level errMsg on `param`
            // (some APIs use a fuller "api:fail ..." message).
            if finalParam.get("errMsg") == nil {
                finalParam.set("errMsg", errMsg)
            }
        }

        callback(finalParam, type)
        
        // 所有回调最终都会触发complete
        if type != .complete {
            callback(completeCarriesResult ? finalParam : DMPMap(), .complete)
        }
    }
    
    // 成功回调
    public func invokeSuccessCallback(callback: DMPBridgeCallback?, param: DMPMap?) {
        DMPContainerApi.invokeCallback(callback, type: .success, param: param)
    }
    
    // 失败回调
    public func invokeFailureCallback(callback: DMPBridgeCallback?, param: DMPMap?, errMsg: String) {
        DMPContainerApi.invokeCallback(callback, type: .fail, param: param, errMsg: errMsg)
    }
    
    // 成功回调（静态方法）
    public static func invokeSuccess(callback: DMPBridgeCallback?, param: DMPMap?,
                                     completeCarriesResult: Bool = false) {
        invokeCallback(callback, type: .success, param: param, completeCarriesResult: completeCarriesResult)
    }

    // 失败回调（静态方法）
    public static func invokeFailure(callback: DMPBridgeCallback?, param: DMPMap?, errMsg: String,
                                     completeCarriesResult: Bool = false) {
        invokeCallback(callback, type: .fail, param: param, errMsg: errMsg,
                       completeCarriesResult: completeCarriesResult)
    }
}
