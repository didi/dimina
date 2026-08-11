//
//  DMPEngineTimerThreadTests.swift
//  DiminaKitTests
//
//  Guards the invariant that every JS execution inside the service engine's
//  JSContext happens on the engine's own JS thread ("com.dimina.jsengine.thread"),
//  including setTimeout/setInterval callbacks. A JSContext entered from two OS
//  threads hands its internal lock off at every native callout boundary, so a
//  script sequence that assumes it is one uninterruptible turn can be split by
//  a message arriving on the correctly-serialized thread while the
//  wrongly-serialized thread is mid-callout. Timer callbacks were the one entry
//  point that scheduled JS off the jsThread; every other path reaches the
//  context through `DMPEngine.performOnJSThread`.

import XCTest
@testable import dimina

private let jsEngineThreadName = "com.dimina.jsengine.thread"

/// Appends events under a lock so callers on unrelated OS threads (main, the
/// engine's jsThread, background queues) can record without racing each
/// other. This log is test infrastructure, not part of what is under test.
final class ThreadSafeEventLog {
    private let lock = NSLock()
    private var storage: [String] = []

    func record(_ event: String) {
        lock.lock()
        defer { lock.unlock() }
        storage.append(event)
    }

    var events: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

final class DMPEngineTimerThreadTests: XCTestCase {

    private func makeInitializedEngine() -> DMPEngine {
        let engine = DMPEngine()
        let ready = expectation(description: "engine initialized")
        engine.onInitialized { ready.fulfill() }
        wait(for: [ready], timeout: 5)
        return engine
    }

    // MARK: - setTimeout / setInterval callbacks must run on the JS thread

    /// `setTimeout`'s callback must execute on the engine's dedicated JS
    /// thread, not on whatever thread `DispatchSourceTimer` happens to fire
    /// its event handler on. Asserts on the runtime's own answer (the thread
    /// the native callout actually landed on), not on an indirect proxy.
    func test_setTimeoutCallback_executesOnDedicatedJSEngineThread() {
        let engine = makeInitializedEngine()
        defer { engine.destroy() }

        let fired = expectation(description: "setTimeout callback fired")
        var observedThreadName: String?
        var observedIsMainThread: Bool?

        engine.registerMethod(name: "__reportThread") { _ in
            observedThreadName = Thread.current.name
            observedIsMainThread = Thread.isMainThread
            fired.fulfill()
            return nil
        }

        Task {
            await engine.evaluateScript("setTimeout(function () { __reportThread(); }, 5);")
        }

        wait(for: [fired], timeout: 5)

        XCTAssertEqual(observedIsMainThread, false,
                        "setTimeout callback ran on the main thread; it must run on \(jsEngineThreadName)")
        XCTAssertEqual(observedThreadName, jsEngineThreadName,
                        "setTimeout callback ran on thread \(observedThreadName ?? "nil"), expected \(jsEngineThreadName)")
    }

    /// Same invariant for `setInterval` (`DMPEngineTimer.swift:108/118` share
    /// the same `DispatchQueue.main` scheduling as setTimeout).
    func test_setIntervalCallback_executesOnDedicatedJSEngineThread() {
        let engine = makeInitializedEngine()
        defer { engine.destroy() }

        let fired = expectation(description: "setInterval callback fired")
        let fulfillLock = NSLock()
        var didFulfill = false
        var observedThreadName: String?
        var observedIsMainThread: Bool?

        engine.registerMethod(name: "__reportIntervalThread") { _ in
            fulfillLock.lock()
            defer { fulfillLock.unlock() }
            guard !didFulfill else { return nil }
            didFulfill = true
            observedThreadName = Thread.current.name
            observedIsMainThread = Thread.isMainThread
            fired.fulfill()
            return nil
        }

        Task {
            await engine.evaluateScript("setInterval(function () { __reportIntervalThread(); }, 5);")
        }

        wait(for: [fired], timeout: 5)

        XCTAssertEqual(observedIsMainThread, false,
                        "setInterval callback ran on the main thread; it must run on \(jsEngineThreadName)")
        XCTAssertEqual(observedThreadName, jsEngineThreadName,
                        "setInterval callback ran on thread \(observedThreadName ?? "nil"), expected \(jsEngineThreadName)")
        // engine.destroy() cancels the still-running interval via
        // DMPEngineTimer.shared.clearAllTimers(); no manual clearInterval needed.
    }

    // MARK: - A multi-callout JS turn must not be split by a container message

