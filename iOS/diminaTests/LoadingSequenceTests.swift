import Testing
import UIKit
@testable import dimina

@Suite(.serialized)
@MainActor
struct LoadingSequenceTests {
    private let api = InteractionAPI()
    private let env = DMPBridgeEnv(appIndex: -1, appId: "loading-sequence", webViewId: 1)

    private func call(_ name: String, title: String = "Loading") {
        let handler = name == "showLoading" ? api.showLoading : api.hideLoading
        _ = handler(DMPBridgeParam(value: ["title": title, "mask": true]), env, nil)
    }
    private func drainMainQueue() async {
        // Both the bridge and presenter enqueue UI work in the existing implementation.
        for _ in 0..<3 {
            await withCheckedContinuation { continuation in
                DispatchQueue.main.async { continuation.resume() }
            }
        }
    }
    private func windows() -> [UIWindow] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).filter { $0.windowLevel == .alert + 1 && !$0.isHidden }
    }
    private func contains(_ view: UIView, title: String) -> Bool {
        (view as? UILabel)?.text == title || view.subviews.contains { contains($0, title: title) }
    }
    private func settleAnimations(expectingHidden: Bool = false) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while true {
            // Commit queued UIKit animations before checking their actual state.
            CATransaction.flush()
            let visible = windows()
            let animating = visible.contains { !($0.layer.animationKeys() ?? []).isEmpty }
            if !animating && (!expectingHidden || visible.isEmpty) {
                await drainMainQueue() // Deliver any interrupted animation's completion.
                return
            }
            try #require(clock.now < deadline, "Toast windows did not settle: \(visible)")
            // Yield for UIKit; elapsed time alone never satisfies this wait.
            try await clock.sleep(for: .milliseconds(10))
        }
    }

    @Test(arguments: [Float(1), Float(0.25)])
    func secondLoadingSurvivesFirstHideAnimationAndCanBeHidden(animationSpeed: Float) async throws {
        call("showLoading", title: "First")
        await drainMainQueue()
        let firstWindow = try #require(windows().first { contains($0, title: "First") })
        // Exercise slower animation completion without blocking the main thread.
        firstWindow.layer.speed = animationSpeed
        defer { firstWindow.layer.speed = 1 }
        try await settleAnimations()
        #expect(windows().contains { contains($0, title: "First") })
        call("hideLoading")
        await drainMainQueue() // Start fade-out, then replace it before completion.
        call("showLoading", title: "Second")
        await drainMainQueue()
        try await settleAnimations()
        let visible = windows().filter { contains($0, title: "Second") && $0.alpha == 1 }
        #expect(visible.count == 1)
        if let window = visible.first {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("loading-second-show.png")
            try image.pngData()?.write(to: url)
            print("LOADING_SCREENSHOT=\(url.path)")
        }
        call("hideLoading")
        await drainMainQueue()
        try await settleAnimations(expectingHidden: true)
        #expect(windows().isEmpty)
    }

    @Test func rapidDoubleCycleEndsHiddenAndNextShowWorks() async throws {
        call("showLoading"); call("hideLoading")
        call("showLoading"); call("hideLoading")
        await drainMainQueue()
        try await settleAnimations(expectingHidden: true)
        #expect(windows().isEmpty)
        call("showLoading", title: "Fresh")
        await drainMainQueue()
        try await settleAnimations()
        #expect(windows().filter { contains($0, title: "Fresh") }.count == 1)
        call("hideLoading")
        await drainMainQueue()
        try await settleAnimations(expectingHidden: true)
        #expect(windows().isEmpty)
    }

    @Test func oldToastTimeoutCannotHideReplacementLoading() async throws {
        _ = api.showToast(DMPBridgeParam(value: ["title": "Toast", "duration": 50]), env, nil)
        await drainMainQueue()
        call("showLoading", title: "Persistent")
        await drainMainQueue()
        try await settleAnimations()
        #expect(windows().filter { contains($0, title: "Persistent") && $0.alpha == 1 }.count == 1)
        call("hideLoading")
        await drainMainQueue()
        try await settleAnimations(expectingHidden: true)
        #expect(windows().isEmpty)
    }

    @Test func repeatedShowReplacesThePreviousWindow() async throws {
        call("showLoading", title: "Old")
        await drainMainQueue()
        call("showLoading", title: "New")
        await drainMainQueue()
        try await settleAnimations()
        #expect(windows().count == 1)
        #expect(windows().contains { contains($0, title: "New") })
        call("hideLoading"); call("hideLoading")
        await drainMainQueue()
        try await settleAnimations(expectingHidden: true)
        #expect(windows().isEmpty)
    }
}
