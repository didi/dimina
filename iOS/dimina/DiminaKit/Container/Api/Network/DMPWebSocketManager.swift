//
//  DMPWebSocketManager.swift
//  dimina
//
//  Native wx.connectSocket / SocketTask support (iOS).
//
//  Implements the shared cross-platform behavioral contract: validation
//  order, event mutual-exclusion (open/close/error), close races,
//  background/foreground policy, legacy single-slot global API binding,
//  idle timeout and the binary frame wire format.
//
//  Threading: every piece of mutable state (owners/entries/timers/transport
//  routing table) is confined to a single serial `queue`. Bridge entry
//  points and transport delegate callbacks all hop onto that queue before
//  touching anything.
//
//  Testability: networking is abstracted behind `DMPSocketTransport` /
//  `DMPSocketTransportFactory`, and time behind `DMPWebSocketScheduling`,
//  so `DMPWebSocketManagerTests` can inject a scripted fake transport and a
//  manually-advanced clock to make every race deterministic.

import Foundation
import UIKit

// MARK: - Transport abstraction (testability seam)

/// One physical WebSocket connection attempt. Implementations may call the
/// delegate methods on any thread/queue; the delegate (the Manager) hops
/// back onto its own serial queue before touching shared state.
protocol DMPSocketTransport: AnyObject {
    func connect(request: URLRequest)
    func send(text: String, completion: @escaping (Error?) -> Void)
    func send(data: Data, completion: @escaping (Error?) -> Void)
    /// Graceful close: ask the peer to complete the WS close handshake.
    func close(code: Int, reason: Data?)
    /// Abrupt teardown: no close handshake, just kill the connection.
    func abort()
}

protocol DMPSocketTransportDelegate: AnyObject {
    func transportDidOpen(_ transport: DMPSocketTransport, headers: [String: String])
    func transport(_ transport: DMPSocketTransport, didReceiveText text: String)
    func transport(_ transport: DMPSocketTransport, didReceiveData data: Data)
    func transport(_ transport: DMPSocketTransport, didCloseWithCode code: Int, reason: Data?)
    func transport(_ transport: DMPSocketTransport, didCompleteWithError error: Error?)
}

protocol DMPSocketTransportFactory {
    func makeTransport(delegate: DMPSocketTransportDelegate) -> DMPSocketTransport
}

// MARK: - Scheduling abstraction (testability seam)

protocol DMPWebSocketCancellable {
    func cancel()
}

protocol DMPWebSocketScheduling {
    /// Milliseconds since epoch (matches the profile timestamp unit).
    func now() -> Double
    @discardableResult
    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> DMPWebSocketCancellable
}

final class DMPDispatchScheduling: DMPWebSocketScheduling {
    func now() -> Double {
        return Date().timeIntervalSince1970 * 1000
    }

    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> DMPWebSocketCancellable {
        let workItem = DispatchWorkItem(block: block)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(0, seconds), execute: workItem)
        return DMPDispatchCancellable(workItem: workItem)
    }
}

final class DMPDispatchCancellable: DMPWebSocketCancellable {
    private let workItem: DispatchWorkItem
    init(workItem: DispatchWorkItem) { self.workItem = workItem }
    func cancel() { workItem.cancel() }
}

// MARK: - Production transport (URLSessionWebSocketTask)

/// Owns the single shared `URLSession` used for every WebSocket task, and
/// routes session-level delegate callbacks to the right transport instance
/// via `task.taskIdentifier`.
final class DMPURLSessionWebSocketFactory: NSObject, DMPSocketTransportFactory {
    private lazy var session: URLSession = {
        URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }()

    private let lock = NSLock()
    private var transports: [Int: DMPURLSessionWebSocketTransport] = [:]

    func makeTransport(delegate: DMPSocketTransportDelegate) -> DMPSocketTransport {
        return DMPURLSessionWebSocketTransport(session: session, delegate: delegate, registrar: self)
    }

    fileprivate func register(taskIdentifier: Int, transport: DMPURLSessionWebSocketTransport) {
        lock.lock()
        transports[taskIdentifier] = transport
        lock.unlock()
    }

    fileprivate func unregister(taskIdentifier: Int) {
        lock.lock()
        transports.removeValue(forKey: taskIdentifier)
        lock.unlock()
    }

    private func transport(for task: URLSessionTask) -> DMPURLSessionWebSocketTransport? {
        lock.lock()
        defer { lock.unlock() }
        return transports[task.taskIdentifier]
    }
}

extension DMPURLSessionWebSocketFactory: URLSessionWebSocketDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        transport(for: webSocketTask)?.handleOpen()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        transport(for: webSocketTask)?.handleClose(code: closeCode.rawValue, reason: reason)
    }
}

extension DMPURLSessionWebSocketFactory: URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        transport(for: task)?.handleComplete(error: error)
    }
}

/// Wraps a single `URLSessionWebSocketTask`. Not shared across connections.
final class DMPURLSessionWebSocketTransport: DMPSocketTransport {
    private let session: URLSession
    private weak var delegate: DMPSocketTransportDelegate?
    private weak var registrar: DMPURLSessionWebSocketFactory?
    private var task: URLSessionWebSocketTask?
    private var didFinish = false

    init(session: URLSession, delegate: DMPSocketTransportDelegate, registrar: DMPURLSessionWebSocketFactory) {
        self.session = session
        self.delegate = delegate
        self.registrar = registrar
    }

    func connect(request: URLRequest) {
        let task = session.webSocketTask(with: request)
        self.task = task
        registrar?.register(taskIdentifier: task.taskIdentifier, transport: self)
        task.resume()
        listen()
    }