    /// Reproduces the root-cause mechanism through the production types
    /// directly: a `setTimeout` callback (today scheduled on
    /// `DispatchQueue.main`, bypassing the engine's jsThread serialization)
    /// makes two consecutive native callouts within what the script treats as
    /// one turn. Concurrently, a message arrives via `enqueueScript` - the
    /// same call `DMPService.swift:95` uses to push a container event into the
    /// service engine, correctly serialized onto jsThread. JavaScriptCore
    /// hands its context lock off at native-callout boundaries,
    /// so the two unsynchronized entrants can interleave: the message's
    /// script runs between the turn's first and second callout instead of
    /// before or after it. Runs the race several times because the
    /// interleaving is a timing window, not guaranteed on every single
    /// attempt.
    func test_multiCalloutTurn_isNotSplitByConcurrentContainerMessage() {
        let engine = makeInitializedEngine()
        defer { engine.destroy() }

        let attempts = 5
        for attempt in 0..<attempts {
            let log = ThreadSafeEventLog()
            let calloutTag = "iter\(attempt)"
            let done = expectation(description: "race iteration \(attempt) settled")
            done.expectedFulfillmentCount = 3 // step 'A', step 'B', the container message

            engine.registerMethod(name: "__slowStep_\(calloutTag)") { args in
                let step = args.toString() ?? "?"
                log.record("\(step)-start")
                // Widens the JSC-lock handoff window the same way the
                // root-cause report's minimal repro does (~50ms), so the
                // window is observable within a single test run instead of
                // relying on rare scheduling luck.
                Thread.sleep(forTimeInterval: 0.05)
                log.record("\(step)-end")
                done.fulfill()
                return nil
            }
            engine.registerMethod(name: "__message_\(calloutTag)") { _ in
                log.record("MSG")
                done.fulfill()
                return nil
            }

            Task {
                await engine.evaluateScript("""
                setTimeout(function () {
                    __slowStep_\(calloutTag)('A');
                    __slowStep_\(calloutTag)('B');
                }, 0);
                """)
            }

            // Lands the container message inside step A's sleep window,
            // mirroring how a real inbound container/WebSocket event can
            // arrive mid-turn.
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) {
                engine.enqueueScript("__message_\(calloutTag)();")
            }

            wait(for: [done], timeout: 5)

            let events = log.events
            guard let aStart = events.firstIndex(of: "A-start"),
                  let bEnd = events.firstIndex(of: "B-end") else {
                XCTFail("iteration \(attempt) did not observe both callouts: \(events)")
                continue
            }
            let interior = events[(aStart + 1)..<bEnd]
            XCTAssertFalse(interior.contains("MSG"),
                            "iteration \(attempt): container message ran inside the multi-callout turn: \(events)")
        }
    }

    // MARK: - A cancelled timer must not run a callback that is already queued

    /// Routing timer callbacks to the JS thread puts a hop between "the timer
    /// fired" and "the callback runs", and `DispatchSourceTimer.cancel()`
    /// cannot reach into that hop. So cancellation has to be re-checked at the
    /// moment the callback runs: a mini program that called `clearTimeout`, or
    /// an engine that has been torn down, must not get one more JS execution
    /// out of a timer everyone already considers dead.
    ///
    /// The sequence is driven off the main thread on purpose - the timer source
    /// fires on the main queue, so blocking main here would keep the timer from
    /// firing at all and the test would pass without ever reaching the window
    /// it is meant to cover.
    func test_timerCancelledWhileItsCallbackIsQueued_doesNotRunTheCallback() {
        let engine = makeInitializedEngine()
        defer { engine.destroy() }

        let log = ThreadSafeEventLog()
        let blockerEntered = DispatchSemaphore(value: 0)
        let releaseBlocker = DispatchSemaphore(value: 0)

        engine.registerMethod(name: "__holdJsThread") { _ in
            blockerEntered.signal()
            releaseBlocker.wait()
            return nil
        }
        engine.registerMethod(name: "__cancelledTimerFired") { _ in
            log.record("FIRED")
            return nil
        }

        let armed = expectation(description: "timer armed")
        Task {
            await engine.evaluateScript("setTimeout(function () { __cancelledTimerFired(); }, 400);")
            armed.fulfill()
        }
        wait(for: [armed], timeout: 5)

        let finished = expectation(description: "cancellation sequence finished")
        DispatchQueue.global().async {
            // Occupy the JS thread before the timer's deadline, so when it does
            // fire its callback lands behind this callout instead of running.
            engine.enqueueScript("__holdJsThread();")
            XCTAssertEqual(blockerEntered.wait(timeout: .now() + 5), .success,
                           "the JS thread never entered the blocking callout")

            Thread.sleep(forTimeInterval: 0.7)
            DMPEngineTimer.shared.clearAllTimers()

            releaseBlocker.signal()
            Thread.sleep(forTimeInterval: 0.5)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 20)

        XCTAssertFalse(log.events.contains("FIRED"),
                        "a cancelled timer still ran its callback: \(log.events)")
    }
}
