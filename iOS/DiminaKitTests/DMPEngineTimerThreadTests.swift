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

    /// Same invariant for `setInterval`: its source queue schedules the fire, while the
    /// callback itself must execute on the engine's JS thread.
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
        // engine.destroy() cancels only this engine's still-running interval;
        // no manual clearInterval is needed.
    }

    // MARK: - Timers must be isolated between engines

    /// A process can host more than one mini program. Destroying one service engine must not
    /// cancel timers belonging to another engine.
    func test_destroyingOneEngine_doesNotCancelAnotherEnginesTimeoutOrInterval() {
        let engineA = makeInitializedEngine()
        let engineB = makeInitializedEngine()
        defer { engineB.destroy() }

        let timeoutFired = expectation(description: "engine B timeout fired")
        let intervalFired = expectation(description: "engine B interval fired twice")
        intervalFired.expectedFulfillmentCount = 2

        engineB.registerMethod(name: "__reportSurvivingTimeout") { _ in
            timeoutFired.fulfill()
            return nil
        }
        engineB.registerMethod(name: "__reportSurvivingInterval") { _ in
            intervalFired.fulfill()
            return nil
        }

        let armed = expectation(description: "engine B timers armed")
        Task {
            await engineB.evaluateScript("""
            setTimeout(function () { __reportSurvivingTimeout(); }, 300);
            var survivingIntervalCount = 0;
            var survivingIntervalId = setInterval(function () {
                survivingIntervalCount += 1;
                __reportSurvivingInterval();
                if (survivingIntervalCount === 2) clearInterval(survivingIntervalId);
            }, 200);
            """)
            armed.fulfill()
        }
        wait(for: [armed], timeout: 5)

        // Teardown must only reach A's engine-scoped timer manager.
        engineA.destroy()

        wait(for: [timeoutFired, intervalFired], timeout: 5)
    }

    /// Timer ids are meaningful only inside their engine. Even if two engines allocate the same
    /// numeric id, clearTimeout in B must never reach A's timer registry.
    func test_clearTimeoutInOneEngine_doesNotCancelAnotherEnginesTimer() {
        let engineA = makeInitializedEngine()
        let engineB = makeInitializedEngine()
        defer {
            engineA.destroy()
            engineB.destroy()
        }

        let timerIdReported = expectation(description: "engine A timer id reported")
        let timerFired = expectation(description: "engine A timer survived engine B clearTimeout")
        let timerIdLock = NSLock()
        var timerId: Int32?

        engineA.registerMethod(name: "__reportOwnedTimerId") { value in
            timerIdLock.lock()
            timerId = value.toInt32()
            timerIdLock.unlock()
            timerIdReported.fulfill()
            return nil
        }
        engineA.registerMethod(name: "__reportOwnedTimerFired") { _ in
            timerFired.fulfill()
            return nil
        }

        Task {
            await engineA.evaluateScript("""
            var ownedTimerId = setTimeout(function () { __reportOwnedTimerFired(); }, 400);
            __reportOwnedTimerId(ownedTimerId);
            """)
        }
        wait(for: [timerIdReported], timeout: 5)

        timerIdLock.lock()
        let reportedTimerId = timerId
        timerIdLock.unlock()
        guard let reportedTimerId else {
            return XCTFail("engine A did not return its timer id")
        }

        let clearCompleted = expectation(description: "engine B clearTimeout completed")
        Task {
            await engineB.evaluateScript("clearTimeout(\(reportedTimerId));")
            clearCompleted.fulfill()
        }
        wait(for: [clearCompleted, timerFired], timeout: 5)
    }

    /// Mirrors the service WebSocket event scheduler: the first deferred error sets a latch,
    /// close and later events queue behind it, and only the timeout callback resets the latch.
    /// If another engine can cancel that timeout, this queue remains permanently frozen.
    func test_destroyingOneEngine_doesNotFreezeAnotherEnginesDeferredEventQueue() {
        let engineA = makeInitializedEngine()
        let engineB = makeInitializedEngine()
        defer { engineB.destroy() }

        let log = ThreadSafeEventLog()
        let delivered = expectation(description: "engine B deferred events delivered")
        delivered.expectedFulfillmentCount = 3

        engineB.registerMethod(name: "__reportDeferredEvent") { value in
            log.record(value.toString() ?? "?")
            delivered.fulfill()
            return nil
        }

        let queueArmed = expectation(description: "engine B deferred queue armed")
        Task {
            await engineB.evaluateScript("""
            var eventDispatchQueue = [];
            var eventDispatchScheduled = false;
            function drainEventDispatchQueue() {
                eventDispatchScheduled = false;
                var pending = eventDispatchQueue.splice(0, eventDispatchQueue.length);
                pending.forEach(function (dispatch) { dispatch(); });
            }
            function deliverInOrderForTest(value, defer) {
                if (!defer && eventDispatchQueue.length === 0) {
                    __reportDeferredEvent(value);
                    return;
                }
                eventDispatchQueue.push(function () { __reportDeferredEvent(value); });
                if (eventDispatchScheduled) return;
                eventDispatchScheduled = true;
                setTimeout(drainEventDispatchQueue, 300);
            }
            deliverInOrderForTest('error', true);
            deliverInOrderForTest('close', false);
            """)
            queueArmed.fulfill()
        }
        wait(for: [queueArmed], timeout: 5)

        engineA.destroy()

        let laterEventQueued = expectation(description: "later engine B event queued")
        Task {
            await engineB.evaluateScript("deliverInOrderForTest('message', false);")
            laterEventQueued.fulfill()
        }
        wait(for: [laterEventQueued, delivered], timeout: 5)

        XCTAssertEqual(log.events, ["error", "close", "message"])
    }

    // MARK: - A multi-callout JS turn must not be split by a container message

    /// Guards the original thread-safety regression through production types: a setTimeout
    /// callback makes two native callouts in one JavaScript turn while a container message arrives
    /// through enqueueScript. Both entries must serialize on the engine's JS thread, so the message
    /// can run before or after that complete turn but never between its two callouts.
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
    /// The cancellation sequence runs off the main thread because destroy waits for the JS thread
    /// to stop, while this test deliberately keeps that thread blocked until cancellation occurs.
    func test_timerCancelledWhileItsCallbackIsQueued_doesNotRunTheCallback() {
        let engine = makeInitializedEngine()

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
            // Engine teardown cancels its own timers immediately, before the teardown closure
            // queued behind this blocked JS call gets a chance to run.
            engine.destroy()

            releaseBlocker.signal()
            Thread.sleep(forTimeInterval: 0.5)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 20)

        XCTAssertFalse(log.events.contains("FIRED"),
                        "a cancelled timer still ran its callback: \(log.events)")
    }

    /// Calls that race behind teardown must settle rather than being posted to a stopped run loop.
    func test_evaluateScriptAfterDestroy_returnsNilInsteadOfHanging() {
        let engine = makeInitializedEngine()
        engine.destroy()

        let settled = expectation(description: "post-destroy evaluation settled")
        Task {
            let result = await engine.evaluateScript("1 + 1")
            XCTAssertNil(result)
            settled.fulfill()
        }

        wait(for: [settled], timeout: 2)
    }
}
