//
//  DMPWebSocketManagerTests.swift
//  DiminaKitTests
//
//  Covers concurrency limits, lifecycle/event mutual exclusion, close races,
//  background policy, legacy binding and disposeOwner. Uses a scripted
//  FakeTransport/FakeTransportFactory and a manually-advanced FakeScheduling
//  clock so every race is deterministic (no real networking, no real sleep).

import XCTest
@testable import dimina

final class DMPWebSocketManagerTests: XCTestCase {

    private func makeManager() -> (DMPWebSocketManager, FakeTransportFactory, FakeScheduling) {
        let factory = FakeTransportFactory()
        let scheduling = FakeScheduling()
        let manager = DMPWebSocketManager(transportFactory: factory, scheduling: scheduling,
                                           queue: DispatchQueue(label: "dmp-ws-test-\(UUID().uuidString)"))
        return (manager, factory, scheduling)
    }

    /// The Manager may re-enqueue follow-up work onto its own serial queue
    /// from within a handler that is itself already running on that queue
    /// (e.g. connect() -> handleConnect -> performDial, or an
    /// auto-acked close -> handleClose -> handleTransportClose). Draining
    /// repeatedly guarantees any such nested hop has fully settled before we
    /// assert, regardless of submission-order timing races.
    private func drain(_ manager: DMPWebSocketManager, times: Int = 5) {
        for _ in 0..<times { manager.drainForTesting() }
    }

    private func url() -> DMPMap { DMPMap(["socketId": "s1", "url": "wss://example.com/socket"]) }

    // MARK: connectSocket basics + concurrency

    func test_connect_success_firesSuccessImmediately_andDials() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()
        let params = DMPMap(["socketId": "s1", "url": "wss://example.com/socket", "header": ["X-Test": "1"]])

