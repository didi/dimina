//
//  DMPWebSocketTestDoubles.swift
//  DiminaKitTests
//
//  Fakes for DMPWebSocketManagerTests: a scripted transport/factory and a
//  manually-advanced clock/timer substitute.

import Foundation
@testable import dimina

// MARK: - Fake scheduling (manual clock + timers)

final class FakeCancellable: DMPWebSocketCancellable {
    private let onCancel: () -> Void
    init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
    func cancel() { onCancel() }
}

/// A fully manual clock: `now()` and timer firing are both driven by
/// `advance(by:)`, so every timer-based race in the shared contract
/// (connect timeout, background grace, idle timeout) is deterministic.
final class FakeScheduling: DMPWebSocketScheduling {
    private struct Entry {
        let id: Int
        var fireAt: Double
        let block: () -> Void
        var cancelled: Bool
    }

    private(set) var currentSeconds: Double = 0
    private var entries: [Entry] = []
    private var nextId = 0

    func now() -> Double {
        return currentSeconds * 1000
    }

    func schedule(after seconds: TimeInterval, _ block: @escaping () -> Void) -> DMPWebSocketCancellable {
        let id = nextId
        nextId += 1
        entries.append(Entry(id: id, fireAt: currentSeconds + seconds, block: block, cancelled: false))
        return FakeCancellable { [weak self] in
            guard let self else { return }
            if let idx = self.entries.firstIndex(where: { $0.id == id }) {
                self.entries[idx].cancelled = true
            }
        }
    }

    /// Advances the clock and synchronously fires every non-cancelled timer
    /// due by the new time, in fire-time order.
    func advance(by seconds: TimeInterval) {
        currentSeconds += seconds
        while true {
            entries.sort { $0.fireAt < $1.fireAt }
            guard let idx = entries.firstIndex(where: { !$0.cancelled && $0.fireAt <= currentSeconds }) else { break }
            let entry = entries.remove(at: idx)
            entry.block()
        }
        entries.removeAll { $0.cancelled }
    }
}

// MARK: - Fake transport

final class FakeTransport: DMPSocketTransport {
    weak var delegate: DMPSocketTransportDelegate?

    private(set) var connectCallCount = 0
    private(set) var lastRequest: URLRequest?
    private(set) var sentTexts: [String] = []
    private(set) var sentData: [Data] = []
    private(set) var closeCalls: [(code: Int, reason: Data?)] = []
    private(set) var abortCallCount = 0

    /// What the next send completion reports.
    var sendResult: Error?
    /// If true (default), `close(code:reason:)` synchronously invokes the
    /// delegate's didClose callback, simulating an instantly-acked close.
    var autoAckClose = true

    init(delegate: DMPSocketTransportDelegate) {
        self.delegate = delegate
    }

    func connect(request: URLRequest) {
        connectCallCount += 1
        lastRequest = request
    }

    /// When true, send completions are held instead of invoked, so a test can decide when they
    /// land - the real transport reports a cancelled send asynchronously, well after teardown.
    var deferSendCompletions = false
    private var pendingSendCompletions: [(Error?) -> Void] = []

    func send(text: String, completion: @escaping (Error?) -> Void) {
        sentTexts.append(text)
        if deferSendCompletions {
            pendingSendCompletions.append(completion)
            return
        }
        completion(sendResult)
    }

    func send(data: Data, completion: @escaping (Error?) -> Void) {
        sentData.append(data)
        if deferSendCompletions {
            pendingSendCompletions.append(completion)
            return
        }
        completion(sendResult)
    }

    /// Fires every held send completion, in order.
    func flushSendCompletions() {
        let pending = pendingSendCompletions
        pendingSendCompletions.removeAll()
        for completion in pending {
            completion(sendResult)
        }
    }

    func close(code: Int, reason: Data?) {
        closeCalls.append((code, reason))
        if autoAckClose {
            delegate?.transport(self, didCloseWithCode: code, reason: reason)
        }
    }

    func abort() {
        abortCallCount += 1
    }

    // MARK: Simulate inbound transport/network events

    func simulateOpen(headers: [String: String] = [:]) {
        delegate?.transportDidOpen(self, headers: headers)
    }

    /// Reports the handshake phase boundaries the transport measured, in milliseconds since epoch
    /// (the unit `DMPWebSocketScheduling.now()` uses). On iOS these come from
    /// `URLSessionTaskMetrics`' `domainLookupStartDate` / `domainLookupEndDate` /
    /// `connectStartDate` / `connectEndDate`; a nil field means the phase did not happen or was
    /// not measured (a reused connection performs no DNS lookup, for instance).
    func simulateHandshakeMetrics(domainLookupStart: Double? = nil, domainLookupEnd: Double? = nil,
                                  connectStart: Double? = nil, connectEnd: Double? = nil) {
        delegate?.transport(self, didCollectHandshakeMetrics: DMPSocketHandshakeMetrics(
            domainLookupStart: domainLookupStart,
            domainLookupEnd: domainLookupEnd,
            connectStart: connectStart,
            connectEnd: connectEnd
        ))
    }

    func simulateText(_ text: String) {
        delegate?.transport(self, didReceiveText: text)
    }

    func simulateData(_ data: Data) {
        delegate?.transport(self, didReceiveData: data)
    }

    func simulateFailure(_ error: Error) {
        delegate?.transport(self, didCompleteWithError: error)
    }
}

final class FakeTransportFactory: DMPSocketTransportFactory {
    private(set) var createdTransports: [FakeTransport] = []

    func makeTransport(delegate: DMPSocketTransportDelegate) -> DMPSocketTransport {
        let transport = FakeTransport(delegate: delegate)
        createdTransports.append(transport)
        return transport
    }
}

// MARK: - Callback recorder (one-shot success/fail/complete)

final class CallbackRecorder {
    private(set) var successParams: [DMPMap] = []
    private(set) var failParams: [DMPMap] = []
    private(set) var completeParams: [DMPMap] = []
    private(set) var completeCount = 0

    func makeCallback() -> DMPBridgeCallback {
        return { [weak self] args, type in
            switch type {
            case .success: self?.successParams.append(args)
            case .fail: self?.failParams.append(args)
            case .complete:
                self?.completeParams.append(args)
                self?.completeCount += 1
            }
        }
    }

    /// The errMsg carried by the `complete` callback's own result object. `complete` fires for both
    /// outcomes and must describe the outcome it is completing.
    var lastCompleteErrMsg: String? {
        if let last = completeParams.last { return DMPWebSocketTestHelpers.errMsg(from: last) }
        return nil
    }

    var lastErrMsg: String? {
        if let last = failParams.last { return DMPWebSocketTestHelpers.errMsg(from: last) }
        return nil
    }

    var lastSuccessErrMsg: String? {
        if let last = successParams.last { return DMPWebSocketTestHelpers.errMsg(from: last) }
        return nil
    }
}

/// One recorded persistent event push captured via `DMPWebSocketManager.eventSinkForTest`.
struct RecordedEvent {
    let appId: String
    let callbackId: String
    let payload: DMPMap
}

enum DMPWebSocketTestHelpers {
    /// `invokeFailure` wraps errMsg under `data.errMsg`; `invokeSuccess` (as
    /// used by this Manager) puts it directly at the top level. Handle both.
    static func errMsg(from map: DMPMap) -> String? {
        if let direct = map.get("errMsg") as? String { return direct }
        if let data = map.get("data") as? [String: Any] { return data["errMsg"] as? String }
        return nil
    }
}
