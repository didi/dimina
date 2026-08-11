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

/// The handshake phase boundaries a transport measured, in milliseconds since epoch (the unit
/// `DMPWebSocketScheduling.now()` uses). A nil field means that phase did not happen or was not
/// measured — a reused connection performs no DNS lookup, for instance — and the profile falls
/// back to the previous boundary for it.
struct DMPSocketHandshakeMetrics {
    var domainLookupStart: Double?
    var domainLookupEnd: Double?
    var connectStart: Double?
    var connectEnd: Double?
}

protocol DMPSocketTransportDelegate: AnyObject {
    func transportDidOpen(_ transport: DMPSocketTransport, headers: [String: String])
    func transport(_ transport: DMPSocketTransport, didReceiveText text: String)
    func transport(_ transport: DMPSocketTransport, didReceiveData data: Data)
    func transport(_ transport: DMPSocketTransport, didCloseWithCode code: Int, reason: Data?)
    func transport(_ transport: DMPSocketTransport, didCompleteWithError error: Error?)
    /// Reports the measured DNS/TCP phase boundaries. `URLSession` delivers these while the task
    /// is still running — a probe against a server that delays its 101 response shows
    /// `didFinishCollecting` landing ~2 ms *before* `didOpenWithProtocol` — so the numbers are
    /// available in time to go into the open event's `profile`.
    func transport(_ transport: DMPSocketTransport, didCollectHandshakeMetrics metrics: DMPSocketHandshakeMetrics)
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

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        transport(for: task)?.handleMetrics(metrics)
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

