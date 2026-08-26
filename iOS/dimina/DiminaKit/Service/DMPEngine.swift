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

    /// Bound to this engine for its entire lifetime. Keeping the resolver
    /// instance-scoped prevents a second mini program from redirecting the
    /// opener's invoke/publish bridge to a different (or destroyed) app.
    private let appResolver: () -> DMPApp?

    /// Timer state is engine-scoped. No other mini program can cancel this manager's sources.
    private let timerManager = DMPEngineTimer()
    
    private var jsThread: Thread
    private let jsThreadStopped = DispatchSemaphore(value: 0)
    private let destroyLock = NSLock()
    private var destroyStarted = false
    
    private let jsQueue = DispatchQueue(label: "com.dimina.jsengine.queue")

    /// Accessed only on jsQueue. Tasks submitted while teardown is in flight are retained until
    /// jsContext has been cleared, then executed on jsQueue so async continuations can return nil
    /// instead of being stranded on a run loop that no longer exists.
    private enum JSThreadState {
        case accepting
        case stopping
        case stopped
    }
    private var jsThreadState: JSThreadState = .accepting
    private var tasksWaitingForStop: [() -> Void] = []

    private let initializationLock = NSLock()
    private var _isThreadRunning = false
    
    private var initCompletionHandlers: [() -> Void] = []
    
    public init(appResolver: @escaping () -> DMPApp? = { nil }) {
        self.appResolver = appResolver
        jsThread = Thread()
        
        super.init()
        
        jsThread = Thread { [weak self] in
            guard let self = self else { return }
            defer { self.jsThreadStopped.signal() }
            self.jsThreadMain()
        }
        jsThread.name = "com.dimina.jsengine.thread"
        jsThread.qualityOfService = .userInteractive
        
        jsThread.start()
    }
    
    public var isInitialized: Bool {
        initializationLock.lock()
        defer { initializationLock.unlock() }
        return _isThreadRunning
    }

    private func setThreadRunning(_ value: Bool) {
        initializationLock.lock()
        _isThreadRunning = value
        initializationLock.unlock()
    }
    
    public func onInitialized(_ handler: @escaping () -> Void) {
        jsQueue.async { [weak self] in
            guard let self = self else { return }
            if self.isInitialized {
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
        
        setThreadRunning(true)
        
        jsQueue.async { [weak self] in
            guard let self = self else { return }
            for handler in self.initCompletionHandlers {
                handler()
            }
            self.initCompletionHandlers.removeAll()
        }
        
        let port = Port()
        runLoop.add(port, forMode: .default)
        while !Thread.current.isCancelled {
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
        context.evaluateScript("globalThis.__VIRTUAL_FILE_PREFIX__ = '\(DMPFileUtil.DMPFileURLScheme)://';")

        DMPEngineLog.injectConsole(to: context)
        // setTimeout/setInterval callbacks must land on this engine's own JS thread like
        // every other entry into `context`, not on the timer source queue — otherwise a timer
        // callback can race a container message and split one JavaScript turn.
        timerManager.registerTimerFunctions(to: context, executor: { [weak self] closure in
            self?.performOnJSThread(closure)
        })
        let resolver: () -> DMPApp? = { [weak self] in
            self?.resolveApp()
        }
        DMPEngineInvoke.registerInvoke(to: context, appResolver: resolver)
        DMPEnginePublish.registerPublish(to: context, appResolver: resolver)
        
    }

    /// The bridge registrations and focused tests share this single lookup so
    /// invoke and publish cannot accidentally drift back to global state.
    func resolveApp() -> DMPApp? {
        return appResolver()
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

    /// Enqueue a native completion behind all previously submitted JavaScript
    /// turns without evaluating another user-controlled script.
    func enqueueBarrier(_ completion: @escaping () -> Void) {
        performOnJSThread(completion)
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
            switch self.jsThreadState {
            case .accepting:
                let selector = #selector(self.runClosureOnJSThread(_:))
                self.perform(selector, on: self.jsThread, with: closure, waitUntilDone: false)
            case .stopping:
                self.tasksWaitingForStop.append(closure)
            case .stopped:
                // The context has already been cleared. Running the closure here lets callers
                // such as evaluateScript/loadFile resume their continuations with nil.
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
        destroyLock.lock()
        guard !destroyStarted else {
            destroyLock.unlock()
            return
        }
        destroyStarted = true
        destroyLock.unlock()

        setThreadRunning(false)

        // Cancel immediately so callbacks already waiting for the JS thread observe teardown.
        // Repeat inside the teardown turn to catch a timer registered by JavaScript that was
        // already executing when destroy() began. The manager belongs only to this engine.
        timerManager.clearAllTimers()

        jsQueue.async { [weak self] in
            guard let self, self.jsThreadState == .accepting else { return }
            self.initCompletionHandlers.removeAll()
            self.jsThreadState = .stopping

            let teardown = { [weak self] in
                guard let self else { return }
                self.timerManager.clearAllTimers()
                self.jsContext?.exception = nil
                self.jsContext = nil
                self.setThreadRunning(false)

                // The run-loop condition observes cancellation after this turn returns. Stopping
                // the current run wakes it instead of waiting for the next 100 ms deadline.
                Thread.current.cancel()
                CFRunLoopStop(CFRunLoopGetCurrent())

                self.jsQueue.async { [weak self] in
                    guard let self else { return }
                    self.jsThreadState = .stopped
                    let waiting = self.tasksWaitingForStop
                    self.tasksWaitingForStop.removeAll()
                    for task in waiting {
                        task()
                    }
                }
            }
            let selector = #selector(self.runClosureOnJSThread(_:))
            self.perform(selector, on: self.jsThread, with: teardown, waitUntilDone: false)
        }
        
        // A native callback can request teardown while it is already running on the JS thread.
        // Waiting there would deadlock the teardown turn; all other callers wait without polling.
        if Thread.current != jsThread,
           jsThreadStopped.wait(timeout: .now() + 1) == .timedOut {
            DMPLogger.debug("destroy engine failed")
        }
    }
}
