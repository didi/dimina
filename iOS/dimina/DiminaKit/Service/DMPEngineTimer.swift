//
//  DMPEngineTimer.swift
//  dimina
//
//  Created by Lehem on 2025/5/12.
//

import Foundation
import JavaScriptCore

@available(iOS 13.0, *)
public class DMPEngineTimer {
    
    private var timers = [Int: DispatchSourceTimer]()
    private var timerCounter = 0
    private let queue = DispatchQueue(label: "com.dimina.timer", qos: .userInitiated)
    
    public static let shared = DMPEngineTimer()
    
    private init() {}
    
    /// `executor` is supplied by the caller registering these functions, not hardcoded here:
    /// this class is a `static`/`shared` singleton with no built-in notion of which engine's
    /// JS thread owns `context`. Every JS execution inside a `JSContext` must stay on the
    /// thread that context's engine assigned it: JavaScriptCore hands the context's lock over
    /// at each native callout, so a timer callback running on the queue backing the
    /// `DispatchSourceTimer` could interleave with a container message and split what the
    /// script treats as one uninterruptible turn. If this method is ever called
    /// for more than one engine's context, each registration's `executor` still routes that
    /// registration's callbacks to the right thread, because it is captured per closure rather
    /// than stored keyed only by timer id.
    ///
    /// Deliberately has no default. The timer source fires on the main queue, so any default
    /// would have to mean "run JS on the main thread" - exactly the race this parameter exists to
    /// remove, and silently, on whichever caller forgot to pass one. Adding the parameter breaks
    /// callers of the old `registerTimerFunctions(to:)`, and that break is the point: whoever
    /// registers these functions is the only one who knows which thread owns the context.
    public static func registerTimerFunctions(to context: JSContext,
                                             executor: @escaping (@escaping () -> Void) -> Void) {
        let setTimeout: @convention(block) (JSValue, Double) -> Int = {
            [weak context] callback, delay in
            guard let jsContext = context, !callback.isUndefined else {
                return 0
            }

            return shared.createTimeout(callback: callback, context: jsContext, delay: delay, executor: executor)
        }

        let clearTimeout: @convention(block) (Int) -> Void = { timerId in
            shared.clearTimer(timerId: timerId)
        }

        let setInterval: @convention(block) (JSValue, Double) -> Int = {
            [weak context] callback, interval in
            guard let jsContext = context, !callback.isUndefined else {
                return 0
            }

            return shared.createInterval(callback: callback, context: jsContext, interval: interval, executor: executor)
        }
        
        let clearInterval: @convention(block) (Int) -> Void = { timerId in
            shared.clearTimer(timerId: timerId)
        }
        
        context.setObject(setTimeout, forKeyedSubscript: "setTimeout" as NSString)
        context.setObject(clearTimeout, forKeyedSubscript: "clearTimeout" as NSString)
        context.setObject(setInterval, forKeyedSubscript: "setInterval" as NSString)
        context.setObject(clearInterval, forKeyedSubscript: "clearInterval" as NSString)
    }
    
    private func getNextTimerId() -> Int {
        return queue.sync {
            timerCounter += 1
            return timerCounter
        }
    }
    
    private func createTimeout(callback: JSValue, context: JSContext, delay: Double, executor: @escaping (@escaping () -> Void) -> Void) -> Int {
        return queue.sync {
            let timerId = timerCounter + 1
            timerCounter = timerId

            let delayMs: Int
            if delay.isFinite, let safeInt = Int(exactly: delay.rounded()) {
                delayMs = max(safeInt, 0)
            } else {
                delayMs = 0
            }

            // The DispatchSourceTimer only needs a queue to schedule its fire; it must not be
            // where JS runs. `executor` hops the actual callback + ref-count bookkeeping onto
            // the engine's own JS thread so it can never race a container message for the
            // JSContext's lock.
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
            timer.schedule(deadline: .now() + .milliseconds(delayMs))

            timer.setEventHandler { [weak context] in
                guard let jsContext = context, !callback.isUndefined else { return }

                executor {
                    // Cancellation is re-checked here, not only at fire time: hopping onto the
                    // engine's JS thread puts a gap between the two, and `cancel()` cannot reach
                    // a callback that is already in flight. Without this a `clearTimeout` - or a
                    // whole engine teardown - still lets one more JS execution through.
                    guard self.isTimerLive(timerId: timerId) else { return }

                    jsContext.virtualMachine.addManagedReference(callback, withOwner: self)

                    callback.call(withArguments: [])

                    jsContext.virtualMachine.removeManagedReference(callback, withOwner: self)

                    self.removeTimer(timerId: timerId)
                }
            }

            timers[timerId] = timer
            timer.resume()

            return timerId
        }
    }

    private func createInterval(callback: JSValue, context: JSContext, interval: Double, executor: @escaping (@escaping () -> Void) -> Void) -> Int {
        return queue.sync {
            let timerId = timerCounter + 1
            timerCounter = timerId

            let intervalMs: Int
            if interval.isFinite, let safeInt = Int(exactly: interval.rounded()) {
                intervalMs = max(safeInt, 0)
            } else {
                intervalMs = 0
            }

            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
            timer.schedule(
                deadline: .now() + .milliseconds(intervalMs),
                repeating: .milliseconds(intervalMs))

            timer.setEventHandler { [weak context] in
                guard let jsContext = context, !callback.isUndefined else { return }

                executor {
                    // An interval that fires faster than the JS thread drains can have several
                    // callbacks in flight at once; after `clearInterval` none of them may run.
                    guard self.isTimerLive(timerId: timerId) else { return }

                    jsContext.virtualMachine.addManagedReference(callback, withOwner: self)

                    callback.call(withArguments: [])

                    jsContext.virtualMachine.removeManagedReference(callback, withOwner: self)
                }
            }

            timers[timerId] = timer
            timer.resume()

            return timerId
        }
    }
    
    /// Whether `timerId` is still registered. Read on the JS thread right before a queued
    /// callback runs, so `clearTimeout` / `clearInterval` / `clearAllTimers` win the race with a
    /// timer that already fired.
    private func isTimerLive(timerId: Int) -> Bool {
        return queue.sync { timers[timerId] != nil }
    }

    private func clearTimer(timerId: Int) {
        queue.sync {
            if let timer = timers[timerId] {
                timer.cancel()
                timers.removeValue(forKey: timerId)
            }
        }
    }
    
    private func removeTimer(timerId: Int) {
        queue.sync {
            if let timer = timers[timerId] {
                timer.cancel()
                timers.removeValue(forKey: timerId)
            }
        }
    }
    
    public func clearAllTimers() {
        queue.sync {
            for (_, timer) in timers {
                timer.cancel()
            }
            timers.removeAll()
        }
    }
}