    private func listen() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    self.delegate?.transport(self, didReceiveText: text)
                case let .data(data):
                    self.delegate?.transport(self, didReceiveData: data)
                @unknown default:
                    break
                }
                self.listen()
            case .failure:
                // The failure is also reported via URLSessionTaskDelegate's
                // didCompleteWithError; stop re-arming the receive loop but
                // don't double-report here.
                break
            }
        }
    }

    func send(text: String, completion: @escaping (Error?) -> Void) {
        task?.send(.string(text), completionHandler: completion)
    }

    func send(data: Data, completion: @escaping (Error?) -> Void) {
        task?.send(.data(data), completionHandler: completion)
    }

    func close(code: Int, reason: Data?) {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task?.cancel(with: closeCode, reason: reason)
    }

    func abort() {
        task?.cancel()
        cleanup()
    }

    fileprivate func handleOpen() {
        let rawHeaders = (task?.response as? HTTPURLResponse)?.allHeaderFields ?? [:]
        var headers: [String: String] = [:]
        for (key, value) in rawHeaders {
            headers["\(key)"] = "\(value)"
        }
        delegate?.transportDidOpen(self, headers: headers)
    }

    fileprivate func handleClose(code: Int, reason: Data?) {
        guard !didFinish else { return }
        didFinish = true
        delegate?.transport(self, didCloseWithCode: code, reason: reason)
        cleanup()
    }

    fileprivate func handleComplete(error: Error?) {
        guard !didFinish else { return }
        didFinish = true
        delegate?.transport(self, didCompleteWithError: error)
        cleanup()
    }

    private func cleanup() {
        if let task { registrar?.unregister(taskIdentifier: task.taskIdentifier) }
    }
}

// MARK: - Data model

enum DMPWebSocketEventType: String, CaseIterable {
    case open, message, error, close
}

enum DMPSocketState {
    case created, connecting, open, closing, closed
}

final class DMPOwnerState {
    var sockets: [String: DMPSocketEntry] = [:]
    var legacyBoundSocketId: String?
    /// Ordered, de-duplicated listener ids for the global `wx.onSocketXxx` API. Same shape as
    /// `DMPSocketEntry.listeners`: fe keeps one callback id per registered listener function and
    /// sends a separate `onSocketXxx` for each, so a single id per event would silently drop
    /// every listener but the last one.
    var legacySlots: [DMPWebSocketEventType: [String]] = [:]
    var backgrounded: Bool = false
    var graceTimer: DMPWebSocketCancellable?
    /// 已经派发过的终态事件（error/close）载荷，键是 "socketId|event"。连接一进入
    /// 终态，entry 就从 sockets 里删掉了，之后到达的监听注册再也找不到它；而
    /// wx.connectSocket 一返回原生就立刻开始拨号，连本机地址被拒绝都可能比调用方的
    /// onSocketError/onSocketClose 注册消息更早到达（实测早 1 毫秒），这个事件就会
    /// 永久丢失。这里按插入顺序在 owner 级别保留最近若干条终态事件，注册时补发一次。
    var terminalReplay: [String: DMPMap] = [:]
    /// terminalReplay 的插入顺序（Dictionary 本身无序），用于容量超限时淘汰最旧的一条。
    var terminalReplayOrder: [String] = []
}

struct DMPWebSocketProfile {
    var fetchStart: Double?
    var openedAt: Double?

    /// Best-effort fill: only fetchStart and cost are guaranteed real on iOS
    /// (URLSessionTaskMetrics arrives too late to back-fill dns/connect
    /// phases before the open event must fire).
    func toDictionary() -> [String: Any] {
        let fetchStart = self.fetchStart ?? 0
        let openedAt = self.openedAt ?? fetchStart
        let connectStart = fetchStart
        let connectEnd = openedAt
        let domainLookUpStart = fetchStart
        let domainLookUpEnd = fetchStart
        let rtt = max(0, connectEnd - connectStart)
        let handshakeCost = max(0, openedAt - connectEnd)
        let cost = max(0, openedAt - fetchStart)
        return [
            "fetchStart": fetchStart,
            "domainLookUpStart": domainLookUpStart,
            "domainLookUpEnd": domainLookUpEnd,
            "connectStart": connectStart,
            "connectEnd": connectEnd,
            "rtt": rtt,
            "handshakeCost": handshakeCost,
            "cost": cost,
        ]
    }
}

final class DMPSocketEntry {
    let socketId: String
    var transport: DMPSocketTransport?
    var state: DMPSocketState = .created
    /// Has this connection ever reached OPEN. Gates the close/error
    /// mutual-exclusion rule.
    var opened = false
    var errorEmitted = false
    /// Set when a close() call lands while still CREATED; tells the queued
    /// dial task to abandon before touching the network.
    var cancelled = false
    var connectTimer: DMPWebSocketCancellable?
    var idleTimer: DMPWebSocketCancellable?
    /// The caller's own (code, reason) for a client-initiated close; always
    /// what gets reported to JS regardless of wire echo.
    var requestedClose: (code: Int, reason: String)?
    var listeners: [DMPWebSocketEventType: [String]] = [.open: [], .message: [], .error: [], .close: []]
    var responseHeader: [String: String] = [:]
    var profile = DMPWebSocketProfile()
    var timeoutMs: Int = DMPWebSocketValidation.defaultTimeoutMs
    /// Already-dispatched open payload, kept around so a listener registered
    /// after this connection already reached OPEN can be handed the event
    /// immediately (see `handleOn`) instead of missing it forever.
    var openPayload: DMPMap?

    init(socketId: String) {
        self.socketId = socketId
    }
}

// MARK: - Manager

final class DMPWebSocketManager {
    static let shared: DMPWebSocketManager = {
        let manager = DMPWebSocketManager(transportFactory: DMPURLSessionWebSocketFactory(),
                                           scheduling: DMPDispatchScheduling())
        manager.installApplicationLifecycleObservers()
        return manager
    }()