        manager.connectSocket(params: params, appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok")
        XCTAssertEqual(recorder.completeCount, 1)
        XCTAssertEqual(factory.createdTransports.count, 1)
        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, "wss://example.com/socket")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Test"), "1")
        // Origin 不由容器补：微信文档对 header 只规定「不能设置 Referer」，没说会注入 Origin。
        XCTAssertNil(request?.value(forHTTPHeaderField: "Origin"))
    }

    // MARK: URLRequest timeoutInterval

    // URLRequest 的 timeoutInterval 默认 60 秒；调用方传的 timeout 若超过这个值，
    // Foundation 会在容器自己的 connectTimer 之前就把连接掐断，容器看到的会是传输层
    // 错误而不是 `connectSocket:fail timed out`。这里断言 timeoutInterval 始终跟随
    // 请求的 timeout 走（多留 1 秒余量），不管调用方传的默认值还是超过 60 秒的值。
    func test_connect_requestTimeoutIntervalTracksDefaultTimeout() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.timeoutInterval ?? -1, 61, accuracy: 0.001)
    }

    func test_connect_requestTimeoutIntervalTracksCustomTimeoutBeyondSixtySeconds() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()
        let params = DMPMap(["socketId": "s1", "url": "wss://example.com/socket", "timeout": 120_000])

        manager.connectSocket(params: params, appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.timeoutInterval ?? -1, 121, accuracy: 0.001)
    }

    // MARK: container-injected header

    func test_connect_dialCarriesContainerReferer() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: url(), appId: "app1", appVersion: "37", callback: recorder.makeCallback())
        drain(manager)

        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Referer"),
                       "https://servicedimina.com/app1/37/page-frame.html")
    }

    func test_connect_callerSuppliedRefererIsReplacedByTheContainerOne() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()
        let params = DMPMap(["socketId": "s1", "url": "wss://example.com/socket",
                             "header": ["Referer": "https://evil.example/"]])

        manager.connectSocket(params: params, appId: "app1", appVersion: "37", callback: recorder.makeCallback())
        drain(manager)

        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Referer"),
                       "https://servicedimina.com/app1/37/page-frame.html")
    }

    func test_connect_unknownAppVersionFallsBackToZero() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: url(), appId: "app1", appVersion: "", callback: recorder.makeCallback())
        drain(manager)

        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Referer"),
                       "https://servicedimina.com/app1/0/page-frame.html")
    }

    func test_connect_invalidSocketId_missingOrDuplicate() {
        let (manager, _, _) = makeManager()
        let missing = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: missing.makeCallback())
        drain(manager)
        XCTAssertEqual(missing.lastErrMsg, "connectSocket:fail invalid socketId")

        let first = CallbackRecorder()
        let second = CallbackRecorder()
        let params = DMPMap(["socketId": "dup", "url": "wss://example.com/socket"])
        manager.connectSocket(params: params, appId: "app1", appVersion: "0", callback: first.makeCallback())
        drain(manager)
        manager.connectSocket(params: params, appId: "app1", appVersion: "0", callback: second.makeCallback())
        drain(manager)
        XCTAssertEqual(second.lastErrMsg, "connectSocket:fail invalid socketId")
    }

    func test_connect_maxConcurrencyPerOwner_isolatedAcrossOwners() {
        let (manager, _, _) = makeManager()
        for index in 0..<5 {
            let recorder = CallbackRecorder()
            manager.connectSocket(params: DMPMap(["socketId": "s\(index)", "url": "wss://example.com/socket"]),
                             appId: "app1", appVersion: "0", callback: recorder.makeCallback())
            drain(manager)
            XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok")
        }

        let overflow = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: overflow.makeCallback())
        drain(manager)
        XCTAssertEqual(overflow.lastErrMsg, "connectSocket:fail reach max websocket connect count 5")

        let otherOwner = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "t0", "url": "wss://example.com/socket"]),
                         appId: "app2", appVersion: "0", callback: otherOwner.makeCallback())
        drain(manager)
        XCTAssertEqual(otherOwner.lastSuccessErrMsg, "connectSocket:ok", "owners must not share the concurrency slot pool")
    }

    func test_connect_slotFreedAfterClose() {
        let (manager, _, _) = makeManager()
        for index in 0..<5 {
            let recorder = CallbackRecorder()
            manager.connectSocket(params: DMPMap(["socketId": "s\(index)", "url": "wss://example.com/socket"]),
                             appId: "app1", appVersion: "0", callback: recorder.makeCallback())
            drain(manager)
        }
        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s0"]), appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")

        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok", "closing a socket must free its concurrency slot")
    }

    // MARK: lifecycle + event mutual exclusion

    func test_lifecycle_openDeliversHeaderAndProfile_thenTextAndBinaryMessages() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        let connectRecorder = CallbackRecorder()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: connectRecorder.makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "cbOpen"]), appId: "app1")
        manager.onSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "cbMessage"]), appId: "app1")
        drain(manager)

        guard let transport = factory.createdTransports.first else { return XCTFail("no transport dialed") }
        transport.simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        let openEvents = events.filter { $0.callbackId == "cbOpen" }
        XCTAssertEqual(openEvents.count, 1)
        XCTAssertEqual(openEvents.first?.payload.get("header") as? [String: String], ["X-Resp": "1"])
        let profile = openEvents.first?.payload.get("profile") as? [String: Any]
        XCTAssertNotNil(profile?["fetchStart"])
        XCTAssertNotNil(profile?["cost"])

        transport.simulateText("hello")
        let binary = Data([0x01, 0x02, 0x03])
        transport.simulateData(binary)
        drain(manager)

        let messages = events.filter { $0.callbackId == "cbMessage" }
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].payload.get("data") as? String, "hello")
        XCTAssertNil(messages[0].payload.get("isBuffer"))
        XCTAssertEqual(messages[1].payload.get("data") as? String, binary.base64EncodedString())
        XCTAssertEqual(messages[1].payload.get("isBuffer") as? Bool, true)
    }

    func test_lifecycle_serverCloseAfterOpen_deliversWireCodeAndReason() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)

        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.delegate?.transport(transport, didCloseWithCode: 1001, reason: "bye".data(using: .utf8))
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty, "an opened-then-server-closed socket must not also error")
        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 1001)
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "bye")
    }

    func test_lifecycle_handshakeFailure_onlyErrorNeverClose() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)

        let transport = factory.createdTransports[0]
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                             userInfo: [NSLocalizedDescriptionKey: "cannot connect"])
        transport.simulateFailure(error)
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "cbClose" }.isEmpty, "a connection that never opened must never receive close")
        let errorEvents = events.filter { $0.callbackId == "cbError" }
        XCTAssertEqual(errorEvents.count, 1)
        XCTAssertEqual(errorEvents.first?.payload.get("errMsg") as? String, "connectSocket:fail cannot connect")
    }

    // MARK: close validation + races

    func test_close_rejectsInvalidCodeAndOverlongReason() {
        let (manager, _, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let badCode = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1", "code": 5000]), appId: "app1", callback: badCode.makeCallback())
        drain(manager)
        XCTAssertEqual(badCode.lastErrMsg, "closeSocket:fail invalid code")

        let badReason = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1", "reason": String(repeating: "a", count: 124)]),
                             appId: "app1", callback: badReason.makeCallback())
        drain(manager)
        XCTAssertEqual(badReason.lastErrMsg, "closeSocket:fail reason must not exceed 123 UTF-8 bytes")
    }

    func test_closeRace_createdState_noNetworkTouch_exactlyOneClose() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        let connectRecorder = CallbackRecorder()
        let closeRecorder = CallbackRecorder()
        // Fired back-to-back with no drain in between so close() lands while
        // the entry is still CREATED (dial not yet performed).
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: connectRecorder.makeCallback())
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        manager.closeSocket(params: DMPMap(["socketId": "s1", "code": 3001, "reason": "gone"]),
                             appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)

        XCTAssertTrue(factory.createdTransports.isEmpty, "dial must never touch the network for a same-tick close")
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")
        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty)
        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 3001)
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "gone")
    }

    func test_closeRace_connectingState_abortsTransport_exactlyOneClose() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager) // let the dial actually happen: transport created, state == .connecting
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(factory.createdTransports.count, 1)

        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1", "code": 3002, "reason": "gone2"]),
                             appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)

        XCTAssertEqual(factory.createdTransports.first?.abortCallCount, 1)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")
        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty)
        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 3002)
    }

    func test_close_openState_reportsCallerValuesRegardlessOfWireEcho() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        // Server would echo a *different* close code/reason; we always
        // report the caller's own values regardless.
        transport.autoAckClose = false
        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1", "code": 3005, "reason": "caller reason"]),
                             appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")
        XCTAssertTrue(events.filter { $0.callbackId == "cbClose" }.isEmpty, "close event must wait for the real transport ack")

        transport.delegate?.transport(transport, didCloseWithCode: 1000, reason: "server reason".data(using: .utf8))
        drain(manager)

        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 3005)
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "caller reason")
    }

    func test_closeBeforeOpen_reportsGenericErrorAndNeverLeaksTheWireReason() {
        // The reason on a pre-handshake close is entirely the server's to pick. It must not become
        // part of the API-level error string - all three platforms report the generic text here.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)

        let transport = factory.createdTransports[0]
        transport.delegate?.transport(transport, didCloseWithCode: 1002, reason: "policy denied".data(using: .utf8))
        drain(manager)

        let errorEvents = events.filter { $0.callbackId == "cbError" }
        XCTAssertEqual(errorEvents.count, 1)
        XCTAssertEqual(errorEvents.first?.payload.get("errMsg") as? String, "connectSocket:fail WebSocket connection failed")
        XCTAssertTrue(events.filter { $0.callbackId == "cbClose" }.isEmpty, "a connection that never opened must never surface close")
    }

    /// closeSocket 的一次性回调必须先发 success 再发 complete。真机上出现过 JS 侧
    /// 先收到 complete 再收到 success，根因在容器往 service 投递消息那一层
    /// （DMPService.fromContainer 每条消息各起一个 Task，顺序被线程调度打乱），
    /// 这里把 Manager 这一层的发出顺序钉住，防止以后有人在 close 分支里把
    /// complete 提到 success 前面。
    func test_close_openState_firesSuccessBeforeComplete() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        var order: [String] = []
        manager.closeSocket(params: DMPMap(["socketId": "s1", "code": 1000]), appId: "app1") { _, type in
            switch type {
            case .success: order.append("success")
            case .fail: order.append("fail")
            case .complete: order.append("complete")
            }
        }
        drain(manager)

        XCTAssertEqual(order, ["success", "complete"])
    }

    func test_close_repeatedWhileClosing_failsNotConnected() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.autoAckClose = false // stays CLOSING, never acks

        let first = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: first.makeCallback())
        drain(manager)
        XCTAssertEqual(first.lastSuccessErrMsg, "closeSocket:ok")

        let second = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: second.makeCallback())
        drain(manager)
        XCTAssertEqual(second.lastErrMsg, "closeSocket:fail WebSocket is not connected")
    }

    // MARK: background/foreground policy

    func test_background_graceExpiry_openSocket_closesWithInterruptedCode() {
        let (manager, factory, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.setAllBackgrounded(true)
        drain(manager)
        scheduling.advance(by: 5)
        drain(manager)

        XCTAssertEqual(transport.abortCallCount, 1)
        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty)
        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 1006)
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "interrupted")

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "x"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(sendRecorder.lastErrMsg, "sendSocketMessage:fail interrupted")
    }

    func test_background_graceExpiry_handshakingSocket_onlyErrorNoClose() {
        let (manager, _, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager) // dial happens, but never opens
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)

        manager.setAllBackgrounded(true)
        drain(manager)
        scheduling.advance(by: 5)
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "cbClose" }.isEmpty)
        let errorEvents = events.filter { $0.callbackId == "cbError" }
        XCTAssertEqual(errorEvents.count, 1)
        XCTAssertEqual(errorEvents.first?.payload.get("errMsg") as? String, "connectSocket:fail interrupted")
    }

    func test_background_duringBackground_allThreeApisFailInterrupted() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateOpen()
        drain(manager)

        manager.setAllBackgrounded(true)
        drain(manager)

        let connectRecorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "other", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: connectRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(connectRecorder.lastErrMsg, "connectSocket:fail interrupted")

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "x"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(sendRecorder.lastErrMsg, "sendSocketMessage:fail interrupted")

        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastErrMsg, "closeSocket:fail interrupted")
    }

    func test_background_foregroundBeforeGrace_cancelsTeardown() {
        let (manager, factory, scheduling) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.setAllBackgrounded(true)
        drain(manager)
        scheduling.advance(by: 3) // before the 5s grace elapses
        manager.setAllBackgrounded(false)
        drain(manager)
        scheduling.advance(by: 5) // well past the original deadline; timer must have been cancelled
        drain(manager)

        XCTAssertEqual(transport.abortCallCount, 0)

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hi"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(sendRecorder.lastSuccessErrMsg, "sendSocketMessage:ok")
    }

    func test_background_newOwnerCreatedWhileBackgrounded_inheritsInterrupted() {
        let (manager, _, _) = makeManager()
        // No owner exists yet for "app2" when backgrounding starts.
        manager.setAllBackgrounded(true)
        drain(manager)

        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/socket"]), appId: "app2", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, "connectSocket:fail interrupted",
                        "a brand-new owner created after the app already backgrounded must not slip through as foregrounded")
    }

    // MARK: legacy global listener set (ordered, deduped) / first-live-connection binding
    //
    // Contract: the global (no-socketId) on*/off* slot per event is no
    // longer a single overwritable string — it is an ordered, deduped set of
    // callback ids, matching task-scoped `entry.listeners`. Registering two
    // distinct ids must deliver to both, in registration order; re-registering
    // the same id must not double-deliver; `off` with an explicit id removes
    // only that id; `off` with a missing/empty id clears every id for that
    // event. Binding itself (which single connection this global slot is
    // wired to) is unchanged and covered separately below.

    func test_legacy_multipleListeners_receiveInRegistrationOrder_open() {
        // Non-terminal event: goes through `dispatchEvent`, entry stays alive.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        let openEvents = events.filter { $0.callbackId == "first" || $0.callbackId == "second" }
        XCTAssertEqual(openEvents.map { $0.callbackId }, ["first", "second"],
                        "both legacy registrations must fire via dispatchEvent, in registration order, not silently overwrite")
    }

    func test_legacy_multipleListeners_receiveInRegistrationOrder_close() {
        // Terminal event: goes through `teardown`. Fired back-to-back with no
        // drain in between so closeSocket lands while the entry is still
        // CREATED (see test_closeRace_createdState_...), driving the close
        // through teardown rather than the transport delegate.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "cFirst"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "cSecond"]), appId: "app1")
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        XCTAssertTrue(factory.createdTransports.isEmpty, "sanity: dial must never have happened for this same-tick close")
        let closeEvents = events.filter { $0.callbackId == "cFirst" || $0.callbackId == "cSecond" }
        XCTAssertEqual(closeEvents.map { $0.callbackId }, ["cFirst", "cSecond"],
                        "both legacy close listeners must fire via teardown, in registration order")
    }

    func test_legacy_duplicateRegistration_dedupesWithoutDroppingOtherListener() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "A"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "B"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "A"]), appId: "app1") // re-registers A
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "A" }.count, 1, "re-registering the same id must not deliver twice")
        XCTAssertEqual(events.filter { $0.callbackId == "B" }.count, 1, "B must not have been silently dropped by A's re-registration")
        let ordered = events.filter { $0.callbackId == "A" || $0.callbackId == "B" }
        XCTAssertEqual(ordered.map { $0.callbackId }, ["A", "B"], "A keeps its original registration-order position; dedup must not move it to the end")
    }

    func test_legacy_handleOff_withCallbackId_removesOnlyThatListener() {
        // Off-ing the *second*-registered id (rather than the first) is the discriminating case:
        // a last-writer-wins slot would already have dropped the first id at registration time, so
        // off-ing the first id would trivially "pass" (it was never going to fire either way) even
        // against a compare-then-remove implementation that still gets the id-targeting wrong.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        manager.offSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertFalse(events.contains { $0.callbackId == "second" }, "handleOff with an explicit callback id must remove only that id")
        XCTAssertEqual(events.filter { $0.callbackId == "first" }.count, 1, "an unrelated (earlier-registered) id must remain registered and still fire")
    }

    func test_legacy_handleOff_missingCallbackId_clearsAllListenersForThatEvent() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        manager.offSocketEvent(event: .open, params: DMPMap([:]), appId: "app1") // no "callback" key at all
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "first" || $0.callbackId == "second" }.isEmpty,
                      "a missing callback id must clear every id registered on this event")
    }

    func test_legacy_handleOff_emptyCallbackId_clearsAllListenersForThatEvent() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        manager.offSocketEvent(event: .open, params: DMPMap(["callback": ""]), appId: "app1") // present but empty
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "first" || $0.callbackId == "second" }.isEmpty,
                      "an empty-string callback id must also clear every id registered on this event, same as a missing one")
    }

    func test_legacy_handleOff_onOneEvent_doesNotAffectOtherEvent() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "openCb"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "closeCb"]), appId: "app1")
        drain(manager)

        manager.offSocketEvent(event: .open, params: DMPMap([:]), appId: "app1")
        drain(manager)

        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        XCTAssertFalse(events.contains { $0.callbackId == "openCb" }, "clearing the open event's listeners must actually clear them")

        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "closeCb" }.count, 1, "clearing open listeners must not touch close listeners")
    }

    func test_legacy_disposeOwner_clearsAllGlobalListeners() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        manager.disposeOwner(appId: "app1")

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports.last?.simulateOpen()
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "first" || $0.callbackId == "second" }.isEmpty,
                      "disposeOwner must wipe every global legacy listener, not just the most recently registered one")
    }

    func test_legacy_firstLiveConnectionBinding_noDriftWhenOtherSocketCloses() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "legacyOpen"]), appId: "app1")
        drain(manager)

        // Closing "b" (not the bound target "a") must not disturb "a"'s binding.
        manager.closeSocket(params: DMPMap(["socketId": "b"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        factory.createdTransports[0].simulateOpen() // "a" dialed first
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "legacyOpen" }.count, 1)
    }

    func test_legacy_rebindsOnNextConnectOnlyWhenBoundIsDead() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.closeSocket(params: DMPMap(["socketId": "a"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "legacyOpen"]), appId: "app1")
        drain(manager)

        factory.createdTransports.last?.simulateOpen()
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "legacyOpen" }.count, 1)
    }

    func test_legacy_closeSocket_deadBinding_failsThenSweepsRemaining() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        manager.closeSocket(params: DMPMap(["socketId": "a"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "b", "callback": "bClose"]), appId: "app1")
        drain(manager)

        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap([:]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail WebSocket is not connected")
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 1, "the sweep must still close every other live socket")
        XCTAssertEqual(events.first { $0.callbackId == "bClose" }?.payload.get("code") as? Int, 1000)
        _ = factory
    }

    func test_legacy_closeSocket_deadBindingWithInvalidCode_stillFailsNotConnectedAndSweeps() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        manager.closeSocket(params: DMPMap(["socketId": "a"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "b", "callback": "bClose"]), appId: "app1")
        drain(manager)

        // "a" is already dead AND the caller also passed a deliberately
        // invalid code: existence must still win over code validation, or
        // the mandatory legacy sweep of every other live socket never runs.
        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["code": 5000]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail WebSocket is not connected",
                        "an invalid code must not preempt the dead-binding check")
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 1,
                        "the sweep must still run even though the dead binding's own close carried an invalid code")
        _ = factory
    }

    func test_legacy_closeSocket_closingBindingWithInvalidCode_stillFailsNotConnectedAndSweeps() {
        // Distinct from the "dead" (never-opened) binding tests above — here the bound target is
        // actually OPEN, gets moved to CLOSING by a first legacy close, and a SECOND legacy close
        // (with a deliberately invalid code) targets that still-CLOSING entry. This must also
        // collapse to not-connected before code validation runs, not just "entry gone".
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        for transport in factory.createdTransports { transport.simulateOpen() }
        drain(manager)

        // First legacy close moves the bound target ("a") to CLOSING (the fake transport never
        // fires its own close callback, so it stays CLOSING for the rest of this test).
        manager.closeSocket(params: DMPMap([:]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["code": 5000]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail WebSocket is not connected",
                        "a CLOSING (not just fully-gone) legacy target must also fail not-connected before code validation")
        _ = factory
    }

    func test_legacy_sendSocketMessage_targetsBoundSocketOnly() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        for transport in factory.createdTransports { transport.simulateOpen() }
        drain(manager)

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["data": "hello"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)

        XCTAssertEqual(sendRecorder.lastSuccessErrMsg, "sendSocketMessage:ok")
        XCTAssertEqual(factory.createdTransports[0].sentTexts, ["hello"])
        XCTAssertTrue(factory.createdTransports[1].sentTexts.isEmpty)
    }

    // MARK: on*/off* completion — the current script layer sends these with `keep: true` and only
    // a listener id, so it attaches no temp settler ids and this shape does not come from it.
    // Direct bridge callers (and older script builds, which routed on/off through
    // invokePromiseAPI) do attach them and wait; leaving them unanswered leaks the ids and hangs
    // the caller's Promise, so the handler must still answer.

    func test_onOff_registrationCompletesCallback_taskMode() {
        let (manager, _, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let onRecorder = CallbackRecorder()
        manager.onSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "cbMessage"]), appId: "app1", callback: onRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(onRecorder.lastSuccessErrMsg, "onSocketMessage:ok",
                        "a caller that attached temp settler ids must get one of them back, or those ids and its Promise leak forever")
        XCTAssertEqual(onRecorder.completeCount, 1)

        let offRecorder = CallbackRecorder()
        manager.offSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "cbMessage"]), appId: "app1", callback: offRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(offRecorder.lastSuccessErrMsg, "offSocketMessage:ok")
    }

    func test_onOff_registrationCompletesCallback_legacyMode() {
        let (manager, _, _) = makeManager()
        let onRecorder = CallbackRecorder()
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "legacyOpen"]), appId: "app1", callback: onRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(onRecorder.lastSuccessErrMsg, "onSocketOpen:ok")
    }

    func test_onOff_nullSocketId_routesToTaskModeNotLegacy() {
        // A present-but-null `socketId` must route as task mode (the wire contract branches on
        // key PRESENCE, not truthiness), not fall through to legacy mode via `getString` returning
        // nil for NSNull — which would silently overwrite/clear the real legacy slot from an
        // `on`/`off` call that was never actually addressed to it.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "legacySlot"]), appId: "app1")
        let onRecorder = CallbackRecorder()
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": NSNull(), "callback": "shouldNotOverwriteLegacy"]), appId: "app1", callback: onRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(onRecorder.lastSuccessErrMsg, "onSocketOpen:ok")

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertTrue(events.contains { $0.callbackId == "legacySlot" }, "a present-but-null socketId must not overwrite the legacy slot")
        XCTAssertFalse(events.contains { $0.callbackId == "shouldNotOverwriteLegacy" })
    }

    func test_legacy_closeSocket_liveBindingWithInvalidCode_stillSweepsRemaining() {
        // Distinct from the dead/CLOSING-target sweep tests above — here the bound target ("a")
        // is fully OPEN and live. Its own close attempt correctly fails on the invalid code, but
        // the mandatory sweep of every OTHER live legacy-bound socket must still run regardless of
        // the addressed target's own outcome (matches Android/HarmonyOS, which sweep
        // unconditionally after the direct close attempt, win or lose).
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        for transport in factory.createdTransports { transport.simulateOpen() }
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "b", "callback": "bClose"]), appId: "app1")
        drain(manager)

        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["code": 5000]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail invalid code")
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 1,
                        "the sweep must still close every other live socket even though the addressed live target's own close carried an invalid code")
    }

    // MARK: message delivery during CLOSING (Android/HarmonyOS/dimina-kit
    // all still deliver a message racing in during the close handshake)

    func test_message_arrivesDuringClosing_stillDelivered() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "cbMessage"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        transport.autoAckClose = false // stays CLOSING, never acks
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        // Server sends one last message right in the close-handshake window.
        transport.simulateText("last message")
        drain(manager)

        let messages = events.filter { $0.callbackId == "cbMessage" }
        XCTAssertEqual(messages.count, 1, "a message arriving while CLOSING must still be delivered, matching Android/HarmonyOS/dimina-kit")
        XCTAssertEqual(messages.first?.payload.get("data") as? String, "last message")
    }

    // MARK: disposeOwner

    func test_dispose_silentTeardown_noEventsFired_freshStateAfterwards() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.disposeOwner(appId: "app1")

        XCTAssertEqual(transport.abortCallCount, 1)
        XCTAssertTrue(events.isEmpty, "disposeOwner must be completely silent")

        let recorder = CallbackRecorder()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok", "the same appId must start from a clean slate")
    }

    // MARK: idle timeout

    func test_idleTimeout_resetsOnTrafficAndFiresWhenConfigured() {
        let (manager, factory, scheduling) = makeManager()
        manager.setIdleTimeoutMs(10_000)
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen() // t=0, idle timer armed to fire at t=10
        drain(manager)

        scheduling.advance(by: 6) // t=6, still under the window
        transport.simulateText("ping") // traffic resets the idle timer to fire at t=16
        drain(manager)
        scheduling.advance(by: 6) // t=12: would have fired at the old t=10 deadline if not reset
        drain(manager)
        XCTAssertTrue(events.filter { $0.callbackId == "cbClose" }.isEmpty, "traffic must have reset the idle timer")

        scheduling.advance(by: 5) // t=17: past the reset deadline (t=16)
        drain(manager)

        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1)
        XCTAssertEqual(closeEvents.first?.payload.get("code") as? Int, 1006)
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "idle timeout")
    }

    func test_idleTimeout_failedSendDoesNotResetTheTimer() {
        // The idle timer must only reset on a CONFIRMED-successful send, not merely on attempting
        // one - a failed send is not traffic.
        let (manager, factory, scheduling) = makeManager()
        manager.setIdleTimeoutMs(10_000)
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen() // t=0, idle timer armed to fire at t=10
        drain(manager)

        transport.sendResult = NSError(domain: "test", code: 1)
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        scheduling.advance(by: 10) // t=10: the original deadline must still apply, unaffected by the failed send
        drain(manager)

        let closeEvents = events.filter { $0.callbackId == "cbClose" }
        XCTAssertEqual(closeEvents.count, 1, "a failed send must not have pushed the idle deadline out")
        XCTAssertEqual(closeEvents.first?.payload.get("reason") as? String, "idle timeout")
    }

    // MARK: late send completions

    func test_send_completionLandingAfterDisposeOwner_isDroppedAndArmsNoTimer() {
        // The transport reports a cancelled send asynchronously, so a completion can land after the
        // app was destroyed. Calling back then would reach a JS context that is already gone, and
        // rearming the idle timer would keep the removed entry alive until the timeout fires.
        let (manager, factory, scheduling) = makeManager()
        manager.setIdleTimeoutMs(10_000)
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        transport.deferSendCompletions = true
        let recorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1", callback: recorder.makeCallback())
        drain(manager)

        manager.disposeOwner(appId: "app1")
        events.removeAll()
        transport.flushSendCompletions()
        drain(manager)

        XCTAssertNil(recorder.lastSuccessErrMsg, "a completion landing after disposeOwner has nowhere to report to")
        XCTAssertNil(recorder.lastErrMsg)
        XCTAssertEqual(recorder.completeCount, 0)

        scheduling.advance(by: 20)
        drain(manager)
        XCTAssertTrue(events.isEmpty, "no timer may outlive disposeOwner")
    }

    func test_send_completionLandingAfterClose_stillSettlesButRearmsNoIdleTimer() {
        // Unlike disposeOwner, an ordinary close leaves the JS context alive, so the caller's
        // callback still has to settle - it just must not resurrect the idle timer.
        let (manager, factory, scheduling) = makeManager()
        manager.setIdleTimeoutMs(10_000)
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        transport.deferSendCompletions = true
        let recorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1", callback: recorder.makeCallback())
        drain(manager)

        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        transport.flushSendCompletions()
        drain(manager)

        XCTAssertEqual(recorder.lastSuccessErrMsg, "sendSocketMessage:ok", "the caller is still around and must be settled")

        scheduling.advance(by: 20)
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "cbClose" }.count, 1, "the explicit close is the only close; no idle timeout may follow it")
    }
}
