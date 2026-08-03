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

        manager.connectSocket(params: params, appId: "app1", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok")
        XCTAssertEqual(recorder.completeCount, 1)
        XCTAssertEqual(factory.createdTransports.count, 1)
        let request = factory.createdTransports.first?.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, "wss://example.com/socket")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "X-Test"), "1")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Origin"), "https://example.com")
    }

    func test_connect_invalidSocketId_missingOrDuplicate() {
        let (manager, _, _) = makeManager()
        let missing = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["url": "wss://example.com/socket"]), appId: "app1", callback: missing.makeCallback())
        drain(manager)
        XCTAssertEqual(missing.lastErrMsg, "connectSocket:fail invalid socketId")

        let first = CallbackRecorder()
        let second = CallbackRecorder()
        let params = DMPMap(["socketId": "dup", "url": "wss://example.com/socket"])
        manager.connectSocket(params: params, appId: "app1", callback: first.makeCallback())
        drain(manager)
        manager.connectSocket(params: params, appId: "app1", callback: second.makeCallback())
        drain(manager)
        XCTAssertEqual(second.lastErrMsg, "connectSocket:fail invalid socketId")
    }

    func test_connect_maxConcurrencyPerOwner_isolatedAcrossOwners() {
        let (manager, _, _) = makeManager()
        for index in 0..<5 {
            let recorder = CallbackRecorder()
            manager.connectSocket(params: DMPMap(["socketId": "s\(index)", "url": "wss://example.com/socket"]),
                             appId: "app1", callback: recorder.makeCallback())
            drain(manager)
            XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok")
        }

        let overflow = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", callback: overflow.makeCallback())
        drain(manager)
        XCTAssertEqual(overflow.lastErrMsg, "connectSocket:fail reach max websocket connect count 5")

        let otherOwner = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "t0", "url": "wss://example.com/socket"]),
                         appId: "app2", callback: otherOwner.makeCallback())
        drain(manager)
        XCTAssertEqual(otherOwner.lastSuccessErrMsg, "connectSocket:ok", "owners must not share the concurrency slot pool")
    }

    func test_connect_slotFreedAfterClose() {
        let (manager, _, _) = makeManager()
        for index in 0..<5 {
            let recorder = CallbackRecorder()
            manager.connectSocket(params: DMPMap(["socketId": "s\(index)", "url": "wss://example.com/socket"]),
                             appId: "app1", callback: recorder.makeCallback())
            drain(manager)
        }
        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s0"]), appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")

        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok", "closing a socket must free its concurrency slot")
    }

    // MARK: lifecycle + event mutual exclusion

    func test_lifecycle_openDeliversHeaderAndProfile_thenTextAndBinaryMessages() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        let connectRecorder = CallbackRecorder()
        manager.connectSocket(params: url(), appId: "app1", callback: connectRecorder.makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: connectRecorder.makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

    /// closeSocket 的一次性回调必须先发 success 再发 complete。真机上出现过 JS 侧
    /// 先收到 complete 再收到 success，根因在容器往 service 投递消息那一层
    /// （DMPService.fromContainer 每条消息各起一个 Task，顺序被线程调度打乱），
    /// 这里把 Manager 这一层的发出顺序钉住，防止以后有人在 close 分支里把
    /// complete 提到 success 前面。
    func test_close_openState_firesSuccessBeforeComplete() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateOpen()
        drain(manager)

        manager.setAllBackgrounded(true)
        drain(manager)

        let connectRecorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "other", "url": "wss://example.com/socket"]), appId: "app1", callback: connectRecorder.makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/socket"]), appId: "app2", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, "connectSocket:fail interrupted",
                        "a brand-new owner created after the app already backgrounded must not slip through as foregrounded")
    }

    // MARK: legacy single-slot / first-live-connection binding

    func test_legacy_slotOverwrite_noStacking() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "first"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "second"]), appId: "app1")
        drain(manager)

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertTrue(events.contains { $0.callbackId == "second" })
        XCTAssertFalse(events.contains { $0.callbackId == "first" }, "later legacy registration must silently overwrite, not stack")
    }

    func test_legacy_firstLiveConnectionBinding_noDriftWhenOtherSocketCloses() {
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.closeSocket(params: DMPMap(["socketId": "a"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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

    // MARK: on*/off* completion — fe auto-wraps these in a Promise via
    // temporary success/fail callback ids; native must complete them or
    // they (and the wrapping Promise) leak forever.

    func test_onOff_registrationCompletesCallback_taskMode() {
        let (manager, _, _) = makeManager()
        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let onRecorder = CallbackRecorder()
        manager.onSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "cbMessage"]), appId: "app1", callback: onRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(onRecorder.lastSuccessErrMsg, "onSocketMessage:ok",
                        "fe auto-wraps on/off in a Promise; native must complete it or the temp callback ids leak forever")
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
        manager.connectSocket(params: url(), appId: "app1", callback: recorder.makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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

        manager.connectSocket(params: url(), appId: "app1", callback: CallbackRecorder().makeCallback())
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
}
