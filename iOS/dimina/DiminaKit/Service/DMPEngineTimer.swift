//
//  DMPEngineTimer.swift
//  dimina
//
//  Created by Lehem on 2025/5/12.
//

import Foundation
import JavaScriptCore

@available(iOS 13.0, *)
public final class DMPEngineTimer {

    private var timers = [Int: DispatchSourceTimer]()
    private var timerCounter = 0

    /// Keep short registry mutations independent from timer-source delivery. The source queue only
    /// forwards fires to the engine executor; all cancellation checks remain serialized here.
    private let stateQueue = DispatchQueue(label: "com.dimina.timer.state", qos: .userInitiated)
    private let sourceQueue = DispatchQueue(label: "com.dimina.timer.source", qos: .userInitiated)

    /// One timer manager belongs to one service engine. Keeping the manager instance-scoped makes
    /// timer ids, cancellation and teardown local to that engine instead of process-global.
    public init() {}

    deinit {
        clearAllTimers()
    }

    /// Registers timer functions for this manager's engine.
    ///
    /// `executor` must route callbacks to the thread that owns `context`. A timer source only
    /// schedules the fire; JavaScriptCore execution must not happen on the source queue because it
    /// could race another entry into the same context and split one JavaScript turn.
    public func registerTimerFunctions(to context: JSContext,
                                       executor: @escaping (@escaping () -> Void) -> Void) {
        let setTimeout: @convention(block) (JSValue, Double) -> Int = {
            [weak self, weak context] callback, delay in
            guard let self, let jsContext = context, !callback.isUndefined else {
                return 0
            }
            return self.createTimeout(
                callback: callback,
                context: jsContext,
                delay: delay,
                executor: executor
            )
        }

        let clearTimeout: @convention(block) (Int) -> Void = { [weak self] timerId in
            self?.clearTimer(timerId: timerId)
        }

        let setInterval: @convention(block) (JSValue, Double) -> Int = {
            [weak self, weak context] callback, interval in
            guard let self, let jsContext = context, !callback.isUndefined else {
                return 0
            }
            return self.createInterval(
                callback: callback,
                context: jsContext,
                interval: interval,
                executor: executor
            )
        }

        let clearInterval: @convention(block) (Int) -> Void = { [weak self] timerId in
            self?.clearTimer(timerId: timerId)
        }

        context.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)
        context.setObject(clearTimeout, forKeyedSubscript: "clearTimeout" as NSString)
        context.setObject(setInterval, forKeyedSubscript: "setInterval" as NSString)
        context.setObject(clearInterval, forKeyedSubscript: "clearInterval" as NSString)
    }

    private func createTimeout(callback: JSValue,
                               context: JSContext,
                               delay: Double,
                               executor: @escaping (@escaping () -> Void) -> Void) -> Int {
        return stateQueue.sync {
            timerCounter += 1
            let timerId = timerCounter
            let delayMs = normalizedMilliseconds(delay)

            let timer = DispatchSource.makeTimerSource(queue: sourceQueue)
            timer.schedule(deadline: .now() + .milliseconds(delayMs))
            timer.setEventHandler { [weak self, weak context] in
                guard let self else { return }
                executor { [weak self, weak context] in
                    guard let self else { return }
                    guard let jsContext = context,
                          self.isTimerLive(timerId: timerId),
                          !callback.isUndefined else {
                        self.removeTimer(timerId: timerId)
                        return
                    }
                    withExtendedLifetime(jsContext) {
                        callback.call(withArguments: [])
                    }
                    self.removeTimer(timerId: timerId)
                }
            }

            timers[timerId] = timer
            timer.resume()
            return timerId
        }
    }

    private func createInterval(callback: JSValue,
                                context: JSContext,
                                interval: Double,
                                executor: @escaping (@escaping () -> Void) -> Void) -> Int {
        return stateQueue.sync {
            timerCounter += 1
            let timerId = timerCounter
            // DispatchSourceTimer requires a positive repeating cadence. Zero-delay intervals are
            // still accepted, but clamp to the scheduler's smallest millisecond unit so the source
            // cannot spin continuously and enqueue callbacks without bound.
            let intervalMs = max(normalizedMilliseconds(interval), 1)

            let timer = DispatchSource.makeTimerSource(queue: sourceQueue)
            timer.schedule(
                deadline: .now() + .milliseconds(intervalMs),
                repeating: .milliseconds(intervalMs)
            )
            timer.setEventHandler { [weak self, weak context] in
                guard let self else { return }
                executor { [weak self, weak context] in
                    // An interval can fire several times before the JS thread drains. Every queued
                    // callback re-checks liveness so clearInterval or teardown suppresses all of
                    // the callbacks that have not started executing.
                    guard let self else { return }
                    guard let jsContext = context,
                          self.isTimerLive(timerId: timerId),
                          !callback.isUndefined else {
                        self.removeTimer(timerId: timerId)
                        return
                    }
                    withExtendedLifetime(jsContext) {
                        callback.call(withArguments: [])
                    }
                }
            }

            timers[timerId] = timer
            timer.resume()
            return timerId
        }
    }

    private func normalizedMilliseconds(_ value: Double) -> Int {
        guard value.isFinite, let milliseconds = Int(exactly: value.rounded()) else {
            return 0
        }
        return max(milliseconds, 0)
    }

    /// Read on the JS thread immediately before a queued callback runs, so cancellation or engine
    /// teardown wins the race with a timer source that has already fired.
    private func isTimerLive(timerId: Int) -> Bool {
        return stateQueue.sync { timers[timerId] != nil }
    }

    private func clearTimer(timerId: Int) {
        stateQueue.sync {
            guard let timer = timers.removeValue(forKey: timerId) else { return }
            timer.cancel()
        }
    }

    private func removeTimer(timerId: Int) {
        clearTimer(timerId: timerId)
    }

    /// Cancels only this manager's timers. Each DMPEngine owns a different manager instance.
    public func clearAllTimers() {
        stateQueue.sync {
            for timer in timers.values {
                timer.cancel()
            }
            timers.removeAll()
        }
    }
}