    /// The metrics for the HTTP transaction that carried the upgrade. Only the last transaction
    /// matters: an intermediate redirect's DNS/connect timings describe a different endpoint.
    fileprivate func handleMetrics(_ metrics: URLSessionTaskMetrics) {
        guard let transaction = metrics.transactionMetrics.last else { return }
        func epochMs(_ date: Date?) -> Double? {
            return date.map { $0.timeIntervalSince1970 * 1000 }
        }
        delegate?.transport(self, didCollectHandshakeMetrics: DMPSocketHandshakeMetrics(
            domainLookupStart: epochMs(transaction.domainLookupStartDate),
            domainLookupEnd: epochMs(transaction.domainLookupEndDate),
            connectStart: epochMs(transaction.connectStartDate),
            connectEnd: epochMs(transaction.connectEndDate)
        ))
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

/// Which API surface a listener was registered through. The two surfaces receive different open
/// payloads, so every delivery has to say which one it is headed for — see `projectedPayload`.
enum DMPSocketListenerScope {
    /// `SocketTask.onOpen` / `onMessage` / `onError` / `onClose`.
    case task
    /// The global `wx.onSocketOpen` / `onSocketMessage` / `onSocketError` / `onSocketClose`.
    case global
}

final class DMPOwnerState {
    var sockets: [String: DMPSocketEntry] = [:]
    var legacyBoundSocketId: String?
    /// Ordered, de-duplicated listener ids for the global `wx.onSocketXxx` API. Same shape as
    /// `DMPSocketEntry.listeners`. The current script layer registers exactly one callback id per
    /// event and fans the event out to the business listeners itself, so in that path the array
    /// holds a single id; keeping an array rather than one slot is what lets a caller that
    /// registers several *distinct* ids - a host extension, or a direct bridge caller - have all
    /// of them delivered, rather than each registration replacing the last. Registering the same
    /// id twice still collapses to one delivery.
    var legacySlots: [DMPWebSocketEventType: [String]] = [:]
    var backgrounded: Bool = false
    var graceTimer: DMPWebSocketCancellable?
    /// 已经派发过的终态事件（error/close）载荷，键是 "socketId|event"。连接一进入
    /// 终态，entry 就从 sockets 里删掉了，之后到达的监听注册再也找不到它；而
    /// wx.connectSocket 一返回原生就立刻开始拨号，连本机地址被拒绝都可能比调用方的
    /// onSocketError/onSocketClose 注册消息更早到达（实测早 1 毫秒），这个事件就会
    /// 永久丢失。这里按插入顺序在 owner 级别保留最近若干条终态事件，注册时补发一次。
    var terminalReplay: [String: DMPTerminalEvent] = [:]
    /// terminalReplay 的插入顺序（Dictionary 本身无序），用于容量超限时淘汰最旧的一条。
    var terminalReplayOrder: [String] = []
}

struct DMPWebSocketProfile {
    var fetchStart: Double?
    var openedAt: Double?
    /// The DNS/TCP boundaries the transport measured, reported before the open event fires.
    var handshakeMetrics: DMPSocketHandshakeMetrics?

    /// The DNS and connect phases are measurements, not restatements of `fetchStart`:
    /// `rtt` covers the connect phase alone, `handshakeCost` the WebSocket upgrade that follows
    /// it, and `cost` the whole attempt. Each boundary falls back to the previous one when the
    /// phase was not measured, which is also what happens when a transport reports no metrics at
    /// all — the eight fields stay present and numeric either way.
    func toDictionary() -> [String: Any] {
        let fetchStart = self.fetchStart ?? 0
        let openedAt = self.openedAt ?? fetchStart
        let domainLookUpStart = handshakeMetrics?.domainLookupStart ?? fetchStart
        let domainLookUpEnd = handshakeMetrics?.domainLookupEnd ?? domainLookUpStart
        let connectStart = handshakeMetrics?.connectStart ?? domainLookUpEnd
        let connectEnd = handshakeMetrics?.connectEnd ?? openedAt
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
    /// Whether this connection accepted a global `wx.closeSocket` request. The transport state
    /// cannot distinguish that route from `SocketTask.close()`; this flag controls global rebinding.
    var closedByGlobalApi = false
    var connectTimer: DMPWebSocketCancellable?
    var idleTimer: DMPWebSocketCancellable?
    /// 单调递增的 idle 定时器代际。每次调度新的 idle 定时器（或显式取消旧的）都会推进它；
    /// `scheduling.schedule` 把回调投进 `queue` 之后，取消动作撤不回已经排队的那个闭包，
    /// 只能让它到达 `handleIdleTimeout` 时比对代际、发现自己手里的值已经过期，静默作废。
    var idleGeneration: Int = 0
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
    /// 已经收到过本代 open 事件的 callback id；正常派发和迟到补发共用，保证同一 id 只收到一次。
    var openDeliveredCallbackIds: Set<String> = []

    init(socketId: String) {
        self.socketId = socketId
    }
}

/// 一条已经派发过的终态事件：载荷本身，外加已经收到过它的 callback id。正常派发和迟到
/// 补发写同一份名单，因此正常收到事件的 id 重复注册时也不会再收到陈旧补发。这份名单跟着
/// 记录一起被 `terminalReplay` 的容量淘汰。
final class DMPTerminalEvent {
    let payload: DMPMap
    var deliveredCallbackIds: Set<String> = []

    init(payload: DMPMap) {
        self.payload = payload
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

    /// `appNetworkTimeoutMs` is this mini program's `app.json` `networkTimeout.connectSocket`;
    /// `nil` means the key is absent and the 60000 default applies. The container reads it out of
    /// the parsed app config and hands it over the same way it hands over `appVersion`.
    func connectSocket(params: DMPMap, appId: String, appVersion: String,
                       appNetworkTimeoutMs: Int? = nil, callback: DMPBridgeCallback?) {
        queue.async { [weak self] in
            self?.handleConnect(params: params, appId: appId, appVersion: appVersion,
                                appNetworkTimeoutMs: appNetworkTimeoutMs, callback: callback)
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

    private func handleConnect(params: DMPMap, appId: String, appVersion: String,
                               appNetworkTimeoutMs: Int?, callback: DMPBridgeCallback?) {
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
        // 3. 官方上限统计所有尚未终态的连接，包含 created、connecting、open 和 closing。
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
        let timeoutResult = DMPWebSocketValidation.validateTimeout(params.get("timeout"),
                                                                   appDefaultMs: appNetworkTimeoutMs)
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
        // socketId 只要求当前没有同名存活连接，因此终态后的 id 可以复用。新连接已经全部
        // 校验通过后，旧连接留下的 error/close 不能再被这代监听误认为自己的事件。
        clearTerminalReplay(owner: owner, socketId: socketId)
        let entry = DMPSocketEntry(socketId: socketId)
        entry.timeoutMs = timeoutMs
        entry.profile.fetchStart = scheduling.now()
        owner.sockets[socketId] = entry

        // The global wx.onSocket* / sendSocketMessage / closeSocket surface follows the oldest
        // connection that has not reached CLOSED yet, and a new connect is the only moment the
        // binding may move. "Not CLOSED" is the service layer's question, so it goes through
        // isClosedToService — a connection the caller already closed has handed the binding over
        // even while its transport is still winding down.
        let boundHasHandedOver = owner.legacyBoundSocketId
            .map { isClosedToService(owner: owner, socketId: $0) } ?? true
        if boundHasHandedOver {
            owner.legacyBoundSocketId = socketId
        }

        succeed(callback, api: Api.connect)

        var request = URLRequest(url: url)
        for (name, value) in dialableHeaderFields(header) {
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

    /// The header fields to put on the dial, with field names that differ only in case collapsed to
    /// one deterministic winner.
    ///
    /// The validated header keeps every spelling the caller wrote — WeChat does not fold request
    /// header case and neither does this container. `URLRequest` does: measured against a server
    /// that dumps the raw request head, `setValue`, a whole-dictionary `allHTTPHeaderFields`
    /// assignment, and `URLSessionConfiguration.httpAdditionalHeaders` all emit exactly one field
    /// for `X-Dimina-Case` + `x-dimina-case` (and `addValue` folds them into one comma-joined
    /// value, which is a different header again). There is no entry point on
    /// `URLSessionWebSocketTask` that takes an ordered, case-preserving field list, so on this
    /// platform "send both" is not expressible — see the PR's known limitations.
    ///
    /// What is fully in our hands is *which* one survives. Feeding a `[String: String]` straight to
    /// `setValue` let dictionary iteration order pick the winner, so the very same call sent
    /// `upper` on one run and `lower` on the next. Collapsing here by lowercased name and keeping
    /// the lexicographically smallest spelling makes the outcome a property of the caller's input
    /// alone. Names that do not collide keep their spelling exactly as written.
    private func dialableHeaderFields(_ header: [String: String]) -> [(name: String, value: String)] {
        var winnerByLowercasedName: [String: String] = [:]
        for name in header.keys {
            let key = name.lowercased()
            if let existing = winnerByLowercasedName[key] {
                if name < existing { winnerByLowercasedName[key] = name }
                DMPLogger.debug("WebSocket header \(key) supplied in multiple spellings; URLRequest carries one")
            } else {
                winnerByLowercasedName[key] = name
            }
        }
        return winnerByLowercasedName.values
            .sorted()
            .map { (name: $0, value: header[$0] ?? "") }
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
        // The same errMsg the transport's own timeout reports (see normalizeConnectError). A
        // connection that ran out of time is one outcome as far as a mini program is concerned;
        // which of the two clocks noticed first is an implementation detail it cannot branch on.
        teardown(owner: owner, appId: appId, entry: entry, event: .error,
                 payload: DMPMap(["errMsg": "\(Api.connect):fail \(DMPWebSocketValidation.ErrorTail.timeout)"]))
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
                if error != nil {
                    // One fixed English string, never the NSError's localizedDescription: that text
                    // is translated into the device's language, so passing it through would make the
                    // same failure read differently per phone and no errMsg comparison a mini
                    // program writes could hold. Android and HarmonyOS report this same string.
                    self.fail(callback, api: Api.send, tail: DMPWebSocketValidation.ErrorTail.notConnected)
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

        // wx.closeSocket 的官方示例要求在 wx.onSocketOpen 之后调用。全局入口只处理已打开的
        // 绑定连接；任务入口仍可取消 created/connecting 状态下的自身连接。
        let notConnected = targetEntry == nil
            || targetEntry?.state == .closing || targetEntry?.state == .closed
            || (isLegacy && targetEntry?.state != .open)
        guard !notConnected, let entry = targetEntry else {
            fail(callback, api: Api.close, tail: DMPWebSocketValidation.ErrorTail.notConnected)
            return
        }

        let codeResult = DMPWebSocketValidation.validateCloseCode(params.get("code"))
        guard case let .success(code) = codeResult else {
            fail(callback, api: Api.close, tail: codeResult.errorTail ?? DMPWebSocketValidation.ErrorTail.invalidCode)
            return
        }
        let reasonResult = DMPWebSocketValidation.validateCloseReason(params.get("reason"))
        guard case let .success(reason) = reasonResult else {
            fail(callback, api: Api.close, tail: reasonResult.errorTail ?? DMPWebSocketValidation.ErrorTail.reasonMustBeString)
            return
        }

        switch performClose(owner: owner, appId: appId, entry: entry, code: code, reason: reason,
                            fromGlobalApi: isLegacy) {
        case .success:
            succeed(callback, api: Api.close)
        case let .failure(tail):
            fail(callback, api: Api.close, tail: tail)
        }
    }

    /// Pure state-machine transition for a single socket's close; never touches the one-shot callback.
    ///
    /// `fromGlobalApi` says which door the caller came through, which is what decides whether this
    /// connection hands the global binding over (see `isClosedToService`).
    private func performClose(owner: DMPOwnerState, appId: String, entry: DMPSocketEntry, code: Int, reason: String,
                              fromGlobalApi: Bool) -> DMPWebSocketValidation.Result<Void> {
        // Record the entry route before changing transport state so later connect calls can decide
        // whether the global binding has handed over.
        if fromGlobalApi {
            entry.closedByGlobalApi = true
        }

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
            if let entry = owner.sockets[socketId], !(entry.listeners[event] ?? []).contains(callbackId) {
                entry.listeners[event, default: []].append(callbackId)
            }
            replayMissedEvent(owner: owner, appId: appId, socketId: socketId, event: event,
                              callbackId: callbackId, scope: .task)
        } else {
            if !(owner.legacySlots[event] ?? []).contains(callbackId) {
                owner.legacySlots[event, default: []].append(callbackId)
            }
            // 全局态的补发对象是当前 legacy 绑定的那条连接；没有绑定就没有可补的事件。
            if let boundSocketId = owner.legacyBoundSocketId {
                replayMissedEvent(owner: owner, appId: appId, socketId: boundSocketId, event: event,
                                  callbackId: callbackId, scope: .global)
            }
        }
    }

    /// 把注册时已经错过的事件补发给 `callbackId`。wx.connectSocket 一返回，原生就立刻
    /// 开始拨号；调用方紧接着才会把 onSocketXxx 注册消息发过桥。本机回环握手或连接被拒
    /// 可能只要几毫秒，比这条注册消息更快到达，导致派发时监听器列表还是空的，事件就永久
    /// 丢失。open 取 `socketId` 那条连接自己保存的载荷；error / close 是终态，那时条目
    /// 早已从 `sockets` 删掉，只能取 owner 的终态记录。
    ///
    /// 两条记录各自记着已经实际投递过的 callback id，正常派发和补发共用，所以同一个 id
    /// 即使在正常收到事件后又直接向桥重复注册，也不会收到第二份陈旧事件。message 不补发。
    private func replayMissedEvent(owner: DMPOwnerState, appId: String, socketId: String,
                                   event: DMPWebSocketEventType, callbackId: String,
                                   scope: DMPSocketListenerScope) {
        switch event {
        case .open:
            guard let entry = owner.sockets[socketId], entry.state == .open,
                  let payload = entry.openPayload else { return }
            guard entry.openDeliveredCallbackIds.insert(callbackId).inserted else { return }
            pushEvent(appId: appId, callbackId: callbackId,
                      payload: projectedPayload(payload, event: event, scope: scope))
        case .error, .close:
            guard let record = owner.terminalReplay["\(socketId)|\(event.rawValue)"] else { return }
            guard record.deliveredCallbackIds.insert(callbackId).inserted else { return }
            pushEvent(appId: appId, callbackId: callbackId,
                      payload: projectedPayload(record.payload, event: event, scope: scope))
        case .message:
            break
        }
    }

    /// `off` 结束一次监听生命周期，同时回收这次生命周期在事件投递账本里的 id。逻辑层后续
    /// 重新注册会生成新的 callback id；及时移除旧 id，避免长连接反复 on/off 时集合无界增长。
    private func forgetDeliveredCallback(owner: DMPOwnerState, socketId: String, event: DMPWebSocketEventType, callbackId: String) {
        let deliveredIds: Set<String>?
        switch event {
        case .open:
            deliveredIds = owner.sockets[socketId]?.openDeliveredCallbackIds
        case .error, .close:
            deliveredIds = owner.terminalReplay["\(socketId)|\(event.rawValue)"]?.deliveredCallbackIds
        case .message:
            deliveredIds = nil
        }
        guard var ids = deliveredIds else { return }
        if callbackId.isEmpty {
            ids.removeAll()
        } else {
            ids.remove(callbackId)
        }
        switch event {
        case .open:
            owner.sockets[socketId]?.openDeliveredCallbackIds = ids
        case .error, .close:
            owner.terminalReplay["\(socketId)|\(event.rawValue)"]?.deliveredCallbackIds = ids
        case .message:
            break
        }
    }

    private func handleOff(event: DMPWebSocketEventType, params: DMPMap, appId: String, callback: DMPBridgeCallback?) {
        defer { succeed(callback, api: legacyApiName(event: event, isOn: false)) }
        let owner = getOrCreateOwner(appId: appId)
        let callbackId = params.getString(key: "callback") ?? ""

        if DMPWebSocketValidation.hasSocketId(params) {
            guard let socketId = params.getString(key: "socketId") else { return }
            if let entry = owner.sockets[socketId] {
                if callbackId.isEmpty {
                    // Public wx/SocketTask has no off API. A bridge-private rollback carries an id;
                    // a direct compatibility call without one clears the event.
                    entry.listeners[event] = []
                } else {
                    entry.listeners[event]?.removeAll { $0 == callbackId }
                }
            }
            forgetDeliveredCallback(owner: owner, socketId: socketId, event: event, callbackId: callbackId)
        } else {
            // Bridge-private compatibility path: an explicit id removes exactly that listener,
            // while a missing id clears the event.
            if callbackId.isEmpty {
                owner.legacySlots[event] = []
            } else {
                owner.legacySlots[event]?.removeAll { $0 == callbackId }
            }
            if let boundSocketId = owner.legacyBoundSocketId {
                forgetDeliveredCallback(owner: owner, socketId: boundSocketId, event: event, callbackId: callbackId)
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

    private func handleTransportMetrics(_ transport: DMPSocketTransport, metrics: DMPSocketHandshakeMetrics) {
        guard let (_, entry, _) = activeEntry(for: transport) else { return }
        entry.profile.handshakeMetrics = metrics
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
        //
        // The close is synthesised locally — no close frame ever arrived — so there is no peer
        // reason to quote and `reason` stays empty. That is both the honest answer and what
        // RFC 6455 describes for a locally-generated 1006, which carries no reason. It must not
        // become the error's localizedDescription: `reason` is a business-visible field of the
        // close payload, so OS text translated per device would break it the same way it breaks
        // errMsg (see normalizeConnectError).
        let message = normalizeConnectError(error)
        dispatchEvent(owner: owner, appId: appId, entry: entry, event: .error, payload: DMPMap(["errMsg": message]))
        teardown(owner: owner, appId: appId, entry: entry, event: .close,
                 payload: DMPMap(["code": 1006, "reason": ""]))
    }

    /// Maps a transport error onto one of the container's own fixed English strings.
    ///
    /// The choice is made **only** from structured fields — the error's domain and code. It must
    /// never be made from the error's text: `NSError.localizedDescription` is translated into the
    /// device's language, so both quoting it and pattern-matching it would let the phone's language
    /// decide what a mini program reads. Matching text is the subtler of the two mistakes — it
    /// leaks no foreign words into errMsg, yet still classifies one and the same failure
    /// differently per locale.
    ///
    /// Anything not recognised structurally reports the same generic string as the sibling path
    /// where the peer closes before the upgrade completes. The raw error goes to the log instead.
    private func normalizeConnectError(_ error: Error) -> String {
        let nsError = error as NSError
        DMPLogger.debug("WebSocket transport failure [\(nsError.domain) \(nsError.code)] \(nsError.localizedDescription)")

        let isTimeout = (nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut)
            || (nsError.domain == NSPOSIXErrorDomain && nsError.code == Int(ETIMEDOUT))
        let tail = isTimeout
            ? DMPWebSocketValidation.ErrorTail.timeout
            : DMPWebSocketValidation.ErrorTail.connectionFailed
        return "\(Api.connect):fail \(tail)"
    }

    // MARK: Idle timeout

    private func startIdleTimerIfNeeded(entry: DMPSocketEntry, appId: String) {
        guard idleTimeoutMs > 0 else { return }
        scheduleIdleTimer(entry: entry, appId: appId)
    }

    private func resetIdleTimerIfNeeded(entry: DMPSocketEntry, appId: String) {
        guard idleTimeoutMs > 0 else { return }
        cancelIdleTimer(entry)
        scheduleIdleTimer(entry: entry, appId: appId)
    }

    private func scheduleIdleTimer(entry: DMPSocketEntry, appId: String) {
        let socketId = entry.socketId
        entry.idleGeneration += 1
        let generation = entry.idleGeneration
        entry.idleTimer = scheduling.schedule(after: Double(idleTimeoutMs) / 1000.0) { [weak self] in
            self?.queue.async { self?.handleIdleTimeout(appId: appId, socketId: socketId, generation: generation) }
        }
    }

    /// 取消 entry 的 idle 定时器（若有）。所有显式取消的地方都必须走这里而不是直接调
    /// `idleTimer?.cancel()`——`cancel()` 只能拦住尚未触发的调度本身，拦不住已经经
    /// `queue.async` 排进队列的那个闭包；推进 `DMPSocketEntry.idleGeneration` 让那个
    /// 迟到的闭包在 `handleIdleTimeout` 里比对代际时发现自己已经过期，静默作废。
    private func cancelIdleTimer(_ entry: DMPSocketEntry) {
        entry.idleTimer?.cancel()
        entry.idleTimer = nil
        entry.idleGeneration += 1
    }

    private func handleIdleTimeout(appId: String, socketId: String, generation: Int) {
        guard let owner = owners[appId], let entry = owner.sockets[socketId] else { return }
        guard generation == entry.idleGeneration else { return }
        guard entry.state == .open else { return }
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

    /// Transport-layer question: is this connection still holding one of the owner's concurrency
    /// slots — is the wire still there? A slot is taken at the open event and given back when the
    /// terminal (close/error) event arrives, so a CLOSING connection **still holds one**: its
    /// transport has not released anything yet, and the peer may take a full round trip to answer
    /// (or never answer).
    ///
    /// Whether the global binding target has handed over. A CLOSING transport may come from either
    /// close entry point, so transport state alone cannot answer this routing question.
    private func isClosedToService(owner: DMPOwnerState, socketId: String) -> Bool {
        guard let entry = owner.sockets[socketId] else { return true }
        return entry.closedByGlobalApi
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
        let terminalRecord = (event == .error || event == .close)
            ? recordTerminalEvent(owner: owner, socketId: entry.socketId, event: event, payload: payload)
            : nil
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
            pushEventOnce(appId: appId, entry: entry, event: event, terminalRecord: terminalRecord,
                          callbackId: callbackId, payload: payload, scope: .task)
        }
        for callbackId in legacyCallbackIds {
            pushEventOnce(appId: appId, entry: entry, event: event, terminalRecord: terminalRecord,
                          callbackId: callbackId, payload: payload, scope: .global)
        }
    }

    /// Same dispatch as `teardown`, but the entry stays alive (open/message,
    /// or the non-terminal error preceding an opened connection's close).
    private func dispatchEvent(owner: DMPOwnerState, appId: String, entry: DMPSocketEntry, event: DMPWebSocketEventType, payload: DMPMap) {
        let terminalRecord = (event == .error || event == .close)
            ? recordTerminalEvent(owner: owner, socketId: entry.socketId, event: event, payload: payload)
            : nil
        if event == .error { entry.errorEmitted = true }
        let taskListeners = entry.listeners[event] ?? []
        for callbackId in taskListeners {
            pushEventOnce(appId: appId, entry: entry, event: event, terminalRecord: terminalRecord,
                          callbackId: callbackId, payload: payload, scope: .task)
        }
        if owner.legacyBoundSocketId == entry.socketId {
            for callbackId in owner.legacySlots[event] ?? [] {
                pushEventOnce(appId: appId, entry: entry, event: event, terminalRecord: terminalRecord,
                              callbackId: callbackId, payload: payload, scope: .global)
            }
        }
    }

    /// 按作用域投影事件载荷：`SocketTask.onOpen` 收 `{header, profile}`，全局
    /// `wx.onSocketOpen` 只收 `{header}`。两个作用域的结果类型是分开声明的，全局那个
    /// 没有 profile 成员，把任务态的载荷原样交给全局监听等于凭空多出一个不存在的 API 面。
    /// 其余事件两个作用域形状相同，原样返回。
    ///
    /// 正常派发（`pushEventOnce`）与迟到补发（`replayMissedEvent`）都必须过这里：这两条
    /// 路径各自造自己的投递，只在其中一条上做投影，泄漏会从另一条继续跑出去。
    private func projectedPayload(_ payload: DMPMap, event: DMPWebSocketEventType,
                                  scope: DMPSocketListenerScope) -> DMPMap {
        guard event == .open, scope == .global else { return payload }
        return DMPMap(["header": payload.get("header") ?? [String: String]()])
    }

    /// 正常派发和迟到补发必须共享同一份投递账本；否则一个已经正常收到事件的 callback id
    /// 再次注册时，会被 replay 路径误判成从未收到而拿到第二份陈旧事件。
    private func pushEventOnce(appId: String, entry: DMPSocketEntry, event: DMPWebSocketEventType,
                               terminalRecord: DMPTerminalEvent?, callbackId: String, payload: DMPMap,
                               scope: DMPSocketListenerScope) {
        switch event {
        case .open:
            guard entry.openDeliveredCallbackIds.insert(callbackId).inserted else { return }
        case .error, .close:
            guard let terminalRecord,
                  terminalRecord.deliveredCallbackIds.insert(callbackId).inserted else { return }
        case .message:
            break
        }
        pushEvent(appId: appId, callbackId: callbackId,
                  payload: projectedPayload(payload, event: event, scope: scope))
    }

    /// 记录一次终态事件（error/close）载荷，供之后才注册的监听补发（见 handleOn）。
    /// 按插入顺序保留最近 terminalReplayCapacity 条，超出容量淘汰最旧的一条；同一个
    /// key 再次触发时先移除旧位置再重新追加，保证淘汰顺序始终对应"最近一次触发"。
    private func recordTerminalEvent(owner: DMPOwnerState, socketId: String, event: DMPWebSocketEventType, payload: DMPMap) -> DMPTerminalEvent {
        let key = "\(socketId)|\(event.rawValue)"
        if owner.terminalReplay.removeValue(forKey: key) != nil {
            owner.terminalReplayOrder.removeAll { $0 == key }
        }
        let record = DMPTerminalEvent(payload: payload)
        owner.terminalReplay[key] = record
        owner.terminalReplayOrder.append(key)
        while owner.terminalReplayOrder.count > Self.terminalReplayCapacity {
            let oldest = owner.terminalReplayOrder.removeFirst()
            owner.terminalReplay.removeValue(forKey: oldest)
        }
        return record
    }

    /// 新一代同 socketId 连接开始前，移除上一代连接留下的终态补发记录及其顺序索引。
    private func clearTerminalReplay(owner: DMPOwnerState, socketId: String) {
        let keys = ["\(socketId)|error", "\(socketId)|close"]
        for key in keys {
            owner.terminalReplay.removeValue(forKey: key)
        }
        owner.terminalReplayOrder.removeAll { keys.contains($0) }
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

    // `complete` fires on either outcome and must describe the outcome it completes, so it gets the
    // same result object success/fail got — `complete: res => res.errMsg` is the ordinary shape and
    // an empty object hands the caller undefined.
    private func fail(_ callback: DMPBridgeCallback?, api: String, tail: String) {
        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(api):fail \(tail)",
                                      completeCarriesResult: true)
    }

    private func succeed(_ callback: DMPBridgeCallback?, api: String) {
        DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(["errMsg": "\(api):ok"]),
                                      completeCarriesResult: true)
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

    func transport(_ transport: DMPSocketTransport, didCollectHandshakeMetrics metrics: DMPSocketHandshakeMetrics) {
        queue.async { [weak self] in self?.handleTransportMetrics(transport, metrics: metrics) }
    }
}
