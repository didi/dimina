//
//  DMPEngine.swift
//  dimina
//
//  Created by Lehem on 2025/4/16.
//

import Foundation
import JavaScriptCore

public class DMPEngine: NSObject {
    
    private var jsContext: JSContext?
    
    private var jsThread: Thread
    
    private let jsQueue = DispatchQueue(label: "com.dimina.jsengine.queue")
    
    private var isThreadRunning = false
    
    private var initCompletionHandlers: [() -> Void] = []
    
    public override init() {
        jsThread = Thread()
        
        super.init()
        
        jsThread = Thread { [weak self] in
            guard let self = self else { return }
            self.jsThreadMain()
        }
        jsThread.name = "com.dimina.jsengine.thread"
        jsThread.qualityOfService = .userInteractive
        
        jsThread.start()
    }
    
    public var isInitialized: Bool {
        return isThreadRunning
    }
    
    public func onInitialized(_ handler: @escaping () -> Void) {
        jsQueue.async { [weak self] in
            guard let self = self else { return }
            if self.isThreadRunning {
                handler()
            } else {
                self.initCompletionHandlers.append(handler)
            }
        }
    }
    
    private func jsThreadMain() {
        let runLoop = RunLoop.current
        
        autoreleasepool {
            self.jsContext = JSContext()
            setupJSEnvironment()
        }
        
        isThreadRunning = true
        
        jsQueue.async { [weak self] in
            guard let self = self else { return }
            for handler in self.initCompletionHandlers {
                handler()
            }
            self.initCompletionHandlers.removeAll()
        }
        
        let port = Port()
        runLoop.add(port, forMode: .default)
        while true {
            runLoop.run(until: Date(timeIntervalSinceNow: 0.1))
        }
    }
    
    private func setupJSEnvironment() {
        guard let context = jsContext else { return }
        
        context.exceptionHandler = { context, exception in
            guard let exception = exception else { return }
            DMPLogger.debug("JS Error: \(exception.toString() ?? "Unknown error")")
        }
        
        context.evaluateScript("DiminaServiceBridge = {};")
        
        DMPEngineLog.injectConsole(to: context)
        DMPEngineTimer.registerTimerFunctions(to: context)
        DMPEngineInvoke.registerInvoke(to: context)
        DMPEnginePublish.registerPublish(to: context)
        
    }
    
    @discardableResult
    public func evaluateScript(_ script: String) async -> JSValue? {
        return await withCheckedContinuation { continuation in
            self.performOnJSThread {
                let result = self.jsContext?.evaluateScript(script)
                DMPLogger.debug("🔴 engine evaluateScript: \(script) result: \(result)")
                continuation.resume(returning: result)
            }
        }
    }
    
    /// 按调用顺序把脚本排进 JS 线程执行，不等结果。内部走的是 `performOnJSThread`
    /// 的串行队列，所以先调用的一定先在 JS 里执行。
    ///
    /// 容器往 service 推消息必须用这个，不要用 `Task { await evaluateScript(...) }`：
    /// 每条消息各起一个不受管的 Task 会被丢到并发线程池上，两条紧挨着发出的消息
    /// 谁先跑到 JS 线程完全看线程调度，顺序会颠倒。
    public func enqueueScript(_ script: String) {
        performOnJSThread { [weak self] in
            let result = self?.jsContext?.evaluateScript(script)
            DMPLogger.debug("🔴 engine enqueueScript: \(script) result: \(String(describing: result))")
        }
    }

    @discardableResult
    public func loadFile(path: String) async -> JSValue? {
        return await withCheckedContinuation { continuation in
            self.performOnJSThread {
                do {
                    let fileContent = try String(contentsOfFile: path, encoding: .utf8)
                    let result = self.jsContext?.evaluateScript(fileContent)
                    DMPLogger.debug("🔴 engine loadFile: \(path) result: \(result)")
                    continuation.resume(returning: result)
                } catch {
                    DMPLogger.debug("Error loading file at path \(path): \(error.localizedDescription)")
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private func performOnJSThread(_ closure: @escaping () -> Void) {
        self.jsQueue.async {
            if Thread.current != self.jsThread {
                let selector = #selector(self.runClosureOnJSThread(_:))
                self.perform(selector, on: self.jsThread, with: closure, waitUntilDone: false)
            } else {
                closure()
            }
        }
    }
    
    @objc private func runClosureOnJSThread(_ closure: Any) {
        if let closure = closure as? () -> Void {
            closure()
        }
    }
    
    public func registerMethod(name: String, callback: @escaping (JSValue) -> Any?) {
        performOnJSThread {
            let callbackWrapper: @convention(block) (JSValue) -> Any? = { value in
                return callback(value)
            }
            self.jsContext?.setObject(callbackWrapper, forKeyedSubscript: name as NSString)
        }
    }
    
    public func destroy() {
        isThreadRunning = false
        
        jsQueue.async { [weak self] in
            self?.initCompletionHandlers.removeAll()
        }
        
        performOnJSThread { [weak self] in
            DMPEngineTimer.shared.clearAllTimers()
            
            self?.jsContext?.exception = nil
            self?.jsContext = nil
            
            CFRunLoopStop(CFRunLoopGetCurrent())
        }
        
        // 取消线程
        jsThread.cancel()
        
        // 等待线程结束，最多等待1秒
        let timeout = Date(timeIntervalSinceNow: 1.0)
        while jsThread.isExecuting && Date() < timeout {
            Thread.sleep(forTimeInterval: 0.1)
        }
        
        if jsThread.isExecuting {
            DMPLogger.debug("destroy engine failed")
        }
    }
}
