import Foundation

final class DMPRuntimeDiagnostics: @unchecked Sendable {
    static let shared = DMPRuntimeDiagnostics()

    struct Call {
        fileprivate let generation: Int
        let id: String
        let api: String
        let appId: String
        let pagePath: String?
        let bridgeId: String?
    }

    private struct Event: Encodable {
        let sequence: Int
        let elapsedMs: Int
        let phase: String
        let appId: String
        let pagePath: String?
        let bridgeId: String?
        var resourceLoadId: String?
        var failure: String?
        var callId: String?
        var api: String?
        var outcome: String?
    }

    private struct Report: Encodable {
        let schemaVersion = 1
        let platform = "iOS"
        let versions: [String: String]
        let events: [Event]
    }

    private let lock = NSLock()
    private let eventLimit = 200
    private var enabled = false
    private var versions: [String: String] = [:]
    private var startedAt: UInt64 = 0
    private var generation = 0
    private var sequence = 0
    private var launchEvents: [Event] = []
    private var bridgeEvents: [Event] = []

    func configure(enabled: Bool, host: String?, sdk: String?, jssdk: String?, compiler: String?) {
        lock.lock()
        defer { lock.unlock() }
        self.enabled = enabled
        versions = ["host": host, "sdk": sdk, "jssdk": jssdk, "compiler": compiler].compactMapValues { $0 }
        startedAt = DispatchTime.now().uptimeNanoseconds
        generation += 1
        launchEvents.removeAll()
        bridgeEvents.removeAll()
    }

    func launch(
        _ phase: String, appId: String, pagePath: String? = nil, bridgeId: String? = nil,
        resourceLoadId: String? = nil, failure: String? = nil
    ) {
        lock.lock()
        defer { lock.unlock() }
        guard enabled else { return }
        var value = event(phase, appId: appId, pagePath: pagePath, bridgeId: bridgeId)
        value.resourceLoadId = resourceLoadId
        value.failure = failure
        Self.append(value, to: &launchEvents, limit: eventLimit)
    }

    func beginCall(_ api: String, appId: String, pagePath: String?, bridgeId: String?) -> Call? {
        lock.lock()
        defer { lock.unlock() }
        guard enabled else { return nil }
        let call = Call(generation: generation, id: "call-\(sequence + 1)", api: api,
                        appId: appId, pagePath: pagePath, bridgeId: bridgeId)
        appendCall(call, phase: "api-received", outcome: nil)
        return call
    }

    func recordCall(_ call: Call?, phase: String, outcome: String? = nil) {
        guard let call else { return }
        lock.lock()
        defer { lock.unlock() }
        guard enabled, call.generation == generation else { return }
        appendCall(call, phase: phase, outcome: outcome)
    }

    func json() -> String? {
        lock.lock()
        let report = enabled
            ? Report(versions: versions, events: (launchEvents + bridgeEvents).sorted { $0.sequence < $1.sequence })
            : nil
        lock.unlock()
        guard let report, let data = try? JSONEncoder().encode(report) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    private func event(_ phase: String, appId: String, pagePath: String?, bridgeId: String?) -> Event {
        sequence += 1
        let elapsedMs = Int((DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000)
        let path = pagePath.map { String($0.prefix { $0 != "?" && $0 != "#" }) }
        return Event(sequence: sequence, elapsedMs: elapsedMs, phase: phase,
                     appId: appId, pagePath: path, bridgeId: bridgeId)
    }

    private func appendCall(_ call: Call, phase: String, outcome: String?) {
        var value = event(phase, appId: call.appId, pagePath: call.pagePath, bridgeId: call.bridgeId)
        value.callId = call.id
        value.api = call.api
        value.outcome = outcome
        Self.append(value, to: &bridgeEvents, limit: eventLimit)
    }

    private static func append(_ event: Event, to events: inout [Event], limit: Int) {
        if events.count == limit { events.removeFirst() }
        events.append(event)
    }
}
