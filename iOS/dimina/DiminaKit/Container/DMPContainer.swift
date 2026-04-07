//
//  DMPContainer.swift
//  dimina
//
//  Created by Lehem on 2025/4/23.
//

import Foundation
import ObjectiveC

enum ResourceLoadType: Int {
    case initial = 0
    case serviceLoaded = 1
    case renderLoaded = 2
    case allLoaded = 3
}

public class DMPContainer {
    // MARK: - Properties
    private weak var app: DMPApp?
    private var loadStatusMap: [Int: ResourceLoadType] = [:]
    var isNavigating: Bool = false

    /// 宿主注册的第三方扩展模块，key = moduleName
    var extModules: [String: DMPExtModuleHandler] = [:]

    /// extOnBridge 持续订阅的取消函数，key = "${module}_${event}"
    private var extSubscriptions: [String: () -> Void] = [:]

    // MARK: - Initialization
    public init(app: DMPApp? = nil) {
        self.app = app
    }

    // MARK: - Ext Module Management

    /// 注册第三方扩展模块
    func registerExtModule(_ moduleName: String, handler: @escaping DMPExtModuleHandler) {
        extModules[moduleName] = handler
    }

    /// 取消所有持续订阅（小程序销毁时调用）
    func clearExtSubscriptions() {
        extSubscriptions.values.forEach { $0() }
        extSubscriptions.removeAll()
    }

    // MARK: - Public Methods
    public func getApp() -> DMPApp? {
        return app
    }

    public func resetStatus() {
        isNavigating = false
    }

    // MARK: - Resource Management
    func hasLoadResource(webViewId: Int, type: ResourceLoadType) {
        let status = loadStatusMap[webViewId] ?? .initial
        let newRawValue = status.rawValue | type.rawValue
        loadStatusMap[webViewId] = ResourceLoadType(rawValue: newRawValue) ?? .initial
    }

    func isResourceLoaded(webViewId: Int) -> Bool {
        return loadStatusMap[webViewId] == .allLoaded
    }

    private func createResourceMessage(webViewId: Int, pagePath: String) -> DMPMap {
        guard let app = app,
            let config = app.getBundleAppConfig()
        else { return DMPMap() }

        let root = config.getRootPackage(pagePath: pagePath)
        return DMPMap([
            "type": "loadResource",
            "body": [
                "bridgeId": webViewId,
                "appId": app.getAppId(),
                "pagePath": pagePath,
                "root": root,
            ],
        ])
    }

    func loadResourceService(webViewId: Int, pagePath: String) {
        guard let app = app else { return }
        let message = createResourceMessage(webViewId: webViewId, pagePath: pagePath)
        DMPChannelProxy.containerToService(msg: message, app: app)
    }

    func loadResourceRender(webViewId: Int, pagePath: String) {
        guard let app = app else { return }
        let message = createResourceMessage(webViewId: webViewId, pagePath: pagePath)
        DMPChannelProxy.containerToRender(msg: message, app: app, webViewId: webViewId)
    }

    // MARK: - Bridge Methods
    public func callWebviewBridgeMethod(
        methodName: String, webViewId: Int, params: Any, app: DMPApp
    ) -> Any {
        // TODO: 实现 WebView 桥接方法
        return DMPMap()
    }