    private static let maxConnectionsPerOwner = 5
    private static let backgroundGraceSeconds: TimeInterval = 5.0
    /// 终态事件补发记录的上限。按最多 5 条并发连接算，留够几轮用例的量即可。
    private static let terminalReplayCapacity = 32

    private enum Api {
        static let connect = "connectSocket"
        static let send = "sendSocketMessage"
        static let close = "closeSocket"
    }

    private let queue: DispatchQueue
    private let transportFactory: DMPSocketTransportFactory
    private let scheduling: DMPWebSocketScheduling
    private var owners: [String: DMPOwnerState] = [:]
    /// Process-wide background flag, independent of any single owner's
    /// lifetime: the app can re-enter background while a mini program's JS
    /// keeps running for a few more seconds, and its FIRST socket-API call
    /// may create a brand-new owner *after* backgrounding already started.
    /// `getOrCreateOwner(appId:)` consults this so the owner inherits
    /// "backgrounded" immediately instead of defaulting to false.
    private var globallyBackgrounded = false
    private var transportKeys: [ObjectIdentifier: (appId: String, socketId: String)] = [:]
    /// Host-level configuration, not exposed to mini-program JS. 0 =
    /// disabled (default).
    private var idleTimeoutMs: Int = 0

    init(transportFactory: DMPSocketTransportFactory,
         scheduling: DMPWebSocketScheduling,
         queue: DispatchQueue = DispatchQueue(label: "com.didi.dimina.websocket")) {
        self.transportFactory = transportFactory
        self.scheduling = scheduling
        self.queue = queue
    }

    // MARK: Host configuration

    func setIdleTimeoutMs(_ ms: Int) {
        queue.async { [weak self] in
            self?.idleTimeoutMs = max(0, ms)
        }
    }

    /// Blocks until every previously-enqueued operation has completed. Only
    /// meant for deterministic unit tests.
    func drainForTesting() {
        queue.sync {}
    }

    // MARK: Application lifecycle

