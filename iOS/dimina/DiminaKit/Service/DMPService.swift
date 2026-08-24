//
//  DMPService.swift
//  dimina
//
//  Created by Lehem on 2025/4/16.
//

import Foundation
import JavaScriptCore

/// Runtime-scoped app lookup used by one service engine. The app itself can
/// outlive a service during restart/close, so a plain weak app reference is
/// insufficient: a late JavaScript turn from the old engine could otherwise
/// resolve the app again after its new container/service have been installed.
private final class DMPServiceAppBinding {
    private let lock = NSLock()
    private weak var app: DMPApp?
    private var isActive = true

    init(app: DMPApp) {
        self.app = app
    }

    func resolve() -> DMPApp? {
        lock.lock()
        defer { lock.unlock() }
        return isActive ? app : nil
    }

    func invalidate() {
        lock.lock()
        isActive = false
        app = nil
        lock.unlock()
    }
}

public class DMPService {
    
    private(set) var engine: DMPEngine
    
    private var isInitialized: Bool = false
    
    private weak var app: DMPApp?
    private let appBinding: DMPServiceAppBinding
    
    public init(app: DMPApp) {
        let appBinding = DMPServiceAppBinding(app: app)
        self.app = app
        self.appBinding = appBinding
        self.engine = DMPEngine {
            appBinding.resolve()
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

    /// 渲染层 -> service 的消息投递。和 `fromContainer` 一样必须严格按调用顺序送到 JS：
    /// 一次触摸在渲染层里是同步派发的，路径上每个节点的 tap 紧挨着发出，顺序颠倒会让
    /// 页面看到的事件次序和 DOM 派发次序对不上。
    public func fromRender(data: String) {
        engine.enqueueScript("DiminaServiceBridge.onMessage(\(data))")
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

    /// Wait until every previously enqueued container message has completed
    /// its JavaScript turn. Destructive app operations use this barrier after
    /// success/complete and hide/unload lifecycle delivery, while the old app,
    /// container, and native API managers are still valid.
    func drainPendingContainerMessages(timeout: TimeInterval = 1) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let lock = NSLock()
            var completed = false
            let finish = {
                lock.lock()
                guard !completed else {
                    lock.unlock()
                    return
                }
                completed = true
                lock.unlock()
                continuation.resume()
            }

            engine.enqueueBarrier(finish)
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                lock.lock()
                let didTimeout = !completed
                lock.unlock()
                if didTimeout {
                    DMPLogger.debug("service callback drain timed out")
                }
                finish()
            }
        }
    }
    
    public func destroy() {
        invalidateAppBinding()
        isInitialized = false
        engine.destroy()
    }

    /// Stop this service generation from resolving its app synchronously.
    /// DMPApp calls this before clearing/replacing runtime fields so a queued
    /// old-engine invoke cannot observe a half-destroyed or new runtime.
    func invalidateAppBinding() {
        appBinding.invalidate()
    }
}