    public func callBridgeMethod(
        methodName: String, webViewId: Int, param: DMPBridgeParam, app: DMPApp
    ) -> DMPAPIResult {
        let moduleName = "DMPContainerBridgesModule"
        print("Bridge call: module=\(moduleName), method=\(methodName)")
        var callback: DMPBridgeCallback = { _, _ in }

        if param.isAsync {
            var callbackIds = (success: "", fail: "", complete: "")
            let map = param.getMap()

            callbackIds.success = map["success"] as? String ?? ""
            callbackIds.fail = map["fail"] as? String ?? ""
            callbackIds.complete = map["complete"] as? String ?? ""

            callback = {
                [weak self] (args: DMPMap, cbType: DMPBridgeCallbackType) in
                guard let self = self else { return }

                let callbackId: String = {
                    switch cbType {
                    case .success: return callbackIds.success
                    case .fail: return callbackIds.fail
                    case .complete: return callbackIds.complete
                    }
                }()

                guard !callbackId.isEmpty else { return }

                let message = DMPMap([
                    "type": "triggerCallback",
                    "body": [
                        "id": callbackId,
                        "args": args.toDictionary(),
                    ],
                ])

                DMPChannelProxy.containerToService(msg: message, app: self.getApp())
            }
        }

        let env = DMPBridgeEnv(
            appIndex: self.app?.getAppIndex() ?? 0,
            appId: self.app?.getAppId() ?? "",
            webViewId: webViewId
        )

        // 1. 精确命中已注册的标准 API
        if let handler = DMPContainerApi.getHandler(for: methodName) {
            return handler(param, env, callback)
        }

        // 2. extBridge：param 携带 "module" 字段
        let paramMap = param.getMap()
        if paramMap["module"] != nil {
            ExtBridgeAPI.handle(
                methodName: methodName,
                param: param,
                env: env,
                callback: callback,
                extModules: extModules
            )
            return DMPNoneResult()
        }

        // 3. extOnBridge / extOffBridge：methodName 格式为 "${module}_${event}"
        if let matchedModule = extModules.keys.first(where: { methodName.hasPrefix($0 + "_") }) {
            let event = String(methodName.dropFirst(matchedModule.count + 1))
            let successId = paramMap["success"] as? String ?? ""
            if !successId.isEmpty {
                handleExtOnBridge(
                    module: matchedModule,
                    event: event,
                    eventKey: methodName,
                    successCallbackId: successId
                )
            } else {
                handleExtOffBridge(eventKey: methodName)
            }
            return DMPNoneResult()
        }

        print("Bridge invoke error: 未找到方法: \(methodName)")
        return DMPSyncResult(["error": "未找到方法: \(methodName)"])
    }

    /// 处理 extOnBridge：启动持续订阅，保存取消函数
    private func handleExtOnBridge(
        module: String,
        event: String,
        eventKey: String,
        successCallbackId: String
    ) {
        guard let handler = extModules[module] else { return }

        // 若已有相同订阅，先取消旧的
        extSubscriptions.removeValue(forKey: eventKey)?()

        let extCallback = DMPExtCallback(
            onSuccess: { [weak self] result in
                guard let self, let app = self.app else { return }
                let message = DMPMap([
                    "type": "triggerCallback",
                    "body": ["id": successCallbackId, "args": result.toDictionary()],
                ])
                DMPChannelProxy.containerToService(msg: message, app: app)
            },
            onFail: { error in
                print("extOnBridge error (\(eventKey)): \(error.toJsonString())")
            }
        )

        let unsubscribe = handler(event, DMPMap(), extCallback)
        if let unsubscribe {
            extSubscriptions[eventKey] = unsubscribe
        }
    }

    /// 处理 extOffBridge：取消持续订阅
    private func handleExtOffBridge(eventKey: String) {
        extSubscriptions.removeValue(forKey: eventKey)?()
        print("extOffBridge: cancelled subscription for \(eventKey)")
    }

    // MARK: - Private Methods
    private static func getSubclasses(of baseClass: AnyClass) -> [AnyClass] {
        var count: UInt32 = 0
        guard let classesPtr = objc_copyClassList(&count) else { return [] }
        defer { free(UnsafeMutableRawPointer(classesPtr)) }

        var result: [AnyClass] = []
        let buffer = UnsafeBufferPointer(start: classesPtr, count: Int(count))
        for currentClass in buffer {
            if class_getSuperclass(currentClass) === baseClass {
                result.append(currentClass)
            }
        }
        return result
    }
}