    private func installApplicationLifecycleObservers() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(applicationDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification, object: nil
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(applicationWillEnterForeground),
            name: UIApplication.willEnterForegroundNotification, object: nil
        )
    }

    @objc private func applicationDidEnterBackground() {
        setAllBackgrounded(true)
    }

    @objc private func applicationWillEnterForeground() {
        setAllBackgrounded(false)
    }

    /// iOS/HarmonyOS background/foreground is a process-wide event: touch
    /// every live owner, each with its own flag/timer.
    func setAllBackgrounded(_ backgrounded: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            self.globallyBackgrounded = backgrounded
            for appId in self.owners.keys {
                self.setBackgrounded(appId: appId, backgrounded: backgrounded)
            }
        }
    }

    private func setBackgrounded(appId: String, backgrounded: Bool) {
        guard let owner = owners[appId] else { return }
        if backgrounded {
            guard !owner.backgrounded else { return }
            owner.backgrounded = true
            owner.graceTimer = scheduling.schedule(after: Self.backgroundGraceSeconds) { [weak self] in
                self?.queue.async { self?.handleBackgroundGraceExpired(appId: appId) }
            }
        } else {
            owner.backgrounded = false
            owner.graceTimer?.cancel()
            owner.graceTimer = nil
        }
    }

    private func handleBackgroundGraceExpired(appId: String) {
        guard let owner = owners[appId] else { return }
        owner.graceTimer = nil
        guard owner.backgrounded else { return }

        for entry in Array(owner.sockets.values) {
            if entry.opened {
                killTransport(entry)
                teardown(owner: owner, appId: appId, entry: entry, event: .close,
                         payload: DMPMap(["code": 1006, "reason": "interrupted"]))
            } else if entry.errorEmitted {
                silentlyRemove(owner: owner, entry: entry)
            } else {
                killTransport(entry)
                teardown(owner: owner, appId: appId, entry: entry, event: .error,
                         payload: DMPMap(["errMsg": "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.interrupted)"]))
            }
        }
    }

    // MARK: App teardown

    /// Synchronous and silent: no close/error events fire, the JS context
    /// this owner belongs to is already gone.
    func disposeOwner(appId: String) {
        queue.sync { [weak self] in
            guard let self, let owner = self.owners[appId] else { return }
            for entry in Array(owner.sockets.values) {
                self.silentlyRemove(owner: owner, entry: entry)
            }
            owner.graceTimer?.cancel()
            self.owners.removeValue(forKey: appId)
        }
    }

    // MARK: Bridge entry points

    func connectSocket(params: DMPMap, appId: String, appVersion: String, callback: DMPBridgeCallback?) {
        queue.async { [weak self] in
            self?.handleConnect(params: params, appId: appId, appVersion: appVersion, callback: callback)
        }
    }

    func sendSocketMessage(params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        queue.async { [weak self] in self?.handleSend(params: params, appId: appId, callback: callback) }
    }

    func closeSocket(params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        queue.async { [weak self] in self?.handleClose(params: params, appId: appId, callback: callback) }
    }

    func onSocketEvent(event: DMPWebSocketEventType, params: DMPMap, appId: String, callback: DMPBridgeCallback? = nil) {
        queue.async { [weak self] in self?.handleOn(event: event, params: params, appId: appId, callback: callback) }
    }

    func offSocketEvent(event: DMPWebSocketEventType, params: DMPMap, appId: String, callback: DMPBridgeCallback? = nil) {
        queue.async { [weak self] in self?.handleOff(event: event, params: params, appId: appId, callback: callback) }
    }

    // MARK: connectSocket

    private func handleConnect(params: DMPMap, appId: String, appVersion: String, callback: DMPBridgeCallback?) {
        let owner = getOrCreateOwner(appId: appId)

        // 1. background
        if owner.backgrounded {
            fail(callback, api: Api.connect, tail: DMPWebSocketValidation.ErrorTail.interrupted)
            return
        }
        // 2. socketId presence + uniqueness
        guard let socketId = params.getString(key: "socketId"), !socketId.isEmpty, owner.sockets[socketId] == nil else {
            fail(callback, api: Api.connect, tail: DMPWebSocketValidation.ErrorTail.invalidSocketId)
            return
        }
        // 3. concurrency cap
        guard owner.sockets.count < Self.maxConnectionsPerOwner else {
            fail(callback, api: Api.connect, tail: DMPWebSocketValidation.ErrorTail.reachMaxCount)
            return
        }
        // 4. url
        let urlResult = DMPWebSocketValidation.validateUrl(params.get("url"))
        guard case let .success(url) = urlResult else {
            fail(callback, api: Api.connect, tail: urlResult.errorTail ?? DMPWebSocketValidation.ErrorTail.invalidUrl)
            return
        }
        // 5. timeout
        let timeoutResult = DMPWebSocketValidation.validateTimeout(params.get("timeout"))
        guard case let .success(timeoutMs) = timeoutResult else {
            fail(callback, api: Api.connect, tail: timeoutResult.errorTail ?? DMPWebSocketValidation.ErrorTail.invalidTimeout)
            return
        }
        // 6. protocols
        let protocolsResult = DMPWebSocketValidation.validateProtocols(params.get("protocols"))
        guard case let .success(protocols) = protocolsResult else {
            fail(callback, api: Api.connect, tail: protocolsResult.errorTail ?? DMPWebSocketValidation.ErrorTail.protocolsNotArray)
            return
        }
        // 7. header
        let headerResult = DMPWebSocketValidation.validateHeader(params.get("header"))
        guard case let .success(callerHeader) = headerResult else {
            fail(callback, api: Api.connect, tail: headerResult.errorTail ?? DMPWebSocketValidation.ErrorTail.headerNotObject)
            return
        }
        // 8. 容器自己的 Referer：调用方传的那份已经在校验里被丢掉了，这里补上固定值。
        var header = callerHeader
        header["Referer"] = DMPWebSocketValidation.refererValue(appId: appId, appVersion: appVersion)

        // 9. all checks passed: register, bind legacy, ack, then dial.
        let entry = DMPSocketEntry(socketId: socketId)
        entry.timeoutMs = timeoutMs
        entry.profile.fetchStart = scheduling.now()
        owner.sockets[socketId] = entry

        if owner.legacyBoundSocketId == nil || owner.sockets[owner.legacyBoundSocketId!] == nil {
            owner.legacyBoundSocketId = socketId
        }

        succeed(callback, api: Api.connect)

        var request = URLRequest(url: url)
        for (name, value) in header {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if !protocols.isEmpty {
            request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
        }

        // URLRequest 的 timeoutInterval 默认 60 秒，调用方要求更长时会被 Foundation 先掐断。
        // 这里跟着请求值走，并留一点余量，让容器自己的 connectTimer 始终先到，Foundation
        // 的超时只当兜底——否则两个超时同时到点，最终报的是哪一条错误就不确定了。
        request.timeoutInterval = Double(timeoutMs) / 1000.0 + 1

        entry.connectTimer = scheduling.schedule(after: Double(timeoutMs) / 1000.0) { [weak self] in
            self?.queue.async { self?.handleConnectTimeout(appId: appId, socketId: socketId) }
        }

        // Queue the actual dial as a follow-up tick on this same serial
        // queue so a close() for this socketId arriving right behind
        // connect() observes CREATED and can cancel before any I/O.
        queue.async { [weak self] in
            self?.performDial(appId: appId, socketId: socketId, request: request)
        }
    }

    private func performDial(appId: String, socketId: String, request: URLRequest) {
        guard let owner = owners[appId],
              let entry = owner.sockets[socketId],
              !entry.cancelled,
              entry.state == .created
        else {
            return
        }
        entry.state = .connecting
        let transport = transportFactory.makeTransport(delegate: self)
        entry.transport = transport
        transportKeys[ObjectIdentifier(transport)] = (appId, socketId)
        transport.connect(request: request)
    }

    private func handleConnectTimeout(appId: String, socketId: String) {
        guard let owner = owners[appId], let entry = owner.sockets[socketId] else { return }
        guard entry.state == .created || entry.state == .connecting else { return }
        killTransport(entry)
        teardown(owner: owner, appId: appId, entry: entry, event: .error,
                 payload: DMPMap(["errMsg": "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.timedOut)"]))
    }

    // MARK: sendSocketMessage

    private enum DMPWebSocketFrame {
        case text(String)
        case binary(Data)
    }

    private func validateSendFrame(_ params: DMPMap) -> DMPWebSocketValidation.Result<DMPWebSocketFrame> {
        let isBuffer = params.getBool(key: "isBuffer") ?? false
        if isBuffer {
            guard let base64 = params.getString(key: "data"), let data = Data(base64Encoded: base64) else {
                return .failure(DMPWebSocketValidation.ErrorTail.dataMustBeStringOrBuffer)
            }
            return .success(.binary(data))
        }
        guard let text = params.getString(key: "data") else {
            return .failure(DMPWebSocketValidation.ErrorTail.dataMustBeStringOrBuffer)
        }
        return .success(.text(text))
    }

    private func handleSend(params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let owner = getOrCreateOwner(appId: appId)

        if owner.backgrounded {
            fail(callback, api: Api.send, tail: DMPWebSocketValidation.ErrorTail.interrupted)
            return
        }

        let isLegacy = !DMPWebSocketValidation.hasSocketId(params)
        let targetSocketId: String? = isLegacy ? owner.legacyBoundSocketId : params.getString(key: "socketId")

        guard let socketId = targetSocketId, let entry = owner.sockets[socketId], entry.state == .open else {
            fail(callback, api: Api.send, tail: DMPWebSocketValidation.ErrorTail.notConnected)
            return
        }

        let frameResult = validateSendFrame(params)
        guard case let .success(frame) = frameResult else {
            fail(callback, api: Api.send, tail: frameResult.errorTail ?? DMPWebSocketValidation.ErrorTail.dataMustBeStringOrBuffer)
            return
        }

        let completion: (Error?) -> Void = { [weak self] error in
            guard let self else { return }
            self.queue.async {
                // A send completion can land long after the caller moved on - the transport reports
                // cancellation asynchronously once the connection is torn down. If the owner is gone
                // the JS context went with it, so there is nobody left to call back.
                guard let liveOwner = self.owners[appId], liveOwner === owner else { return }
                if let error {
                    self.fail(callback, api: Api.send, tail: error.localizedDescription)
                    return
                }
                // Only a confirmed-successful send counts as outbound traffic for
                // idle-timer purposes, matching Android/HarmonyOS. The timer may only be rearmed
                // while this entry is still the live, open connection for its socket - rescheduling
                // on an entry that was already removed would keep it alive until the timeout fires.
                if let liveEntry = liveOwner.sockets[socketId], liveEntry === entry, liveEntry.state == .open {
                    self.resetIdleTimerIfNeeded(entry: liveEntry, appId: appId)
                }
                self.succeed(callback, api: Api.send)
            }
        }

        switch frame {
        case let .text(text):
            entry.transport?.send(text: text, completion: completion)
        case let .binary(data):
            entry.transport?.send(data: data, completion: completion)
        }
    }

    // MARK: closeSocket

    private func handleClose(params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        let owner = getOrCreateOwner(appId: appId)

        if owner.backgrounded {
            fail(callback, api: Api.close, tail: DMPWebSocketValidation.ErrorTail.interrupted)
            return
        }

        let isLegacy = !DMPWebSocketValidation.hasSocketId(params)
        let targetSocketId: String? = isLegacy ? owner.legacyBoundSocketId : params.getString(key: "socketId")
        let targetEntry: DMPSocketEntry? = targetSocketId.flatMap { owner.sockets[$0] }

        // Existence and "already closing/closed" must be checked BEFORE
        // code/reason for BOTH task and legacy mode — an invalid code/reason
        // must never preempt the mandatory "not connected" (+ legacy-sweep)
        // path. Matches Android's combined `entry == null || entry.state ==
        // CLOSING` guard, which runs before its own code/reason validation.
        let notConnected = targetEntry == nil
            || targetEntry?.state == .closing || targetEntry?.state == .closed
        guard !notConnected, let socketId = targetSocketId, let entry = targetEntry else {
            fail(callback, api: Api.close, tail: DMPWebSocketValidation.ErrorTail.notConnected)
            if isLegacy {
                sweepCloseRemaining(owner: owner, appId: appId, excluding: nil)
            }
            return
        }

        let codeResult = DMPWebSocketValidation.validateCloseCode(params.get("code"))
        guard case let .success(code) = codeResult else {
            fail(callback, api: Api.close, tail: codeResult.errorTail ?? DMPWebSocketValidation.ErrorTail.invalidCode)
            // The legacy sweep of every other bound socket is mandatory
            // regardless of the addressed target's own outcome — an invalid
            // code/reason on the bound target must not skip it (matches
            // Android/HarmonyOS, which sweep unconditionally).
            if isLegacy {
                sweepCloseRemaining(owner: owner, appId: appId, excluding: socketId)
            }
            return
        }
        let reasonResult = DMPWebSocketValidation.validateCloseReason(params.get("reason"))
        guard case let .success(reason) = reasonResult else {
            fail(callback, api: Api.close, tail: reasonResult.errorTail ?? DMPWebSocketValidation.ErrorTail.reasonMustBeString)
            if isLegacy {
                sweepCloseRemaining(owner: owner, appId: appId, excluding: socketId)
            }
            return
        }

        switch performClose(owner: owner, appId: appId, entry: entry, code: code, reason: reason) {
        case .success:
            succeed(callback, api: Api.close)
        case let .failure(tail):
            fail(callback, api: Api.close, tail: tail)
        }

        if isLegacy {
            sweepCloseRemaining(owner: owner, appId: appId, excluding: socketId)
        }
    }

    /// Pure state-machine transition for a single socket's close — never
    /// touches the one-shot callback (used both by the direct close path
    /// and by the legacy sweep, which has no callback of its own to fire).
    private func performClose(owner: DMPOwnerState, appId: String, entry: DMPSocketEntry, code: Int, reason: String) -> DMPWebSocketValidation.Result<Void> {
        switch entry.state {
        case .created:
            // Dial hasn't run yet, settle purely locally.
            entry.cancelled = true
            teardown(owner: owner, appId: appId, entry: entry, event: .close,
                     payload: DMPMap(["code": code, "reason": reason]))
            return .success(())
        case .connecting:
            // No need to complete a real close handshake.
            killTransport(entry)
            teardown(owner: owner, appId: appId, entry: entry, event: .close,
                     payload: DMPMap(["code": code, "reason": reason]))
            return .success(())
        case .open:
            entry.state = .closing
            entry.requestedClose = (code, reason)
            entry.transport?.close(code: code, reason: reason.data(using: .utf8))
            return .success(())
        case .closing, .closed:
            // Collapse repeated close on an already-closing socket.
            return .failure(DMPWebSocketValidation.ErrorTail.notConnected)
        }
    }

    /// Legacy closeSocket sweep: regardless of whether the bound target
    /// itself was alive or dead, every other still-live socket on this
    /// owner gets closed with default parameters.
    private func sweepCloseRemaining(owner: DMPOwnerState, appId: String, excluding socketId: String?) {
        let remaining = owner.sockets.values.filter { $0.socketId != socketId }
        for entry in remaining {
            _ = performClose(owner: owner, appId: appId, entry: entry,
                              code: DMPWebSocketValidation.defaultCloseCode, reason: "")
        }
    }

    // MARK: on* / off*

    /// Every `on*`/`off*` completes `callback` exactly once, so the bridge call has a
    /// definite outcome on the fe side like every other API here. There is no user-facing
    /// success/fail in WeChat's on/off semantics; fe's `createSocketEvent` sends these with
    /// `keep: true` and no success/fail/complete of its own, so nothing on that side is
    /// waiting on the result.
    private func legacyApiName(event: DMPWebSocketEventType, isOn: Bool) -> String {
        let suffix: String
        switch event {
        case .open: suffix = "SocketOpen"
        case .message: suffix = "SocketMessage"
        case .error: suffix = "SocketError"
        case .close: suffix = "SocketClose"
        }
        return (isOn ? "on" : "off") + suffix
    }

    private func handleOn(event: DMPWebSocketEventType, params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        defer { succeed(callback, api: legacyApiName(event: event, isOn: true)) }
        let owner = getOrCreateOwner(appId: appId)
        guard let callbackId = params.getString(key: "callback"), !callbackId.isEmpty else { return }

        if DMPWebSocketValidation.hasSocketId(params) {
            guard let socketId = params.getString(key: "socketId"), !socketId.isEmpty else { return }
            if let entry = owner.sockets[socketId] {
                if !(entry.listeners[event] ?? []).contains(callbackId) {
                    entry.listeners[event, default: []].append(callbackId)
                }
                // wx.connectSocket 一返回，原生就立刻开始拨号；调用方紧接着才会把这条
                // onSocketOpen 注册消息发过桥。本机回环握手可能只要几毫秒，比这条注册
                // 消息更快到达，导致原生派发 open 事件时监听器列表还是空的，事件就永久
                // 丢失。这里在注册时补一次判断：连接已经 OPEN 且之前存过 open 载荷，就
                // 立刻把它推给刚注册的这个 callback id，结果不再取决于两条消息谁先到。
                if event == .open, entry.state == .open, let openPayload = entry.openPayload {
                    pushEvent(appId: appId, callbackId: callbackId, payload: openPayload)
                }
            }
            // error/close 是终态：entry 一旦进入终态就从 sockets 里删掉了，上面这条
            // "entry 还在就补发" 的路径对它们必然落空，只能靠 owner 级别的终态记录补。
            if event == .error || event == .close,
               let replay = owner.terminalReplay["\(socketId)|\(event.rawValue)"] {
                pushEvent(appId: appId, callbackId: callbackId, payload: replay)
            }
        } else {
            if !(owner.legacySlots[event] ?? []).contains(callbackId) {
                owner.legacySlots[event, default: []].append(callbackId)
            }
        }
    }

    private func handleOff(event: DMPWebSocketEventType, params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        defer { succeed(callback, api: legacyApiName(event: event, isOn: false)) }
        let owner = getOrCreateOwner(appId: appId)

        if DMPWebSocketValidation.hasSocketId(params) {
            guard let socketId = params.getString(key: "socketId"), let entry = owner.sockets[socketId] else { return }
            if let cb = params.getString(key: "callback"), !cb.isEmpty {
                entry.listeners[event]?.removeAll { $0 == cb }
            } else {
                // The script layer always sends the id of the listener it wants removed, even for
                // `off()` with no argument - it walks its own table and sends one request per id.
                // A request with no id can still arrive from a direct bridge caller, and clearing
                // the whole event is the only sensible reading of it.
                entry.listeners[event] = []
            }
        } else {
            // fe does export the global wx.offSocketOpen/offSocketMessage/offSocketError/
            // offSocketClose, so this path is reachable and must behave like the task-mode one:
            // an explicit id removes exactly that listener, a missing one clears the event.
            if let cb = params.getString(key: "callback"), !cb.isEmpty {
                owner.legacySlots[event]?.removeAll { $0 == cb }
            } else {
                owner.legacySlots[event] = []
            }
        }
    }

    // MARK: Transport delegate plumbing

    private func activeEntry(for transport: DMPSocketTransport) -> (owner: DMPOwnerState, entry: DMPSocketEntry, appId: String)? {
        let key = ObjectIdentifier(transport)
        guard let (appId, socketId) = transportKeys[key] else { return nil }
        guard let owner = owners[appId], let entry = owner.sockets[socketId], entry.transport === transport else {
            transportKeys.removeValue(forKey: key)
            return nil
        }
        return (owner, entry, appId)
    }

    private func handleTransportOpen(_ transport: DMPSocketTransport, headers: [String: String]) {
        guard let (owner, entry, appId) = activeEntry(for: transport), entry.state == .connecting else { return }
        entry.state = .open
        entry.opened = true
        entry.responseHeader = headers
        entry.profile.openedAt = scheduling.now()
        entry.connectTimer?.cancel()
        entry.connectTimer = nil
        startIdleTimerIfNeeded(entry: entry, appId: appId)

        let payload = DMPMap([
            "header": headers,
            "profile": entry.profile.toDictionary(),
        ])
        entry.openPayload = payload
        dispatchEvent(owner: owner, appId: appId, entry: entry, event: .open, payload: payload)
    }

    /// A message racing in right before/during the close handshake must
    /// still be delivered (Android/HarmonyOS/`dimina-kit` all do this) —
    /// only a connection that's CREATED/CONNECTING (never opened) has
    /// nothing to deliver to.
    private func canDeliverMessage(_ entry: DMPSocketEntry) -> Bool {
        return entry.state == .open || entry.state == .closing
    }

    private func handleTransportMessage(_ transport: DMPSocketTransport, text: String) {
        guard let (owner, entry, appId) = activeEntry(for: transport), canDeliverMessage(entry) else { return }
        resetIdleTimerIfNeeded(entry: entry, appId: appId)
        dispatchEvent(owner: owner, appId: appId, entry: entry, event: .message, payload: DMPMap(["data": text]))
    }

    private func handleTransportMessage(_ transport: DMPSocketTransport, data: Data) {
        guard let (owner, entry, appId) = activeEntry(for: transport), canDeliverMessage(entry) else { return }
        resetIdleTimerIfNeeded(entry: entry, appId: appId)
        let payload = DMPMap(["data": data.base64EncodedString(), "isBuffer": true])
        dispatchEvent(owner: owner, appId: appId, entry: entry, event: .message, payload: payload)
    }

    private func handleTransportClose(_ transport: DMPSocketTransport, code: Int, reason: Data?) {
        guard let (owner, entry, appId) = activeEntry(for: transport) else { return }
        let wireReason = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""

        if let requested = entry.requestedClose {
            // Client-initiated close always reports the caller's own
            // code/reason, regardless of what the wire echoed back.
            teardown(owner: owner, appId: appId, entry: entry, event: .close,
                     payload: DMPMap(["code": requested.code, "reason": requested.reason]))
        } else if entry.opened {
            teardown(owner: owner, appId: appId, entry: entry, event: .close,
                     payload: DMPMap(["code": code, "reason": wireReason]))
        } else {
            // A connection that never opened may only ever receive error,
            // never close.
            teardown(owner: owner, appId: appId, entry: entry, event: .error,
                     payload: DMPMap(["errMsg": "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.connectionFailed)"]))
        }
    }

    private func handleTransportComplete(_ transport: DMPSocketTransport, error: Error?) {
        guard let (owner, entry, appId) = activeEntry(for: transport) else { return }

        guard let error else {
            // A nil-error completion with no matching didClose already
            // handled means this was our own abrupt cancel(); nothing left
            // to report (the entry should already be gone by then, but stay
            // defensive in case the task delegate ordering surprises us).
            return
        }

        if entry.state == .closing, let requested = entry.requestedClose {
            teardown(owner: owner, appId: appId, entry: entry, event: .close,
                     payload: DMPMap(["code": requested.code, "reason": requested.reason]))
            return
        }

        if !entry.opened {
            let message = normalizeConnectError(error)
            teardown(owner: owner, appId: appId, entry: entry, event: .error, payload: DMPMap(["errMsg": message]))
            return
        }

        // Opened connection, genuine network failure: error is not terminal
        // by itself, immediately followed by close.
        let message = normalizeConnectError(error)
        dispatchEvent(owner: owner, appId: appId, entry: entry, event: .error, payload: DMPMap(["errMsg": message]))
        teardown(owner: owner, appId: appId, entry: entry, event: .close,
                 payload: DMPMap(["code": 1006, "reason": (error as NSError).localizedDescription]))
    }

    private func normalizeConnectError(_ error: Error) -> String {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorTimedOut {
            return "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.timeout)"
        }
        let message = nsError.localizedDescription
        if message.range(of: "time.?out", options: [.regularExpression, .caseInsensitive]) != nil {
            return "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.timeout)"
        }
        if message.isEmpty {
            return "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.connectionFailed)"
        }
        return "\(Api.connect):fail \(message)"
    }

    // MARK: Idle timeout

    private func startIdleTimerIfNeeded(entry: DMPSocketEntry, appId: String) {
        guard idleTimeoutMs > 0 else { return }
        scheduleIdleTimer(entry: entry, appId: appId)
    }

    private func resetIdleTimerIfNeeded(entry: DMPSocketEntry, appId: String) {
        guard idleTimeoutMs > 0 else { return }
        entry.idleTimer?.cancel()
        scheduleIdleTimer(entry: entry, appId: appId)
    }

    private func scheduleIdleTimer(entry: DMPSocketEntry, appId: String) {
        let socketId = entry.socketId
        entry.idleTimer = scheduling.schedule(after: Double(idleTimeoutMs) / 1000.0) { [weak self] in
            self?.queue.async { self?.handleIdleTimeout(appId: appId, socketId: socketId) }
        }
    }

    private func handleIdleTimeout(appId: String, socketId: String) {
        guard let owner = owners[appId], let entry = owner.sockets[socketId], entry.state == .open else { return }
        killTransport(entry)
        teardown(owner: owner, appId: appId, entry: entry, event: .close,
                 payload: DMPMap(["code": 1006, "reason": "idle timeout"]))
    }

    // MARK: Shared teardown / emit helpers

    private func getOrCreateOwner(appId: String) -> DMPOwnerState {
        if let existing = owners[appId] { return existing }
        let owner = DMPOwnerState()
        owners[appId] = owner
        if globallyBackgrounded {
            // The owner is brand-new (no sockets yet), so there is nothing
            // for the grace timer to act on yet; this only ensures the
            // upcoming connect/send/close calls see backgrounded == true
            // instead of wrongly succeeding during the background window.
            setBackgrounded(appId: appId, backgrounded: true)
        }
        return owner
    }

    private func unregisterTransport(_ entry: DMPSocketEntry) {
        if let transport = entry.transport {
            transportKeys.removeValue(forKey: ObjectIdentifier(transport))
        }
        entry.transport = nil
    }

    /// Proactively (client/host-driven) kill the underlying connection.
    private func killTransport(_ entry: DMPSocketEntry) {
        entry.transport?.abort()
        unregisterTransport(entry)
    }

    /// Removes the entry, cancels its timers and unregisters the transport,
    /// then dispatches `event` to its task-scoped listeners and (if it is
    /// the legacy-bound socket) the matching legacy slot. Terminal — use for
    /// close/error events that end the connection's life.
    private func teardown(owner: DMPOwnerState, appId: String, entry: DMPSocketEntry, event: DMPWebSocketEventType, payload: DMPMap) {
        if event == .error || event == .close {
            recordTerminalEvent(owner: owner, socketId: entry.socketId, event: event, payload: payload)
        }
        let taskListeners = entry.listeners[event] ?? []
        let legacyCallbackIds = (owner.legacyBoundSocketId == entry.socketId) ? (owner.legacySlots[event] ?? []) : []

        owner.sockets.removeValue(forKey: entry.socketId)
        entry.connectTimer?.cancel()
        entry.connectTimer = nil
        entry.idleTimer?.cancel()
        entry.idleTimer = nil
        if event == .error { entry.errorEmitted = true }
        unregisterTransport(entry)

        for callbackId in taskListeners {
            pushEvent(appId: appId, callbackId: callbackId, payload: payload)
        }
        for callbackId in legacyCallbackIds {
            pushEvent(appId: appId, callbackId: callbackId, payload: payload)
        }
    }

    /// Same dispatch as `teardown`, but the entry stays alive (open/message,
    /// or the non-terminal error preceding an opened connection's close).
    private func dispatchEvent(owner: DMPOwnerState, appId: String, entry: DMPSocketEntry, event: DMPWebSocketEventType, payload: DMPMap) {
        if event == .error || event == .close {
            recordTerminalEvent(owner: owner, socketId: entry.socketId, event: event, payload: payload)
        }
        if event == .error { entry.errorEmitted = true }
        let taskListeners = entry.listeners[event] ?? []
        for callbackId in taskListeners {
            pushEvent(appId: appId, callbackId: callbackId, payload: payload)
        }
        if owner.legacyBoundSocketId == entry.socketId {
            for callbackId in owner.legacySlots[event] ?? [] {
                pushEvent(appId: appId, callbackId: callbackId, payload: payload)
            }
        }
    }

    /// 记录一次终态事件（error/close）载荷，供之后才注册的监听补发（见 handleOn）。
    /// 按插入顺序保留最近 terminalReplayCapacity 条，超出容量淘汰最旧的一条；同一个
    /// key 再次触发时先移除旧位置再重新追加，保证淘汰顺序始终对应"最近一次触发"。
    private func recordTerminalEvent(owner: DMPOwnerState, socketId: String, event: DMPWebSocketEventType, payload: DMPMap) {
        let key = "\(socketId)|\(event.rawValue)"
        if owner.terminalReplay.removeValue(forKey: key) != nil {
            owner.terminalReplayOrder.removeAll { $0 == key }
        }
        owner.terminalReplay[key] = payload
        owner.terminalReplayOrder.append(key)
        while owner.terminalReplayOrder.count > Self.terminalReplayCapacity {
            let oldest = owner.terminalReplayOrder.removeFirst()
            owner.terminalReplay.removeValue(forKey: oldest)
        }
    }

    /// disposeOwner / background-grace "already-errored handshake" reclaim:
    /// removes bookkeeping only, no events.
    private func silentlyRemove(owner: DMPOwnerState, entry: DMPSocketEntry) {
        owner.sockets.removeValue(forKey: entry.socketId)
        entry.connectTimer?.cancel()
        entry.connectTimer = nil
        entry.idleTimer?.cancel()
        entry.idleTimer = nil
        killTransport(entry)
    }

    // MARK: One-shot callback helpers

    private func fail(_ callback: DMPBridgeCallback?, api: String, tail: String) {
        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(api):fail \(tail)")
    }

    private func succeed(_ callback: DMPBridgeCallback?, api: String) {
        DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(["errMsg": "\(api):ok"]))
    }

    // MARK: Persistent event push

    /// Test-only interception point for persistent event delivery. There is
    /// no seam to fake a real DMPApp + JSContext short of standing up the
    /// whole runtime, so DMPWebSocketManagerTests injects this closure to
    /// capture emitted (appId, callbackId, payload) tuples directly. Always
    /// nil in production; when nil, pushEvent takes the real
    /// DMPAppManager/DMPChannelProxy path.
    var eventSinkForTest: ((_ appId: String, _ callbackId: String, _ payload: DMPMap) -> Void)?

    private func pushEvent(appId: String, callbackId: String, payload: DMPMap) {
        if let sink = eventSinkForTest {
            sink(appId, callbackId, payload)
            return
        }
        guard let app = DMPAppManager.sharedInstance().existApp(appId: appId) else { return }
        let message = DMPMap([
            "type": "triggerCallback",
            "body": ["id": callbackId, "args": payload.toDictionary()],
        ])
        DMPChannelProxy.containerToService(msg: message, app: app)
    }
}

extension DMPWebSocketManager: DMPSocketTransportDelegate {
    func transportDidOpen(_ transport: DMPSocketTransport, headers: [String: String]) {
        queue.async { [weak self] in self?.handleTransportOpen(transport, headers: headers) }
    }

    func transport(_ transport: DMPSocketTransport, didReceiveText text: String) {
        queue.async { [weak self] in self?.handleTransportMessage(transport, text: text) }
    }

    func transport(_ transport: DMPSocketTransport, didReceiveData data: Data) {
        queue.async { [weak self] in self?.handleTransportMessage(transport, data: data) }
    }

    func transport(_ transport: DMPSocketTransport, didCloseWithCode code: Int, reason: Data?) {
        queue.async { [weak self] in self?.handleTransportClose(transport, code: code, reason: reason) }
    }

    func transport(_ transport: DMPSocketTransport, didCompleteWithError error: Error?) {
        queue.async { [weak self] in self?.handleTransportComplete(transport, error: error) }
    }
}
