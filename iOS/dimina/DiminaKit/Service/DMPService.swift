//
//  DMPService.swift
//  dimina
//
//  Created by Lehem on 2025/4/16.
//

import Foundation
import JavaScriptCore

public class DMPService {
    
    private(set) var engine: DMPEngine
    
    private var isInitialized: Bool = false
    
    private weak var app: DMPApp?
    
    public init(app: DMPApp) {
        self.app = app
        self.engine = DMPEngine()
        
        DMPEngineInvoke.registerAppResolver { [weak self] in
            return self?.app
        }
        DMPEnginePublish.registerAppResolver { [weak self] in
            return self?.app
        }
    }
    
    public func initialize() -> Bool {
        guard !isInitialized else {
            return true
        }
        isInitialized = true
        
        
        return isInitialized
    }
    
    public func getEngine() -> DMPEngine {
        return engine
    }
    
    @discardableResult
    public func evaluateScript(_ script: String) async -> JSValue? {
        return await engine.evaluateScript(script)
    }

    public func loadFile(path: String) async {
        await engine.loadFile(path: path)
    }

    public func postMessage(data: DMPMap) async {
        let dataString = data.toJsonString()
        let script: String = "DiminaServiceBridge.onMessage(\(dataString))"
        await self.evaluateScript(script)
    }
    
    public func loadSubPackage(pagePath: String) async {
        let bundleAppConfig = app?.getBundleAppConfig()
        let packageName = bundleAppConfig?.getRootPackage(pagePath: pagePath) ?? "main"
        
        if (packageName == "main") {
            return
        }
        
        let subPackagePath = DMPSandboxManager.appSubPackagePath(appId: app?.getAppId() ?? "", packageName: packageName)
        await loadFile(path: subPackagePath)
    }

    public func fromRender(data: String) async {
        let script: String = "DiminaServiceBridge.onMessage(\(data))"
        await self.evaluateScript(script)
    }

    @discardableResult
    func fromContainerMessage(data: DMPMap) async -> JSValue? {
        DMPLogger.debug("DMPService: fromContainer data: \(data.toJsonString())")

        let script: String = "DiminaServiceBridge.onMessage(\(data.toJsonString()))"
        return await self.evaluateScript(script)
    }
    
    /// 容器 -> service 的消息投递。必须严格按调用顺序送到 JS，一次 API 调用的
    /// success 和 complete 就是紧挨着发出的两条消息，顺序颠倒会让 JS 侧先收到
    /// complete。
    ///
    /// 这里原来是 `Task { await fromContainerMessage(data:) }`：每条消息各起一个
    /// 不受管的 Task，被丢到并发线程池上由不同线程跑，谁先执行到往 JS 线程排队
    /// 那一步完全看线程调度，两条消息因此可能反过来。改成直接排进引擎的串行队列，
    /// 投递顺序就等于调用顺序。
    func fromContainer(data: DMPMap) {
        DMPLogger.debug("DMPService: fromContainer data: \(data.toJsonString())")
        engine.enqueueScript("DiminaServiceBridge.onMessage(\(data.toJsonString()))")
    }
    
    public func destroy() {
        isInitialized = false
        engine.destroy()
    }
}
