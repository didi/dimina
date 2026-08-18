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

    /// Connects `socketId` and drives its transport all the way to OPEN, returning that transport.
    @discardableResult
    private func connectAndOpen(_ manager: DMPWebSocketManager, _ factory: FakeTransportFactory,
                                socketId: String, appId: String = "app1",
                                file: StaticString = #filePath, line: UInt = #line) -> FakeTransport? {
        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": socketId, "url": "wss://example.com/socket"]),
                              appId: appId, appVersion: "0", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok", file: file, line: line)
        guard let transport = factory.createdTransports.last else {
            XCTFail("no transport dialed for \(socketId)", file: file, line: line)
            return nil
        }
        transport.simulateOpen()
        drain(manager)
        return transport
    }

    /// The one and only message WeChat produces when the connection cap is hit. It carries the
    /// word `fail` twice: `FE` builds `"\(name):fail \(errMsg)"` while the errMsg handed to it
    /// already starts with `fail `. Both copies are part of what a mini program actually sees.
    private static let reachMaxErrMsg = "connectSocket:fail fail reach max websocket connect count 5"

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
    // 错误而不是 `connectSocket:fail timeout`。这里断言 timeoutInterval 始终跟随
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

    func test_connect_urlWithBareSpaceIsRejectedBeforeAnyDial() {
        // Rejecting has to happen in validation, not at the transport: once the dial is under way
        // the caller already has a live attempt against a url they never wrote.
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/a b"]),
                              appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, "connectSocket:fail invalid url")
        XCTAssertTrue(factory.createdTransports.isEmpty, "a malformed url must never reach the network")
    }

    // MARK: header names differing only in case
    //
    // Two field names that differ only in case are two fields on the request side, and the caller
    // wrote both on purpose. Folding them is the response-side rule and the exact opposite of this
    // one. There are two tiers to what an implementation can achieve here, and they are tested
    // separately so the outcome is legible whichever tier it lands on:
    //
    //   contract  — both fields reach the handshake
    //   floor     — if the platform's request type cannot carry both, whichever one survives is
    //               chosen by a rule, not by chance
    //
    // The floor is not a matter of taste. A header that is present on some launches and absent on
    // others turns any server-side behaviour keyed on it — auth, routing, feature flags — into an
    // intermittent failure that reproduces on no one's machine.

    private func caseVariantHeaderParams(socketId: String) -> DMPMap {
        return DMPMap(["socketId": socketId, "url": "wss://example.com/socket",
                       "header": ["X-Dimina-Case": "upper", "x-dimina-case": "lower"]])
    }

    /// Renders every field of `request` whose name matches `X-Dimina-Case` case-insensitively, in a
    /// stable form, so two attempts can be compared as plain strings.
    private func caseVariantFields(of request: URLRequest?) -> String {
        let fields = request?.allHTTPHeaderFields ?? [:]
        return fields.filter { $0.key.lowercased() == "x-dimina-case" }
            .sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value)" }
            .joined(separator: "&")
    }

    func test_connect_bothCaseVariantsOfAHeaderNameReachTheHandshake() throws {
        let (manager, factory, _) = makeManager()

        manager.connectSocket(params: caseVariantHeaderParams(socketId: "s1"), appId: "app1", appVersion: "0",
                              callback: CallbackRecorder().makeCallback())
        drain(manager)

        let request = try XCTUnwrap(factory.createdTransports.first?.lastRequest)
        let fields = request.allHTTPHeaderFields ?? [:]

        // Kept as an expected failure rather than deleted: the contract point is real and the day
        // the platform can express it, this test starts passing and says so out loud. Deleting it
        // would leave nothing to notice that day, and nothing to tell a future reader that sending
        // both spellings was ever the intent.
        //
        // `URLSessionWebSocketTask` takes its request headers only through `URLRequest`, whose
        // field names are case-insensitive, and CFNetwork folds them again when it writes the
        // request head — measured against a server dumping the raw head, `setValue`, a whole
        // `allHTTPHeaderFields` assignment and `URLSessionConfiguration.httpAdditionalHeaders` all
        // put exactly one field on the wire even when the configuration dictionary really does
        // hold both keys (`addValue` instead comma-joins them into a third, different header).
        // Expressing two spellings needs `NWProtocolWebSocket.Options.setAdditionalHeaders`, which
        // means replacing the transport with `NWConnection`. Android's OkHttp `addHeader` keeps
        // both, so this is an iOS platform limit, not a dimina decision.
        XCTExpectFailure("iOS cannot put two header names differing only in case on the wire") {
            let variants = fields.filter { $0.key.lowercased() == "x-dimina-case" }
            XCTAssertEqual(variants.count, 2, "both field names the caller wrote must be on the wire")
            XCTAssertEqual(fields["X-Dimina-Case"], "upper")
            XCTAssertEqual(fields["x-dimina-case"], "lower")
        }
    }

    func test_connect_caseVariantHeaderCollapsesToTheLowestSpelling() throws {
        // The floor the platform limit leaves us: which spelling survives is decided by the
        // caller's input alone. Grouping by lowercased name and keeping the lexicographically
        // smallest spelling makes `X-Dimina-Case` (`X` is 0x58) win over `x-dimina-case` (0x78).
        // Any rule would do; having one is the point, because the alternative is what this
        // replaced — dictionary iteration order picking the winner per call.
        let (manager, factory, _) = makeManager()

        manager.connectSocket(params: caseVariantHeaderParams(socketId: "s1"), appId: "app1", appVersion: "0",
                              callback: CallbackRecorder().makeCallback())
        drain(manager)

        XCTAssertEqual(caseVariantFields(of: factory.createdTransports.first?.lastRequest),
                       "X-Dimina-Case=upper")
    }

    func test_connect_caseVariantHeaderOutcomeIsTheSameOnEveryAttempt() throws {
        // The same input must produce the same request every time. This is the assertion that
        // caught the original defect: 32 attempts inside a single process produced two different
        // outcomes, because the surviving spelling came from dictionary iteration order, which
        // varies per dictionary instance. So the flapping was never just launch-to-launch — two
        // connectSocket calls in one session could put different headers on the wire.
        var outcomes: Set<String> = []
        for attempt in 0..<32 {
            let (manager, factory, _) = makeManager()
            manager.connectSocket(params: caseVariantHeaderParams(socketId: "s\(attempt)"),
                                  appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
            drain(manager)
            outcomes.insert(caseVariantFields(of: factory.createdTransports.first?.lastRequest))
        }

        XCTAssertEqual(outcomes, ["X-Dimina-Case=upper"],
                       "the same header input must always produce the same request; got \(outcomes.sorted())")
    }

    func test_connect_headerNamesThatDoNotCollideKeepTheirSpelling() {
        // Collapsing collisions must not turn into blanket case normalisation: names the caller
        // wrote that collide with nothing go out exactly as written.
        let (manager, factory, _) = makeManager()
        let params = DMPMap(["socketId": "s1", "url": "wss://example.com/socket",
                             "header": ["X-MiXeD-CaSe": "kept", "lower-only": "kept-too"]])

        manager.connectSocket(params: params, appId: "app1", appVersion: "0",
                              callback: CallbackRecorder().makeCallback())
        drain(manager)

        let fields = factory.createdTransports.first?.lastRequest?.allHTTPHeaderFields ?? [:]
        XCTAssertEqual(fields["X-MiXeD-CaSe"], "kept")
        XCTAssertEqual(fields["lower-only"], "kept-too")
    }

    // MARK: connect timeout sourced from app.json
    //
    // `app.json`'s `networkTimeout.connectSocket` is the mini program's own default for
    // connectSocket, and 60000 only applies when that key is absent. The `timeout` passed at the
    // call site outranks both. The container reads app.json and hands the value to the manager the
    // same way it hands over `appVersion`.

    func test_connect_appJsonNetworkTimeoutBecomesTheConnectDeadline() {
        let (manager, factory, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0",
                              appNetworkTimeoutMs: 8000, callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)

        XCTAssertEqual(factory.createdTransports.first?.lastRequest?.timeoutInterval ?? -1, 9, accuracy: 0.001,
                       "the URLRequest deadline must track the app.json timeout, not the hardcoded 60000")

        scheduling.advance(by: 7.9)
        drain(manager)
        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty, "8000 ms have not elapsed yet")

        scheduling.advance(by: 0.2)
        drain(manager)
        XCTAssertEqual(events.first { $0.callbackId == "cbError" }?.payload.get("errMsg") as? String,
                       Self.connectTimeoutErrMsg)
    }

    func test_connect_callerTimeoutOutranksAppJsonNetworkTimeout() {
        let (manager, factory, _) = makeManager()
        let params = DMPMap(["socketId": "s1", "url": "wss://example.com/socket", "timeout": 3000])

        manager.connectSocket(params: params, appId: "app1", appVersion: "0",
                              appNetworkTimeoutMs: 8000, callback: CallbackRecorder().makeCallback())
        drain(manager)

        XCTAssertEqual(factory.createdTransports.first?.lastRequest?.timeoutInterval ?? -1, 4, accuracy: 0.001)
    }

    func test_connect_withoutAppJsonNetworkTimeoutTheDeadlineStaysAt60000() {
        let (manager, factory, _) = makeManager()

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0",
                              appNetworkTimeoutMs: nil, callback: CallbackRecorder().makeCallback())
        drain(manager)

        XCTAssertEqual(factory.createdTransports.first?.lastRequest?.timeoutInterval ?? -1, 61, accuracy: 0.001)
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

    // MARK: concurrency cap
    //
    // The public limit applies to every non-terminal connection, including pending handshakes and
    // close handshakes that have not reached their terminal event.

    func test_connect_maxConcurrencyPerOwner_isolatedAcrossOwners() {
        let (manager, factory, _) = makeManager()
        for index in 0..<5 {
            connectAndOpen(manager, factory, socketId: "s\(index)")
        }

        let overflow = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: overflow.makeCallback())
        drain(manager)
        XCTAssertEqual(overflow.lastErrMsg, Self.reachMaxErrMsg)

        let otherOwner = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "t0", "url": "wss://example.com/socket"]),
                         appId: "app2", appVersion: "0", callback: otherOwner.makeCallback())
        drain(manager)
        XCTAssertEqual(otherOwner.lastSuccessErrMsg, "connectSocket:ok", "owners must not share the concurrency slot pool")
    }

    func test_connect_overflowErrMsgCarriesTheDoubledFailWord() {
        let (manager, factory, _) = makeManager()
        for index in 0..<5 {
            connectAndOpen(manager, factory, socketId: "s\(index)")
        }

        let overflow = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: overflow.makeCallback())
        drain(manager)

        XCTAssertEqual(overflow.lastErrMsg, Self.reachMaxErrMsg,
                       "the second `fail` is part of the string WeChat actually emits, not a typo to correct")
    }

    func test_connect_concurrencyCap_countsPendingConnections() {
        let (manager, factory, _) = makeManager()
        for index in 0..<5 {
            let recorder = CallbackRecorder()
            manager.connectSocket(params: DMPMap(["socketId": "c\(index)", "url": "wss://example.com/socket"]),
                                  appId: "app1", appVersion: "0", callback: recorder.makeCallback())
            drain(manager)
            XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok")
        }
        XCTAssertEqual(factory.createdTransports.count, 5, "sanity: all five are dialing, none opened")

        let sixth = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "c5", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: sixth.makeCallback())
        drain(manager)

        XCTAssertEqual(sixth.lastErrMsg, Self.reachMaxErrMsg)
        XCTAssertNil(sixth.lastSuccessErrMsg)
        XCTAssertEqual(factory.createdTransports.count, 5)
    }

    func test_connect_slotFreedAfterClose() {
        let (manager, factory, _) = makeManager()
        for index in 0..<5 {
            connectAndOpen(manager, factory, socketId: "s\(index)")
        }
        factory.createdTransports[0].autoAckClose = false
        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s0"]), appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")

        let whileClosing = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: whileClosing.makeCallback())
        drain(manager)
        XCTAssertEqual(whileClosing.lastErrMsg, Self.reachMaxErrMsg)

        let firstTransport = factory.createdTransports[0]
        firstTransport.delegate?.transport(firstTransport, didCloseWithCode: 1000, reason: nil)
        drain(manager)
        let afterClose = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                         appId: "app1", appVersion: "0", callback: afterClose.makeCallback())
        drain(manager)
        XCTAssertEqual(afterClose.lastSuccessErrMsg, "connectSocket:ok")
    }

    func test_connect_slotFreedWhenAnOpenedConnectionErrorsOut() {
        let (manager, factory, _) = makeManager()
        var transports: [FakeTransport] = []
        for index in 0..<5 {
            guard let transport = connectAndOpen(manager, factory, socketId: "s\(index)") else { return }
            transports.append(transport)
        }

        transports[0].simulateFailure(NSError(domain: "test", code: 1,
                                              userInfo: [NSLocalizedDescriptionKey: "dropped"]))
        drain(manager)

        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok",
                       "a connection that errored out must return its slot, same as one that closed")
    }

    // MARK: url scheme

    func test_connect_plainWsUrlIsRejectedBeforeDial() {
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "ws://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, "connectSocket:fail invalid url")
        XCTAssertTrue(factory.createdTransports.isEmpty)
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
        XCTAssertEqual(errorEvents.first?.payload.get("errMsg") as? String, Self.handshakeFailedErrMsg)
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

    func test_legacy_closeSocket_deadBinding_failsWithoutClosingOtherTasks() {
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
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 0)
        _ = factory
    }

    func test_legacy_closeSocket_deadBindingWithInvalidCode_doesNotTouchOtherTasks() {
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

        // "a" is already dead and existence wins over code validation.
        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["code": 5000]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail WebSocket is not connected",
                        "an invalid code must not preempt the dead-binding check")
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 0)
        _ = factory
    }

    func test_legacy_closeSocket_closingBindingWithInvalidCode_doesNotTouchOtherTasks() {
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
        XCTAssertTrue(factory.createdTransports[1].closeCalls.isEmpty)
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

    func test_legacy_closeSocket_liveBindingWithInvalidCode_leavesOtherTasksUntouched() {
        // Invalid parameters fail this global call without closing the target or other SocketTasks.
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
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 0)
    }

    func test_legacy_closeSocket_invalidCode_failsThatCallOnlyAndLeavesTheBoundSocketOpen() {
        // The bound target is OPEN, so invalid parameters fail without touching any connection.
        let (manager, factory, _) = makeManager()
        manager.connectSocket(params: DMPMap(["socketId": "a", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.connectSocket(params: DMPMap(["socketId": "b", "url": "wss://example.com/socket"]), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        for transport in factory.createdTransports { transport.simulateOpen() }
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "a", "callback": "aClose"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "b", "callback": "bClose"]), appId: "app1")
        drain(manager)

        let legacyClose = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["code": 500]), appId: "app1", callback: legacyClose.makeCallback())
        drain(manager)

        XCTAssertEqual(legacyClose.lastErrMsg, "closeSocket:fail invalid code")
        XCTAssertTrue(factory.createdTransports[0].closeCalls.isEmpty, "the bound socket must not receive a close request")
        XCTAssertEqual(events.filter { $0.callbackId == "aClose" }.count, 0, "the bound socket must not fire a close event")
        XCTAssertEqual(events.filter { $0.callbackId == "bClose" }.count, 0, "other SocketTasks must remain open")
    }

    // MARK: legacy global listener late registration (missed-event replay)
    //
    // connectSocket dials immediately, but the caller's wx.onSocketOpen /
    // wx.onSocketError / wx.onSocketClose registration is a separate bridge
    // message that can arrive after a fast local handshake or refusal has
    // already produced the event. A global listener registered after the
    // fact must still receive the current state of the socket bound to this
    // owner's legacy slot: the open payload if that socket is open, or the
    // terminal error/close payload if it already reached one. message has no
    // "current state" - only a stream - so it is never replayed.

    func test_legacy_lateOpenListener_receivesReplayOfPastOpen() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        // No global open listener existed when the open landed; this
        // registration arrives only now.
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "lateOpen"]), appId: "app1")
        drain(manager)

        let replayed = events.filter { $0.callbackId == "lateOpen" }
        XCTAssertEqual(replayed.count, 1, "a global open listener registered after the bound socket already opened must receive the missed open event")
        XCTAssertEqual(replayed.first?.payload.get("header") as? [String: String], ["X-Resp": "1"])
    }

    func test_legacy_lateErrorListener_receivesReplayOfPastError() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                             userInfo: [NSLocalizedDescriptionKey: "cannot connect"])
        transport.simulateFailure(error)
        drain(manager)

        manager.onSocketEvent(event: .error, params: DMPMap(["callback": "lateError"]), appId: "app1")
        drain(manager)

        let replayed = events.filter { $0.callbackId == "lateError" }
        XCTAssertEqual(replayed.count, 1, "a global error listener registered after the bound socket already errored must receive the missed error event")
        XCTAssertEqual(replayed.first?.payload.get("errMsg") as? String, Self.handshakeFailedErrMsg)
    }

    func test_legacy_lateCloseListener_receivesReplayOfPastClose() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.delegate?.transport(transport, didCloseWithCode: 1001, reason: "bye".data(using: .utf8))
        drain(manager)

        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "lateClose"]), appId: "app1")
        drain(manager)

        let replayed = events.filter { $0.callbackId == "lateClose" }
        XCTAssertEqual(replayed.count, 1, "a global close listener registered after the bound socket already closed must receive the missed close event")
        XCTAssertEqual(replayed.first?.payload.get("code") as? Int, 1001)
        XCTAssertEqual(replayed.first?.payload.get("reason") as? String, "bye")
    }

    func test_legacy_lateMessageListener_doesNotReplayPastMessages() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.simulateText("earlier message")
        drain(manager)

        manager.onSocketEvent(event: .message, params: DMPMap(["callback": "lateMessage"]), appId: "app1")
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "lateMessage" }.isEmpty,
                       "message events must never be replayed to a newly-registered global listener")

        transport.simulateText("new message")
        drain(manager)

        let delivered = events.filter { $0.callbackId == "lateMessage" }
        XCTAssertEqual(delivered.count, 1, "the new listener must still receive events that arrive after it registers")
        XCTAssertEqual(delivered.first?.payload.get("data") as? String, "new message")
    }

    func test_legacy_lateListener_noBinding_noReplay() {
        let (manager, _, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        // No socket has ever been connected for this owner, so there is no legacy binding at all.
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "noBindOpen"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["callback": "noBindError"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "noBindClose"]), appId: "app1")
        drain(manager)

        XCTAssertTrue(events.isEmpty, "registering global listeners with no legacy binding at all must not push anything")
    }

    func test_legacy_lateOpenListener_bindingExistsButNotYetOpened_noReplay() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager) // dial happens; the socket is bound but still handshaking, so no open record exists yet

        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "tooEarly"]), appId: "app1")
        drain(manager)

        XCTAssertTrue(events.filter { $0.callbackId == "tooEarly" }.isEmpty,
                       "a bound socket that has not opened yet has no open record to replay")

        factory.createdTransports[0].simulateOpen()
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "tooEarly" }.count, 1,
                        "the listener must still receive the open normally once it actually happens")
    }

    func test_legacy_openReplay_targetsOnlyTheNewlyRegisteredListener() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "earlyOpen"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "earlyOpen" }.count, 1)

        events.removeAll()
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "lateOpen"]), appId: "app1")
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "lateOpen" }.count, 1, "the newly-registered listener must receive the replay")
        XCTAssertTrue(events.filter { $0.callbackId == "earlyOpen" }.isEmpty,
                       "an already-registered listener must not be re-delivered the same open event just because another listener joined late")
    }

    func test_legacy_lateOpenReplay_doesNotPreventSubsequentNormalDelivery() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "lateOpen"]), appId: "app1")
        manager.onSocketEvent(event: .message, params: DMPMap(["callback": "lateMessage"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "lateOpen" }.count, 1, "the replay must still happen even when registered alongside a message listener")

        transport.simulateText("hello")
        drain(manager)

        XCTAssertEqual(events.filter { $0.callbackId == "lateMessage" }.count, 1,
                        "a real event landing after a replay must still be delivered normally, not swallowed by the replay path")
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

    func test_idleTimeoutQueuedBehindFreshTrafficOnTheManagerQueueDoesNotCloseTheConnection() {
        // Cancelling the idle timer only cancels the scheduled task itself; it cannot pull back a
        // callback the scheduler already handed to the manager's serial queue. This reproduces
        // that queue ordering directly: traffic resets the timer while the *old* timer's callback
        // is still sitting behind it in the queue, and the stale callback must find itself
        // superseded once it finally runs, not close a connection that is actively alive.
        let factory = FakeTransportFactory()
        let scheduling = FakeScheduling()
        let queue = DispatchQueue(label: "dmp-ws-test-idle-race-\(UUID().uuidString)")
        let manager = DMPWebSocketManager(transportFactory: factory, scheduling: scheduling, queue: queue)
        manager.setIdleTimeoutMs(5_000)
        drain(manager)

        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen() // idle timer armed
        drain(manager)

        let semaphore = DispatchSemaphore(value: 0)
        queue.async { semaphore.wait() } // blocks the queue so the next two tasks queue up behind it

        transport.simulateText("ping") // queued 1st behind the block: resets the idle timer once it runs
        scheduling.advance(by: 5) // old idle timer fires now, synchronously queuing its callback 2nd

        semaphore.signal()
        queue.sync {} // wait for the queue to drain: the reset runs first, then the stale timeout behind it

        XCTAssertTrue(
            events.filter { $0.callbackId == "cbClose" }.isEmpty,
            "a connection that just received traffic must not be closed by the timer callback it raced"
        )

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "still open"]), appId: "app1",
                                  callback: sendRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(sendRecorder.lastSuccessErrMsg, "sendSocketMessage:ok", "the connection must still be OPEN and registered")
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

    // MARK: replay must be deduped together with listener registration
    //
    // The listener set already dedupes by callback id: registering the same id twice must leave
    // the set holding exactly one entry. Replay-on-late-registration has to ride that same
    // dedup, not fire independently of it - re-registering an id that already received its
    // replay adds nothing new to the set, so it must not send a second copy of the event. This
    // holds for both task mode (params carry a socketId) and global mode (they do not).

    func test_taskMode_openReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "dupOpen"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupOpen" }.count, 1)

        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "dupOpen"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupOpen" }.count, 1, "re-registering the same task-mode callback id after it already received the replay must not deliver a second copy")
    }

    func test_taskMode_errorReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                             userInfo: [NSLocalizedDescriptionKey: "cannot connect"])
        transport.simulateFailure(error)
        drain(manager)

        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "dupError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupError" }.count, 1)

        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "dupError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupError" }.count, 1, "re-registering the same task-mode callback id after it already received the replay must not deliver a second copy")
    }

    func test_taskMode_closeReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.delegate?.transport(transport, didCloseWithCode: 1001, reason: "bye".data(using: .utf8))
        drain(manager)

        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "dupClose"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupClose" }.count, 1)

        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "dupClose"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupClose" }.count, 1, "re-registering the same task-mode callback id after it already received the replay must not deliver a second copy")
    }

    func test_legacy_openReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)

        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "dupGlobalOpen"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalOpen" }.count, 1)

        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "dupGlobalOpen"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalOpen" }.count, 1, "re-registering the same global callback id after it already received the replay must not deliver a second copy")
    }

    func test_legacy_errorReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        let error = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                             userInfo: [NSLocalizedDescriptionKey: "cannot connect"])
        transport.simulateFailure(error)
        drain(manager)

        manager.onSocketEvent(event: .error, params: DMPMap(["callback": "dupGlobalError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalError" }.count, 1)

        manager.onSocketEvent(event: .error, params: DMPMap(["callback": "dupGlobalError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalError" }.count, 1, "re-registering the same global callback id after it already received the replay must not deliver a second copy")
    }

    func test_legacy_closeReplay_sameCallbackIdRegisteringAgain_doesNotDoubleDeliver() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.delegate?.transport(transport, didCloseWithCode: 1001, reason: "bye".data(using: .utf8))
        drain(manager)

        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "dupGlobalClose"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalClose" }.count, 1)

        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "dupGlobalClose"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "dupGlobalClose" }.count, 1, "re-registering the same global callback id after it already received the replay must not deliver a second copy")
    }

    func test_normalOpenDelivery_sameCallbackIdRegisteringAgain_doesNotReplayStalePayload() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let params = DMPMap(["socketId": "s1", "callback": "normalOpen"])
        manager.onSocketEvent(event: .open, params: params, appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen()
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "normalOpen" }.count, 1)

        manager.onSocketEvent(event: .open, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "normalOpen" }.count, 1,
                       "normal dispatch and replay must share one delivered-callback ledger")
    }

    func test_normalTerminalDelivery_sameCallbackIdRegisteringAgain_doesNotReplayStalePayload() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let params = DMPMap(["callback": "normalClose"])
        manager.onSocketEvent(event: .close, params: params, appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.delegate?.transport(transport, didCloseWithCode: 1000, reason: nil)
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "normalClose" }.count, 1)

        manager.onSocketEvent(event: .close, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "normalClose" }.count, 1,
                       "a terminal event delivered normally must not be replayed to the same bridge id")
    }

    func test_reusedSocketId_doesNotReplayPreviousConnectionsTerminalEvents() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let oldTransport = factory.createdTransports[0]
        oldTransport.simulateOpen()
        drain(manager)
        oldTransport.simulateFailure(NSError(domain: "test", code: 1,
                                              userInfo: [NSLocalizedDescriptionKey: "old generation"]))
        drain(manager)

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let newTransport = factory.createdTransports[1]

        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "newTaskError"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "newGlobalClose"]), appId: "app1")
        drain(manager)
        XCTAssertFalse(events.contains { $0.callbackId == "newTaskError" })
        XCTAssertFalse(events.contains { $0.callbackId == "newGlobalClose" })

        newTransport.simulateOpen()
        drain(manager)
        newTransport.simulateFailure(NSError(domain: "test", code: 2,
                                              userInfo: [NSLocalizedDescriptionKey: "new generation"]))
        drain(manager)

        // The generations are told apart by when each listener fired (both were silent above,
        // before the new transport failed), not by the errMsg text — errMsg is a fixed string that
        // reads the same for every failure, so it cannot serve as a generation marker.
        XCTAssertEqual(events.filter { $0.callbackId == "newTaskError" }.count, 1)
        XCTAssertEqual(events.first { $0.callbackId == "newTaskError" }?.payload.get("errMsg") as? String,
                       Self.handshakeFailedErrMsg)
        XCTAssertEqual(events.filter { $0.callbackId == "newGlobalClose" }.count, 1)
        XCTAssertEqual(events.first { $0.callbackId == "newGlobalClose" }?.payload.get("code") as? Int, 1006)
    }

    func test_reusedSocketId_lateOldTransportCallbacksCannotAffectReplacementEntry() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let oldTransport = factory.createdTransports[0]
        oldTransport.simulateOpen()
        drain(manager)
        oldTransport.delegate?.transport(oldTransport, didCloseWithCode: 1000, reason: nil)
        drain(manager)

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        let newTransport = factory.createdTransports[1]
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "newOpen"]), appId: "app1")
        manager.onSocketEvent(event: .message, params: DMPMap(["socketId": "s1", "callback": "newMessage"]), appId: "app1")
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "newError"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "newClose"]), appId: "app1")
        drain(manager)

        oldTransport.simulateOpen(headers: ["X-Old": "1"])
        oldTransport.simulateText("stale")
        oldTransport.simulateFailure(NSError(domain: "test", code: 3,
                                              userInfo: [NSLocalizedDescriptionKey: "stale failure"]))
        oldTransport.delegate?.transport(oldTransport, didCloseWithCode: 4001, reason: nil)
        drain(manager)
        XCTAssertTrue(events.filter { ["newOpen", "newMessage", "newError", "newClose"].contains($0.callbackId) }.isEmpty)

        newTransport.simulateOpen()
        drain(manager)
        newTransport.simulateText("fresh")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "newOpen" }.count, 1)
        XCTAssertEqual(events.first { $0.callbackId == "newMessage" }?.payload.get("data") as? String, "fresh")
    }

    func test_taskTerminalReplay_sameCallbackIdCanReplayAgainAfterOff() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateFailure(
            NSError(domain: "test", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"]))
        drain(manager)

        let params = DMPMap(["socketId": "s1", "callback": "taskErrorLifecycle"])
        manager.onSocketEvent(event: .error, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "taskErrorLifecycle" }.count, 1)

        manager.offSocketEvent(event: .error, params: params, appId: "app1")
        manager.onSocketEvent(event: .error, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "taskErrorLifecycle" }.count, 2)
    }

    func test_legacyOpenReplay_sameCallbackIdCanReplayAgainAfterOff() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateOpen()
        drain(manager)

        let params = DMPMap(["callback": "globalOpenLifecycle"])
        manager.onSocketEvent(event: .open, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "globalOpenLifecycle" }.count, 1)

        manager.offSocketEvent(event: .open, params: params, appId: "app1")
        manager.onSocketEvent(event: .open, params: params, appId: "app1")
        drain(manager)
        XCTAssertEqual(events.filter { $0.callbackId == "globalOpenLifecycle" }.count, 2)
    }

    // MARK: event payload key sets
    //
    // Each event carries an exact set of keys and nothing else. Anything extra either invents an
    // API surface WeChat does not have (`wasClean`, `errCode`) or leaks container bookkeeping
    // (`socketId`, `state`) into a mini program's callback. `isBuffer` is the one permitted extra:
    // it is the JSON bridge's own marker telling the script layer to decode `data` back into an
    // ArrayBuffer, and the script layer strips it before the business callback ever sees it.

    private func payloadKeys(_ event: RecordedEvent) -> Set<String> {
        return Set(event.payload.toDictionary().keys)
    }

    func test_eventPayload_openCarriesHeaderAndProfileOnly() throws {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "cbOpen"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "cbOpen" })
        XCTAssertEqual(payloadKeys(open), ["header", "profile"])
    }

    func test_eventPayload_textMessageCarriesDataOnly() throws {
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
        transport.simulateText("hello")
        drain(manager)

        let message = try XCTUnwrap(events.first { $0.callbackId == "cbMessage" })
        XCTAssertEqual(payloadKeys(message), ["data"])
    }

    func test_eventPayload_binaryMessageCarriesDataAndTheBridgeBufferMarkerOnly() throws {
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
        transport.simulateData(Data([0x01, 0x02]))
        drain(manager)

        let message = try XCTUnwrap(events.first { $0.callbackId == "cbMessage" })
        XCTAssertEqual(payloadKeys(message), ["data", "isBuffer"])
    }

    func test_eventPayload_errorCarriesErrMsgOnly_neverAnErrCode() throws {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateFailure(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                    userInfo: [NSLocalizedDescriptionKey: "cannot connect"]))
        drain(manager)

        let error = try XCTUnwrap(events.first { $0.callbackId == "cbError" })
        XCTAssertEqual(payloadKeys(error), ["errMsg"])
    }

    func test_eventPayload_closeCarriesCodeAndReasonOnly_neverWasClean() throws {
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
        transport.delegate?.transport(transport, didCloseWithCode: 1001, reason: "bye".data(using: .utf8))
        drain(manager)

        let close = try XCTUnwrap(events.first { $0.callbackId == "cbClose" })
        XCTAssertEqual(payloadKeys(close), ["code", "reason"])
    }

    // MARK: profile

    func test_profile_openPayloadCarriesAllEightNumericFields() throws {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "cbOpen"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen()
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "cbOpen" })
        let profile = try XCTUnwrap(open.payload.get("profile") as? [String: Any])
        XCTAssertEqual(Set(profile.keys), ["fetchStart", "domainLookUpStart", "domainLookUpEnd",
                                           "connectStart", "connectEnd", "rtt", "handshakeCost", "cost"])
        for (name, value) in profile {
            XCTAssertTrue(value is Double, "profile.\(name) must be a number, got \(type(of: value))")
        }
    }

    /// The DNS and connect phases are measurements, not restatements of `fetchStart`. Deriving
    /// `domainLookUpStart`/`domainLookUpEnd`/`connectStart` from `fetchStart` and `connectEnd`
    /// from the open timestamp makes `handshakeCost` permanently 0 and `rtt` permanently equal to
    /// `cost`, which reports every connection as an instant handshake no matter how slow it was.
    func test_profile_handshakePhasesComeFromMeasuredMetrics_notBackfilled() throws {
        let (manager, factory, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        // fetchStart is stamped here, at t = 0 ms.
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "cbOpen"]), appId: "app1")
        drain(manager)

        let transport = factory.createdTransports[0]
        scheduling.advance(by: 0.020) // t = 20 ms
        transport.simulateHandshakeMetrics(domainLookupStart: 2, domainLookupEnd: 5,
                                           connectStart: 6, connectEnd: 12)
        drain(manager)
        transport.simulateOpen() // the WebSocket upgrade completes at t = 20 ms
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "cbOpen" })
        let profile = try XCTUnwrap(open.payload.get("profile") as? [String: Any])

        let fetchStart = try XCTUnwrap(profile["fetchStart"] as? Double)
        let domainLookUpStart = try XCTUnwrap(profile["domainLookUpStart"] as? Double)
        let domainLookUpEnd = try XCTUnwrap(profile["domainLookUpEnd"] as? Double)
        let connectStart = try XCTUnwrap(profile["connectStart"] as? Double)
        let connectEnd = try XCTUnwrap(profile["connectEnd"] as? Double)
        let rtt = try XCTUnwrap(profile["rtt"] as? Double)
        let handshakeCost = try XCTUnwrap(profile["handshakeCost"] as? Double)
        let cost = try XCTUnwrap(profile["cost"] as? Double)

        XCTAssertEqual(fetchStart, 0, accuracy: 0.001)
        XCTAssertEqual(domainLookUpStart, 2, accuracy: 0.001, "must be the measured DNS start, not fetchStart")
        XCTAssertEqual(domainLookUpEnd, 5, accuracy: 0.001, "must be the measured DNS end, not fetchStart")
        XCTAssertEqual(connectStart, 6, accuracy: 0.001, "must be the measured connect start, not fetchStart")
        XCTAssertEqual(connectEnd, 12, accuracy: 0.001, "must be the measured connect end, not the open timestamp")
        XCTAssertEqual(cost, 20, accuracy: 0.001)

        XCTAssertEqual(Set([fetchStart, domainLookUpStart, domainLookUpEnd, connectStart, connectEnd]).count, 5,
                       "each phase boundary happened at its own moment; collapsing them loses the measurement")
        XCTAssertGreaterThan(handshakeCost, 0,
                             "the WebSocket upgrade took 8 ms after the connection was established")
        XCTAssertNotEqual(rtt, cost, "rtt covers the connect phase alone, cost covers the whole attempt")
    }

    // MARK: open payload — task scope vs global scope are different shapes
    //
    // `SocketTask.onOpen` receives `{header, profile}`; the global `wx.onSocketOpen` receives
    // `{header}` and nothing else. The two result types are declared separately and the global one
    // has no profile member, so a mini program written against the global API can never read
    // timing data from it. Handing the task-scope payload to both listeners publishes a field the
    // global API does not have; the container must project the payload per scope, on the normal
    // dispatch path and on the late-registration replay path alike.

    func test_globalOpenPayload_carriesHeaderOnly_onNormalDispatch() throws {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "globalOpen"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "globalOpen" })
        XCTAssertEqual(payloadKeys(open), ["header"],
                       "wx.onSocketOpen has no profile member; leaking one publishes an API surface that does not exist")
        XCTAssertEqual(open.payload.get("header") as? [String: String], ["X-Resp": "1"],
                       "projecting the payload must not cost the header")
    }

    func test_globalOpenPayload_carriesHeaderOnly_onLateRegistrationReplay() throws {
        // The replay path builds its own delivery out of the stored open payload, so it needs the
        // same projection as the normal dispatch path — fixing only one of the two leaves the leak
        // reachable through whichever path the caller happens to hit.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        // The registration arrives only after the handshake already completed.
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "lateGlobalOpen"]), appId: "app1")
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "lateGlobalOpen" })
        XCTAssertEqual(payloadKeys(open), ["header"])
        XCTAssertEqual(open.payload.get("header") as? [String: String], ["X-Resp": "1"])
    }

    func test_openPayload_taskAndGlobalScopesAreNotSwapped_onNormalDispatch() throws {
        // Both scopes listen to the same connection and the same open event. Asserting them
        // together is what catches a projection applied to the wrong scope: dropping profile from
        // both, or from the task payload instead of the global one, still satisfies either
        // single-scope assertion on its own.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "taskOpen"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "globalOpen"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        let task = try XCTUnwrap(events.first { $0.callbackId == "taskOpen" })
        let global = try XCTUnwrap(events.first { $0.callbackId == "globalOpen" })
        XCTAssertEqual(payloadKeys(task), ["header", "profile"], "SocketTask.onOpen keeps its profile")
        XCTAssertEqual(payloadKeys(global), ["header"], "wx.onSocketOpen never gets one")
        XCTAssertEqual(task.payload.get("header") as? [String: String],
                       global.payload.get("header") as? [String: String],
                       "both scopes see the same response header")
    }

    func test_openPayload_taskAndGlobalScopesAreNotSwapped_onLateRegistrationReplay() throws {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["X-Resp": "1"])
        drain(manager)

        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "lateTaskOpen"]), appId: "app1")
        manager.onSocketEvent(event: .open, params: DMPMap(["callback": "lateGlobalOpen"]), appId: "app1")
        drain(manager)

        let task = try XCTUnwrap(events.first { $0.callbackId == "lateTaskOpen" })
        let global = try XCTUnwrap(events.first { $0.callbackId == "lateGlobalOpen" })
        XCTAssertEqual(payloadKeys(task), ["header", "profile"])
        XCTAssertEqual(payloadKeys(global), ["header"])
    }

    // MARK: send failure errMsg is a fixed, machine-readable string
    //
    // `errMsg` is what a mini program branches on. `URLSessionWebSocketTask` reports send failures
    // as an NSError whose `localizedDescription` is translated into the device's language, so
    // passing it through means the same failure reads differently on an English phone than on a
    // Chinese one and no `errMsg` comparison a mini program writes can hold. All three platforms
    // report one fixed English string for a send the transport refused.

    private static let sendRejectedErrMsg = "sendSocketMessage:fail WebSocket is not connected"

    private func openedSocket(_ manager: DMPWebSocketManager, _ factory: FakeTransportFactory,
                              file: StaticString = #filePath, line: UInt = #line) -> FakeTransport? {
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        guard let transport = factory.createdTransports.last else {
            XCTFail("no transport dialed", file: file, line: line)
            return nil
        }
        transport.simulateOpen()
        drain(manager)
        return transport
    }

    func test_send_rejectedByTransport_reportsTheFixedNotConnectedErrMsg() {
        let (manager, factory, _) = makeManager()
        guard let transport = openedSocket(manager, factory) else { return }

        transport.sendResult = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                                       userInfo: [NSLocalizedDescriptionKey: "The network connection was lost."])
        let recorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1",
                                  callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, Self.sendRejectedErrMsg)
    }

    func test_send_rejectedByTransport_errMsgDoesNotFollowTheDeviceLanguage() {
        // The same failure, as the OS would describe it under two different system languages. The
        // errMsg a mini program sees must be identical in both cases.
        let (manager, factory, _) = makeManager()
        guard let transport = openedSocket(manager, factory) else { return }

        transport.sendResult = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                                       userInfo: [NSLocalizedDescriptionKey: "The network connection was lost."])
        let english = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1",
                                  callback: english.makeCallback())
        drain(manager)

        transport.sendResult = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                                       userInfo: [NSLocalizedDescriptionKey: "网络连接已中断。"])
        let localized = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1",
                                  callback: localized.makeCallback())
        drain(manager)

        XCTAssertEqual(english.lastErrMsg, Self.sendRejectedErrMsg)
        XCTAssertEqual(localized.lastErrMsg, Self.sendRejectedErrMsg)
        XCTAssertEqual(english.lastErrMsg, localized.lastErrMsg,
                       "a translated OS message must never reach errMsg")
    }

    func test_send_binaryFrameRejectedByTransport_reportsTheSameFixedErrMsg() {
        let (manager, factory, _) = makeManager()
        guard let transport = openedSocket(manager, factory) else { return }

        transport.sendResult = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost,
                                       userInfo: [NSLocalizedDescriptionKey: "The network connection was lost."])
        let recorder = CallbackRecorder()
        let payload = Data([0x01, 0x02, 0x03]).base64EncodedString()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": payload, "isBuffer": true]),
                                  appId: "app1", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, Self.sendRejectedErrMsg)
    }

    // MARK: connect-phase errMsg is a fixed string too
    //
    // The same rule the send path already follows applies to the error event: errMsg may only be
    // assembled from the container's own fixed English strings, never from an OS-supplied
    // description. `NSError.localizedDescription` is translated into the device's language, so
    // routing it into errMsg makes the contract text differ per phone. The raw error still belongs
    // in the logs — just not in the payload a mini program branches on.

    /// The single string every failed handshake reports, matching the sibling path that already
    /// reports it when the peer closes before the upgrade completes.
    private static let handshakeFailedErrMsg = "connectSocket:fail WebSocket connection failed"

    /// Two descriptions of one and the same failure, as the OS would phrase them under two system
    /// languages. Neither contains an English "timeout"-like word, so the classification the
    /// container does cannot be what makes them differ.
    private static let osTextEnglish = "Could not connect to the server."
    private static let osTextChinese = "无法连接到服务器。"

    private func connectFailureError(describedAs description: String) -> NSError {
        return NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost,
                       userInfo: [NSLocalizedDescriptionKey: description])
    }

    /// Runs one whole connect attempt that fails before the handshake completes, and returns the
    /// errMsg delivered to the error event.
    private func errMsgForFailureBeforeOpen(_ error: NSError) -> String? {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateFailure(error)
        drain(manager)

        return events.first { $0.callbackId == "cbError" }?.payload.get("errMsg") as? String
    }

    /// Same, for a connection that reached OPEN and then lost the network: that path emits an
    /// error event followed by a close event, and both carry container-authored text.
    private func eventsForFailureAfterOpen(_ error: NSError) -> (errMsg: String?, closeReason: String?) {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "s1", "callback": "cbClose"]), appId: "app1")
        drain(manager)
        let transport = factory.createdTransports[0]
        transport.simulateOpen()
        drain(manager)
        transport.simulateFailure(error)
        drain(manager)

        return (events.first { $0.callbackId == "cbError" }?.payload.get("errMsg") as? String,
                events.first { $0.callbackId == "cbClose" }?.payload.get("reason") as? String)
    }

    func test_connectFailure_errMsgDoesNotFollowTheDeviceLanguage() throws {
        let english = try XCTUnwrap(errMsgForFailureBeforeOpen(connectFailureError(describedAs: Self.osTextEnglish)))
        let chinese = try XCTUnwrap(errMsgForFailureBeforeOpen(connectFailureError(describedAs: Self.osTextChinese)))

        XCTAssertEqual(english, chinese,
                       "one failure must produce one errMsg; here the only difference is how the OS phrased it")
        XCTAssertFalse(english.contains(Self.osTextEnglish), "the OS description must not reach errMsg")
        XCTAssertFalse(chinese.contains(Self.osTextChinese), "the OS description must not reach errMsg")
    }

    func test_failureAfterOpen_errorEventErrMsgDoesNotFollowTheDeviceLanguage() throws {
        // A second, separate call site of the same conversion: an already-open connection dropping
        // out emits its error event through a different branch than a failed handshake.
        let english = try XCTUnwrap(eventsForFailureAfterOpen(connectFailureError(describedAs: Self.osTextEnglish)).errMsg)
        let chinese = try XCTUnwrap(eventsForFailureAfterOpen(connectFailureError(describedAs: Self.osTextChinese)).errMsg)

        XCTAssertEqual(english, chinese)
        XCTAssertFalse(english.contains(Self.osTextEnglish))
        XCTAssertFalse(chinese.contains(Self.osTextChinese))
    }

    /// The one string a mini program sees when a connection attempt ran out of time, whichever
    /// side noticed first.
    private static let connectTimeoutErrMsg = "connectSocket:fail timeout"

    /// Lets the container's own connect watchdog expire and returns the errMsg it dispatched.
    private func errMsgForWatchdogTimeout() -> String? {
        let (manager, factory, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/socket", "timeout": 1000]),
                              appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)
        XCTAssertEqual(factory.createdTransports.count, 1, "sanity: the dial is under way and never completes")

        scheduling.advance(by: 1.1)
        drain(manager)

        return events.first { $0.callbackId == "cbError" }?.payload.get("errMsg") as? String
    }

    func test_connectTimeout_containerWatchdogReportsTheUnifiedTimeoutErrMsg() {
        XCTAssertEqual(errMsgForWatchdogTimeout(), Self.connectTimeoutErrMsg)
    }

    func test_connectTimeout_watchdogAndTransportReportTheSameErrMsg() throws {
        // "The attempt ran out of time" is one outcome with two possible detectors: the container's
        // own timer, and the transport reporting a timeout of its own. Which one notices first is an
        // implementation accident — a caller checking for a timeout would otherwise need to know
        // both spellings and branch on them.
        let watchdog = try XCTUnwrap(errMsgForWatchdogTimeout())
        let transportReported = try XCTUnwrap(errMsgForFailureBeforeOpen(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut,
                    userInfo: [NSLocalizedDescriptionKey: "The request timed out."])))

        XCTAssertEqual(watchdog, transportReported)
        XCTAssertEqual(watchdog, Self.connectTimeoutErrMsg)
    }

    func test_connectTimeout_classificationDoesNotDependOnTheLanguageOfTheOsMessage() throws {
        // ETIMEDOUT, reported outside NSURLErrorDomain so the domain/code shortcut does not apply.
        // Picking the fixed string by searching the OS text for English words like "timed out"
        // means the very same error is classified as a timeout on an English phone and as
        // something else on a Chinese one — the device language decides the contract.
        let englishError = NSError(domain: NSPOSIXErrorDomain, code: 60,
                                   userInfo: [NSLocalizedDescriptionKey: "Operation timed out"])
        let chineseError = NSError(domain: NSPOSIXErrorDomain, code: 60,
                                   userInfo: [NSLocalizedDescriptionKey: "操作超时"])

        let english = try XCTUnwrap(errMsgForFailureBeforeOpen(englishError))
        let chinese = try XCTUnwrap(errMsgForFailureBeforeOpen(chineseError))

        XCTAssertEqual(english, chinese,
                       "the errMsg an error resolves to must be decided by the error itself, not by the wording of its translation")
    }

    func test_failureAfterOpen_closeReasonCarriesNoOsText() throws {
        // The close event that follows the error carries a container-synthesised reason: there was
        // no close frame on the wire to quote, so the text is dimina's to choose. Every other
        // synthesised reason on this path is a fixed English string ("interrupted", "idle
        // timeout"); this one must be too, or the same disconnect reads differently per language.
        let english = try XCTUnwrap(eventsForFailureAfterOpen(connectFailureError(describedAs: Self.osTextEnglish)).closeReason)
        let chinese = try XCTUnwrap(eventsForFailureAfterOpen(connectFailureError(describedAs: Self.osTextChinese)).closeReason)

        XCTAssertEqual(english, chinese)
        XCTAssertFalse(english.contains(Self.osTextEnglish))
        XCTAssertFalse(chinese.contains(Self.osTextChinese))
    }

    // MARK: global binding hands over once the bound socket is closing
    //
    // The global API binds to "the oldest connection that has not reached CLOSED yet". A socket
    // the caller has already closed is CLOSED as far as the service layer is concerned — the close
    // request is what settles it, not the peer's acknowledgement, which arrives a round trip later
    // and may never arrive at all. Deciding instead by "is this id still in the registry" conflates
    // two different questions: the registry entry survives through CLOSING because the transport
    // still holds resources, so a close-then-connect pair would leave the global API bound forever
    // to a connection that can no longer carry anything.

    /// Connects `socketId`, drives it to OPEN, and stops the fake transport from acknowledging its
    /// own close, so a close request parks the entry in CLOSING the way a real peer round trip does.
    private func openedSocketWithoutCloseAck(_ manager: DMPWebSocketManager, _ factory: FakeTransportFactory,
                                             socketId: String, appId: String = "app1",
                                             file: StaticString = #filePath, line: UInt = #line) -> FakeTransport? {
        let recorder = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": socketId, "url": "wss://example.com/socket"]),
                              appId: appId, appVersion: "0", callback: recorder.makeCallback())
        drain(manager)
        XCTAssertEqual(recorder.lastSuccessErrMsg, "connectSocket:ok", file: file, line: line)
        guard let transport = factory.createdTransports.last else {
            XCTFail("no transport dialed for \(socketId)", file: file, line: line)
            return nil
        }
        transport.autoAckClose = false
        transport.simulateOpen()
        drain(manager)
        return transport
    }

    func test_legacyBinding_handsOverToTheNextConnection_whileTheBoundOneIsStillClosing() {
        let (manager, factory, _) = makeManager()
        guard let a = openedSocketWithoutCloseAck(manager, factory, socketId: "a") else { return }

        // wx.closeSocket() with no socketId: closes the bound connection and returns immediately,
        // long before the peer completes the close handshake.
        let closeRecorder = CallbackRecorder()
        manager.closeSocket(params: DMPMap([:]), appId: "app1", callback: closeRecorder.makeCallback())
        drain(manager)
        XCTAssertEqual(closeRecorder.lastSuccessErrMsg, "closeSocket:ok")
        XCTAssertEqual(a.closeCalls.count, 1, "sanity: A is closing, and its peer has not acked yet")

        guard let b = openedSocketWithoutCloseAck(manager, factory, socketId: "b") else { return }

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["data": "to-b"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)

        XCTAssertEqual(sendRecorder.lastSuccessErrMsg, "sendSocketMessage:ok",
                       "the global API must follow the handover instead of staying stuck on a closing connection")
        XCTAssertEqual(b.sentTexts, ["to-b"])
        XCTAssertTrue(a.sentTexts.isEmpty, "nothing may be written to the connection the caller closed")
    }

    func test_legacyBinding_lateCloseAckOfTheOldSocketDoesNotTakeTheBindingBack() {
        // The second interaction is where a binding bug actually shows: the ack for A's close
        // lands after B has taken over. Removing A from the registry at that point must not
        // disturb B's binding, and must not be mistaken for "the bound socket died, rebind".
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        guard let a = openedSocketWithoutCloseAck(manager, factory, socketId: "a") else { return }
        manager.onSocketEvent(event: .close, params: DMPMap(["socketId": "a", "callback": "aClose"]), appId: "app1")
        drain(manager)

        manager.closeSocket(params: DMPMap(["code": 3001, "reason": "bye"]), appId: "app1",
                            callback: CallbackRecorder().makeCallback())
        drain(manager)

        guard let b = openedSocketWithoutCloseAck(manager, factory, socketId: "b") else { return }

        // Now the peer finally completes A's close handshake.
        a.delegate?.transport(a, didCloseWithCode: 1000, reason: nil)
        drain(manager)

        let aCloseEvents = events.filter { $0.callbackId == "aClose" }
        XCTAssertEqual(aCloseEvents.count, 1, "A's own task-scope close listener still fires exactly once")
        XCTAssertEqual(aCloseEvents.first?.payload.get("code") as? Int, 3001, "and reports the caller's own code")

        let sendRecorder = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["data": "still-b"]), appId: "app1", callback: sendRecorder.makeCallback())
        drain(manager)

        XCTAssertEqual(sendRecorder.lastSuccessErrMsg, "sendSocketMessage:ok")
        XCTAssertEqual(b.sentTexts, ["still-b"], "the binding stays on B after A finally settles")
        XCTAssertEqual(b.abortCallCount, 0, "A settling must not tear B down")
        XCTAssertTrue(b.closeCalls.isEmpty)
    }

    // MARK: complete carries the same result as success/fail
    //
    // `complete` is documented as "the callback that runs on either outcome", and it receives the
    // same result object the outcome-specific callback got. Handing it an empty object instead
    // breaks the ordinary `complete: res => res.errMsg` shape: the caller gets undefined and has
    // no way to tell what it is completing, which is the whole point of a single-exit callback.

    func test_complete_carriesTheSameErrMsgAsSuccessAndFail_connectSocket() {
        let (manager, factory, _) = makeManager()

        let ok = CallbackRecorder()
        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: ok.makeCallback())
        drain(manager)
        XCTAssertEqual(ok.lastSuccessErrMsg, "connectSocket:ok", "sanity: this is the success path")
        XCTAssertEqual(ok.lastCompleteErrMsg, ok.lastSuccessErrMsg)

        let failed = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s2", "url": "http://example.com"]),
                              appId: "app1", appVersion: "0", callback: failed.makeCallback())
        drain(manager)
        XCTAssertEqual(failed.lastErrMsg, "connectSocket:fail invalid url", "sanity: this is the fail path")
        XCTAssertEqual(failed.lastCompleteErrMsg, failed.lastErrMsg)
        _ = factory
    }

    func test_complete_carriesTheSameErrMsgAsSuccessAndFail_sendSocketMessage() {
        let (manager, factory, _) = makeManager()
        guard openedSocket(manager, factory) != nil else { return }

        let ok = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "s1", "data": "hello"]), appId: "app1",
                                  callback: ok.makeCallback())
        drain(manager)
        XCTAssertEqual(ok.lastSuccessErrMsg, "sendSocketMessage:ok")
        XCTAssertEqual(ok.lastCompleteErrMsg, ok.lastSuccessErrMsg)

        let failed = CallbackRecorder()
        manager.sendSocketMessage(params: DMPMap(["socketId": "nope", "data": "hello"]), appId: "app1",
                                  callback: failed.makeCallback())
        drain(manager)
        XCTAssertEqual(failed.lastErrMsg, "sendSocketMessage:fail WebSocket is not connected")
        XCTAssertEqual(failed.lastCompleteErrMsg, failed.lastErrMsg)
    }

    func test_complete_carriesTheSameErrMsgAsSuccessAndFail_closeSocket() {
        let (manager, factory, _) = makeManager()
        guard openedSocket(manager, factory) != nil else { return }

        let ok = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "s1"]), appId: "app1", callback: ok.makeCallback())
        drain(manager)
        XCTAssertEqual(ok.lastSuccessErrMsg, "closeSocket:ok")
        XCTAssertEqual(ok.lastCompleteErrMsg, ok.lastSuccessErrMsg)

        let failed = CallbackRecorder()
        manager.closeSocket(params: DMPMap(["socketId": "nope"]), appId: "app1", callback: failed.makeCallback())
        drain(manager)
        XCTAssertEqual(failed.lastErrMsg, "closeSocket:fail WebSocket is not connected")
        XCTAssertEqual(failed.lastCompleteErrMsg, failed.lastErrMsg)
    }

    // MARK: non-ASCII header values

    func test_connect_nonAsciiHeaderValueIsRejectedBeforeAnyDial() {
        // RFC 7230 deprecated obs-text in field values, and OkHttp enforces that by refusing any
        // byte >= 0x7F. iOS accepting the same header means one platform connects and another
        // does not for identical mini-program code — the caller cannot write anything that works
        // everywhere. Rejecting during validation keeps the outcome a connectSocket fail on every
        // platform instead of a late error event on some of them.
        let (manager, factory, _) = makeManager()
        let recorder = CallbackRecorder()

        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/socket",
                                              "header": ["X-A": "中文"]]),
                              appId: "app1", appVersion: "0", callback: recorder.makeCallback())
        drain(manager)

        XCTAssertEqual(recorder.lastErrMsg, "connectSocket:fail invalid header")
        XCTAssertTrue(factory.createdTransports.isEmpty,
                      "a header the peer platform refuses must not produce a live connection here")
    }

    // MARK: response header pass-through

    func test_openHeader_commaJoinedValueReachesThePayloadUnchanged() throws {
        // Repeated response headers are folded into one comma-separated value per RFC 7230 3.2.2.
        // Whatever the transport hands over is already the merged form; the manager must deliver it
        // byte for byte, neither re-splitting it nor rewriting the name's case.
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: url(), appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .open, params: DMPMap(["socketId": "s1", "callback": "cbOpen"]), appId: "app1")
        drain(manager)
        factory.createdTransports[0].simulateOpen(headers: ["Set-Cookie": "a=1, b=2"])
        drain(manager)

        let open = try XCTUnwrap(events.first { $0.callbackId == "cbOpen" })
        XCTAssertEqual(open.payload.get("header") as? [String: String], ["Set-Cookie": "a=1, b=2"])
    }

    // MARK: sub-millisecond timeout

    func test_connect_subMillisecondTimeoutFallsBackInsteadOfExpiringImmediately() {
        // 0.5 floors to 0, and a 0 ms deadline fires on the next tick: the caller gets
        // `connectSocket:fail timeout` before the handshake could possibly have finished. A
        // timeout below the unit it is expressed in carries no usable intent, so it counts as
        // unspecified and the configured default applies.
        let (manager, factory, scheduling) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        manager.connectSocket(params: DMPMap(["socketId": "s1", "url": "wss://example.com/socket", "timeout": 0.5]),
                              appId: "app1", appVersion: "0", callback: CallbackRecorder().makeCallback())
        drain(manager)
        manager.onSocketEvent(event: .error, params: DMPMap(["socketId": "s1", "callback": "cbError"]), appId: "app1")
        drain(manager)

        XCTAssertEqual(factory.createdTransports.first?.lastRequest?.timeoutInterval ?? -1, 61, accuracy: 0.001,
                       "the deadline must be the 60000 default, not 0")

        scheduling.advance(by: 1)
        drain(manager)
        XCTAssertTrue(events.filter { $0.callbackId == "cbError" }.isEmpty,
                      "a connection one second in must not already have timed out")
    }

    /// CLOSING is reached through two doors. Dimina lets an accepted global close hand the
    /// unspecified global route over, while SocketTask.close() remains scoped to its task.
    ///
    /// Both halves live in one test on purpose: each is the other's control, with the close entry
    /// point as the only variable. Written separately, a change that made *neither* door release
    /// the binding — or made *both* release it — would still leave one of them green.
    ///
    /// The question is asked through the global close listener rather than through a global send:
    /// global events are delivered only to the currently-bound connection, so who receives A's
    /// close event *is* the binding. Whether a CLOSING connection may still be sent to is a
    /// separate, undecided question, and tying this test to it would couple a settled contract to
    /// an unsettled one.
    func test_onlyAGlobalCloseReleasesTheBinding_aTaskCloseDoesNot() {
        let (manager, factory, _) = makeManager()
        var events: [RecordedEvent] = []
        manager.eventSinkForTest = { appId, cb, payload in events.append(RecordedEvent(appId: appId, callbackId: cb, payload: payload)) }

        // Task door: SocketTask.close() on A, addressed by socketId.
        guard let taskDoorA = openedSocketWithoutCloseAck(manager, factory, socketId: "a", appId: "taskDoor") else { return }
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "taskDoorGlobalClose"]), appId: "taskDoor")
        drain(manager)
        manager.closeSocket(params: DMPMap(["socketId": "a", "code": 3001]), appId: "taskDoor",
                            callback: CallbackRecorder().makeCallback())
        drain(manager)
        guard openedSocketWithoutCloseAck(manager, factory, socketId: "b", appId: "taskDoor") != nil else { return }

        // Global door: wx.closeSocket() with no socketId, same timing in every other respect.
        guard let globalDoorA = openedSocketWithoutCloseAck(manager, factory, socketId: "a", appId: "globalDoor") else { return }
        manager.onSocketEvent(event: .close, params: DMPMap(["callback": "globalDoorGlobalClose"]), appId: "globalDoor")
        drain(manager)
        manager.closeSocket(params: DMPMap(["code": 3001]), appId: "globalDoor",
                            callback: CallbackRecorder().makeCallback())
        drain(manager)
        guard openedSocketWithoutCloseAck(manager, factory, socketId: "b", appId: "globalDoor") != nil else { return }

        // Both peers finally complete their close handshakes.
        taskDoorA.delegate?.transport(taskDoorA, didCloseWithCode: 1000, reason: nil)
        globalDoorA.delegate?.transport(globalDoorA, didCloseWithCode: 1000, reason: nil)
        drain(manager)

        let afterTaskClose = events.filter { $0.callbackId == "taskDoorGlobalClose" }
        XCTAssertEqual(afterTaskClose.count, 1,
                       "SocketTask.close() does not hand over Dimina's global route")
        XCTAssertEqual(afterTaskClose.first?.payload.get("code") as? Int, 3001)

        XCTAssertTrue(events.filter { $0.callbackId == "globalDoorGlobalClose" }.isEmpty,
                      "an accepted wx.closeSocket call hands Dimina's global route to B")
    }

    func test_concurrencyCap_globallyClosedSocketsKeepTheirSlotsUntilTheirCloseEventsArrive() {
        // The slot question is answered the same way through either door: the wire is still there
        // until the peer answers. Pairs with the task-door case below so a fix for the binding
        // split cannot be smuggled in by dropping CLOSING entries from the registry.
        let (manager, factory, _) = makeManager()
        var transports: [FakeTransport] = []
        for index in 0..<5 {
            guard let transport = openedSocketWithoutCloseAck(manager, factory, socketId: "s\(index)") else { return }
            transports.append(transport)
        }

        // wx.closeSocket() closes only the opened global target.
        manager.closeSocket(params: DMPMap([:]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let whileClosing = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: whileClosing.makeCallback())
        drain(manager)
        XCTAssertEqual(whileClosing.lastErrMsg, Self.reachMaxErrMsg,
                       "closing through the global door does not hand the wires back any sooner")

        transports[0].delegate?.transport(transports[0], didCloseWithCode: 1000, reason: nil)
        drain(manager)

        let afterClose = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s6", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: afterClose.makeCallback())
        drain(manager)
        XCTAssertEqual(afterClose.lastSuccessErrMsg, "connectSocket:ok")
    }

    func test_concurrencyCap_closingSocketKeepsItsSlotUntilItsCloseEventArrives() {
        // The tripwire for the wrong way to fix the handover: dropping a CLOSING entry from the
        // registry would make the binding move, but it also hands its concurrency slot back while
        // the transport is still holding one, letting a close-then-connect pair exceed the cap.
        let (manager, factory, _) = makeManager()
        var transports: [FakeTransport] = []
        for index in 0..<5 {
            guard let transport = connectAndOpen(manager, factory, socketId: "s\(index)") else { return }
            transports.append(transport)
        }

        transports[0].autoAckClose = false
        manager.closeSocket(params: DMPMap(["socketId": "s0"]), appId: "app1", callback: CallbackRecorder().makeCallback())
        drain(manager)

        let whileClosing = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s5", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: whileClosing.makeCallback())
        drain(manager)
        XCTAssertEqual(whileClosing.lastErrMsg, Self.reachMaxErrMsg,
                       "a socket whose close is still in flight has not given its slot back yet")

        transports[0].delegate?.transport(transports[0], didCloseWithCode: 1000, reason: nil)
        drain(manager)

        let afterClose = CallbackRecorder()
        manager.connectSocket(params: DMPMap(["socketId": "s6", "url": "wss://example.com/socket"]),
                              appId: "app1", appVersion: "0", callback: afterClose.makeCallback())
        drain(manager)
        XCTAssertEqual(afterClose.lastSuccessErrMsg, "connectSocket:ok",
                       "the slot comes back with the close event, not before it")
    }
}

