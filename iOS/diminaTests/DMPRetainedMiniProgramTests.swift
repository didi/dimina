import Testing
import UIKit
@testable import dimina

extension DMPUIIntegrationTests {
    @Suite
    @MainActor
    struct DMPRetainedMiniProgramTests {
        private func makeApp(navigation hostNavigation: UINavigationController? = nil, registered: Bool = false, preservingOpener: Bool = false) async -> (DMPApp, DMPNavigator, UINavigationController) {
            let config = DMPAppConfig(appName: "retention", appId: UUID().uuidString)
            let app = registered ? DMPAppManager.sharedInstance().appWithConfig(appConfig: config)
                : DMPApp(appConfig: config, appIndex: -1)
            app.service = DMPService(app: app)
            app.render = DMPRender(app: app)
            let navigator = app.getNavigator()!
            let navigation = hostNavigation ?? UINavigationController(rootViewController: UIViewController())
            if preservingOpener {
                navigator.setup(navigationController: navigation, preserving: navigation.viewControllers)
            } else {
                navigator.setup(navigationController: navigation)
            }
            _ = await navigator.launch(to: "pages/index/index", animated: false, showsLaunchLoading: false)
            await navigator.navigateTo(to: "pages/detail/index", animated: false)
            return (app, navigator, navigation)
        }

        @Test func destroyAllRemovesVisibleRetainedAndSuspendedInstancesWithoutRestoringOpener() async throws {
            let manager = DMPAppManager.sharedInstance()
            let (hidden, hiddenNavigator, hiddenNavigation) = await makeApp(registered: true)
            await hiddenNavigator.hideMiniProgram()
            let (opener, openerNavigator, navigation) = await makeApp(registered: true)
            openerNavigator.suspendForMiniProgramNavigation()
            let (target, _, _) = await makeApp(navigation: navigation, registered: true, preservingOpener: true)
            manager.markOpenedByMiniProgramForTesting(target: target, opener: opener)
            let host = navigation.viewControllers.first

            try await manager.destroyAllMiniPrograms()
            await Task.yield() // A queued opener restoration must not revive it.
            for app in [hidden, opener, target] {
                #expect(app.service == nil)
                #expect(manager.existApp(appId: app.getAppId()) == nil)
            }
            #expect(!hiddenNavigator.isRetainedInBackground)
            #expect(hiddenNavigation.viewControllers.count == 1)
            #expect(navigation.viewControllers.count == 1)
            #expect(navigation.topViewController === host)
            try await manager.destroyAllMiniPrograms()
            let fresh = manager.appWithConfig(appConfig: DMPAppConfig(appName: "fresh", appId: target.getAppId()))
            #expect(fresh !== target)
            fresh.destroy()
        }

        @Test func destroyAllRejectsOverlappingNavigationBeforeRemovingInstances() async throws {
            let manager = DMPAppManager.sharedInstance()
            let (app, navigator, _) = await makeApp(registered: true)
            try await manager.withMiniProgramOperation {
                do {
                    try await manager.destroyAllMiniPrograms()
                    Issue.record("Expected operationInProgress")
                } catch {
                    #expect(manager.existApp(appId: app.getAppId()) === app)
                    #expect(app.service != nil)
                }
            }
            await navigator.hideMiniProgram()
            try await manager.destroyAllMiniPrograms()
        }

        @Test func restoresTheSamePagesAndRuntimeAcrossRepeatedHides() async throws {
            let (app, navigator, navigation) = await makeApp()
            defer { app.destroy() }
            let controllers = navigation.viewControllers
            let detail = try #require(controllers.last as? DMPPageController)
            let webView = detail.getWebView()
            let service = app.service
            let pageId = app.getCurrentWebViewId()

            for _ in 0..<2 {
                await navigator.hideMiniProgram()
                #expect(navigator.isRetainedInBackground)
                #expect(!navigator.isActiveNavigationOwner())
                #expect(navigation.viewControllers.count == 1)
                #expect(app.getCurrentWebViewId() == pageId)
                #expect(app.service === service)
                // A timer in the hidden app must not pop the host's stack.
                navigator.navigateBack(animated: false)
                #expect(navigation.viewControllers.count == 1)

                navigator.setup(navigationController: navigation)
                await app.launch(launchConfig: DMPLaunchConfig())
                #expect(!navigator.isRetainedInBackground)
                #expect(navigator.isActiveNavigationOwner())
                #expect(navigation.viewControllers.count == controllers.count)
                #expect(navigation.topViewController === detail)
                #expect(detail.getWebView() === webView)
                #expect(app.service === service)
            }
            await navigator.hideMiniProgram()
        }

