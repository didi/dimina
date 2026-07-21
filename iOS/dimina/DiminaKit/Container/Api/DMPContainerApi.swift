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
    public let appIndex: Int
    public let appId: String
    public let webViewId: Int

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
    private var customAPIHandlers: [String: DMPApiHandler] = [:]

    private static let registryLock = NSLock()
    private static var bridgeHandlerMap: [String: DMPBridgeMethodHandler] = [:]
    
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
        _ = VideoAPI(app: app)
        _ = CanvasAPI(app: app)
        _ = InteractionAPI(app: app)
        _ = MenuAPI(app: app)
        _ = NavigationBarAPI(app: app)
        _ = ScrollAPI(app: app)
        _ = TabBarAPI(app: app)
        _ = NativeComponentAPI(app: app)
        
        return DMPContainerApi(app: app)
    }
    
    public func getApp() -> DMPApp? {
        return app
    }
    
    // 统一注册方法
    public static func registerMethod(name: String, handler: DMPBridgeMethodHandler? = nil) {
        guard let handler else { return }
        registryLock.lock()
        bridgeHandlerMap[name] = handler
        registryLock.unlock()
    }
    
    private static func getBuiltInHandler(for methodName: String) -> DMPBridgeMethodHandler? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return bridgeHandlerMap[methodName]
    }
    
    private static func getAllBuiltInMethods() -> Set<String> {
        registryLock.lock()
        defer { registryLock.unlock() }
        return Set(bridgeHandlerMap.keys)
    }

    @discardableResult
    func registerCustomAPI(
        _ handler: DMPApiHandler,
        conflictPolicy: DMPApiConflictPolicy
    ) -> Set<String> {
        let builtInMethods = Self.getAllBuiltInMethods()
        var conflicts = Set<String>()

        for name in handler.apiNames {
            let hasConflict = builtInMethods.contains(name) || customAPIHandlers[name] != nil
            if hasConflict, conflictPolicy == .reject {
                conflicts.insert(name)
                continue
            }
            customAPIHandlers[name] = handler
        }

        return conflicts
    }

    func getHandler(for methodName: String) -> DMPBridgeMethodHandler? {
        if let customHandler = customAPIHandlers[methodName] {
            return { param, env, callback in
                customHandler.handle(
                    name: methodName,
                    param: param,
                    env: env,
                    callback: callback
                )
            }
        }
        return Self.getBuiltInHandler(for: methodName)
    }

    func getAllRegisteredMethods() -> [String] {
        let methods = Self.getAllBuiltInMethods().union(customAPIHandlers.keys)
        return methods.sorted()
    }
    
    public func invokeBridgeMethod(name: String, data: DMPBridgeParam, env: DMPBridgeEnv, callback: DMPBridgeCallback? = nil) -> DMPAPIResult {
        if let handler = getHandler(for: name) {
            return handler(data, env, callback)
        }
        DMPLogger.debug("未找到方法: \(name)")
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