// MARK: - User-supplied request headers have exactly one application site

/// Caller-supplied headers reach the network through `dialableHeaderFields` and nowhere else: it is
/// where two spellings of one field name get collapsed to a defined winner. A second place that
/// builds a `URLRequest` out of a caller's header dictionary would not go through it, and would
/// quietly bring back per-call nondeterminism on that path only — a split no behavioural test can
/// catch, since a behavioural test can only exercise the paths that exist. So this checks the shape
/// of the source instead: exactly one site applies caller-derived header fields.
final class DMPWebSocketRequestHeaderSingleExitTests: XCTestCase {

    private func websocketSource(_ fileName: String) throws -> [String] {
        let networkDirectory = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // DiminaKitTests
            .deletingLastPathComponent()   // iOS
            .appendingPathComponent("dimina/DiminaKit/Container/Api/Network")
        let source = try String(contentsOf: networkDirectory.appendingPathComponent(fileName), encoding: .utf8)
        return source.components(separatedBy: .newlines)
    }

    func test_managerAppliesRequestHeadersAtOneSiteOnly() throws {
        let lines = try websocketSource("DMPWebSocketManager.swift")
        let applications = lines.enumerated().filter { $0.element.contains("forHTTPHeaderField:") }

        let containerOwned = applications.filter { $0.element.contains("Sec-WebSocket-Protocol") }
        let callerSupplied = applications.filter { !$0.element.contains("Sec-WebSocket-Protocol") }

        XCTAssertEqual(containerOwned.count, 1, "the container sets exactly one header of its own on the dial")
        XCTAssertEqual(callerSupplied.count, 1,
                       """
                       caller-supplied headers must be applied at exactly one site, fed by \
                       dialableHeaderFields; found \(callerSupplied.count) at lines \
                       \(callerSupplied.map { $0.offset + 1 }). A new site has to route through \
                       dialableHeaderFields too, or header-name collisions become nondeterministic \
                       again on that path alone.
                       """)

        let site = try XCTUnwrap(callerSupplied.first)
        let precedingWindow = lines[max(0, site.offset - 2)..<site.offset].joined(separator: "\n")
        XCTAssertTrue(precedingWindow.contains("dialableHeaderFields("),
                      "the single application site must iterate dialableHeaderFields, got:\n\(precedingWindow)")
    }

    func test_noOtherWebSocketFileAppliesRequestHeaders() throws {
        for fileName in ["WebSocketAPI.swift", "DMPWebSocketValidation.swift"] {
            let offenders = try websocketSource(fileName)
                .enumerated()
                .filter { $0.element.contains("forHTTPHeaderField:") }
            XCTAssertTrue(offenders.isEmpty,
                          "\(fileName) must not build request headers of its own; found at lines \(offenders.map { $0.offset + 1 })")
        }
    }
}
