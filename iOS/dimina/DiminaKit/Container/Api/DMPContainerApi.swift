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
        _ = NetworkAPI(app: app)
        _ = StorageAPI(app: app)
        _ = ClipboardAPI(app: app)
        _ = ContactAPI(app: app)
        _ = KeyboardAPI(app: app)
        _ = NetworkTypeAPI(app: app)
        _ = PhoneAPI(app: app)
        _ = VibrateAPI(app: app)
        _ = ImageAPI(app: app)
        _ = VideoAPI(app: app)
        _ = InteractionAPI(app: app)
        _ = MenuAPI(app: app)
        _ = NavigationBarAPI(app: app)
        _ = ScrollAPI(app: app)
        
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
        print("未找到方法: \(name)")
        return DMPNoneResult()
    }
    
    // 统一的回调处理方法
    public static func invokeCallback(_ callback: DMPBridgeCallback?, type: DMPBridgeCallbackType, param: DMPMap?, errMsg: String? = nil) {
        guard let callback = callback else { return }
        
        let finalParam = param ?? DMPMap()
        
        if type == .fail, let errMsg = errMsg {
            finalParam.set("data", ["errMsg": errMsg])
        }
        
        callback(finalParam, type)
        
        // 所有回调最终都会触发complete
        if type != .complete {
            callback(DMPMap(), .complete)
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
    public static func invokeSuccess(callback: DMPBridgeCallback?, param: DMPMap?) {
        invokeCallback(callback, type: .success, param: param)
    }
    
    // 失败回调（静态方法）
    public static func invokeFailure(callback: DMPBridgeCallback?, param: DMPMap?, errMsg: String) {
        invokeCallback(callback, type: .fail, param: param, errMsg: errMsg)
    }
}