        @Test func destroyingHiddenAppDoesNotTouchAnotherAppPresentation() async {
            let (first, firstNavigator, firstNavigation) = await makeApp()
            await firstNavigator.hideMiniProgram()
            let (second, secondNavigator, secondNavigation) = await makeApp(navigation: firstNavigation)
            defer { second.destroy() }
            let secondTop = secondNavigation.topViewController

            first.destroy()
            #expect(first.service == nil)
            #expect(!firstNavigator.isRetainedInBackground)
            #expect(firstNavigation.viewControllers.count == 3)
            #expect(secondNavigator.isActiveNavigationOwner())
            #expect(secondNavigation.topViewController === secondTop)
            await secondNavigator.hideMiniProgram()
        }
        @Test func capacityExpiryAndPressureReclaimOnlyDetachedInstances() async {
            let manager = DMPAppManager.sharedInstance()
            var now: TimeInterval = 0
            manager.retentionClock = { now }
            manager.configureRetention(DMPRetentionPolicy(maxBackgroundApps: 1, backgroundTimeoutMs: 100_000))
            let (first, firstNavigator, firstNavigation) = await makeApp(registered: true)
            await firstNavigator.hideMiniProgram()
            now = 10
            let (second, secondNavigator, secondNavigation) = await makeApp(registered: true)
            await secondNavigator.hideMiniProgram()
            manager.collectRetainedApps()
            #expect(manager.existApp(appId: first.getAppId()) == nil)
            #expect(first.service == nil)
            #expect(manager.existApp(appId: second.getAppId()) === second)

            let (active, activeNavigator, navigation) = await makeApp(registered: true)
            defer {
                withExtendedLifetime((firstNavigation, secondNavigation)) {}
                first.destroy(); second.destroy(); active.destroy()
                manager.retentionClock = { DMPRetentionClock.now() }
                manager.configureRetention(DMPRetentionPolicy())
            }
            let top = navigation.topViewController
            now = 109
            manager.collectRetainedApps()
            #expect(manager.existApp(appId: second.getAppId()) === second)
            now = 110
            manager.collectRetainedApps()
            #expect(manager.existApp(appId: second.getAppId()) == nil)
            manager.notifyMemoryPressure()
            manager.collectRetainedApps()
            #expect(activeNavigator.isActiveNavigationOwner())
            #expect(navigation.topViewController === top)
            #expect(active.service != nil)
            await activeNavigator.hideMiniProgram()
            manager.notifyMemoryPressure()
            manager.collectRetainedApps()
            #expect(active.service == nil)
            #expect(manager.existApp(appId: active.getAppId()) == nil)
        }

        @Test func reentryCancelsOldExpiryAndStartsANewLease() async {
            let manager = DMPAppManager.sharedInstance()
            var now: TimeInterval = 0
            manager.retentionClock = { now }
            manager.configureRetention(DMPRetentionPolicy(maxBackgroundApps: 3, backgroundTimeoutMs: 100_000))
            let (app, navigator, navigation) = await makeApp(registered: true)
            defer {
                withExtendedLifetime(navigation) {}
                app.destroy()
                manager.retentionClock = { DMPRetentionClock.now() }
                manager.configureRetention(DMPRetentionPolicy())
            }
            let service = app.service
            await navigator.hideMiniProgram()
            now = 90
            await app.launch(launchConfig: DMPLaunchConfig())
            now = 200
            manager.collectRetainedApps()
            #expect(app.service === service)
            #expect(navigator.isActiveNavigationOwner())
            await navigator.hideMiniProgram()
            now = 299
            manager.collectRetainedApps()
            #expect(app.service === service)
            now = 300
            manager.collectRetainedApps()
            #expect(app.service == nil)
            #expect(manager.existApp(appId: app.getAppId()) == nil)
        }

        @Test func pressureWaitsForNavigationTransactionBeforeDestroyingRetainedPages() async throws {
            let manager = DMPAppManager.sharedInstance()
            let (app, navigator, navigation) = await makeApp(registered: true)
            defer { withExtendedLifetime(navigation) {}; app.destroy() }
            await navigator.hideMiniProgram()
            try await manager.withMiniProgramOperation {
                manager.notifyMemoryPressure()
                manager.collectRetainedApps()
                #expect(app.service != nil)
                #expect(navigator.isRetainedInBackground)
            }
            manager.collectRetainedApps()
            #expect(app.service == nil)
            #expect(!navigator.isRetainedInBackground)
        }

    }
}
