//
//  DMPNavigatorCapsuleTests.swift
//  diminaTests
//

import UIKit
import XCTest
@testable import dimina

@MainActor
final class DMPNavigatorCapsuleTests: XCTestCase {

    func testCompleteReceivesTheSameResultObjectByDefault() {
        let result = DMPMap(["errMsg": "example:ok"])
        var callbacks: [(DMPBridgeCallbackType, DMPMap)] = []

        DMPContainerApi.invokeSuccess(callback: { args, type in
            callbacks.append((type, args))
        }, param: result)

        XCTAssertEqual(callbacks.map(\.0), [.success, .complete])
        XCTAssertTrue(callbacks[0].1 === result)
        XCTAssertTrue(callbacks[1].1 === result)
    }

    func testFileSystemSyncFailureReturnsThrowableBridgeResult() throws {
        _ = DMPContainerApi.create()
        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.accessSync"))

        let result = handler(
            DMPBridgeParam(value: ["path": "difile://usr/definitely-missing"]),
            DMPBridgeEnv(appIndex: 0, appId: "sync-error-test", webViewId: 0),
            nil
        )

        let errorResult = try XCTUnwrap(result as? DMPErrorResult)
        XCTAssertTrue(errorResult.message.contains("FileSystemManager:fail"))
    }

    func testOpenFileDescriptorsAreOwnerScopedAndClearedWithTheApp() throws {
        _ = DMPContainerApi.create()
        let appId = "file-owner-\(UUID().uuidString)"
        let ownerEnv = DMPBridgeEnv(appIndex: 0, appId: appId, webViewId: 0)
        let otherEnv = DMPBridgeEnv(appIndex: 1, appId: "other-\(appId)", webViewId: 0)
        let filePath = "difile://usr/handle.txt"
        let write = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.writeFileSync"))
        let open = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.openSync"))
        let fstat = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.fstatSync"))
        let unlink = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.unlinkSync"))

        _ = write(DMPBridgeParam(value: ["filePath": filePath, "data": "content", "encoding": "utf8"]), ownerEnv, nil)
        let openResult = try XCTUnwrap(open(
            DMPBridgeParam(value: ["filePath": filePath, "flag": "r"]), ownerEnv, nil
        ) as? DMPSyncResult)
        let fd = try XCTUnwrap(openResult.value as? String)

        XCTAssertTrue(fstat(DMPBridgeParam(value: ["fd": fd]), otherEnv, nil) is DMPErrorResult)
        FileAPI.clearOpenFiles(appId: appId)
        XCTAssertTrue(fstat(DMPBridgeParam(value: ["fd": fd]), ownerEnv, nil) is DMPErrorResult)

        _ = unlink(DMPBridgeParam(value: ["filePath": filePath]), ownerEnv, nil)
    }

    func testGeneratedSaveFilePathsNeverOverwriteEarlierSaves() throws {
        _ = DMPContainerApi.create()
        let appId = "save-file-\(UUID().uuidString)"
        let env = DMPBridgeEnv(appIndex: 0, appId: appId, webViewId: 0)
        let tempPath = "difile://tmp/same-name.txt"
        let write = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.writeFileSync"))
        let save = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.saveFileSync"))
        let read = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.readFileSync"))
        let unlink = try XCTUnwrap(DMPContainerApi.getHandler(for: "FileSystemManager.unlinkSync"))

        _ = write(DMPBridgeParam(value: ["filePath": tempPath, "data": "first", "encoding": "utf8"]), env, nil)
        let first = try XCTUnwrap((save(
            DMPBridgeParam(value: ["tempFilePath": tempPath]), env, nil
        ) as? DMPSyncResult)?.value as? String)
        _ = write(DMPBridgeParam(value: ["filePath": tempPath, "data": "second", "encoding": "utf8"]), env, nil)
        let second = try XCTUnwrap((save(
            DMPBridgeParam(value: ["tempFilePath": tempPath]), env, nil
        ) as? DMPSyncResult)?.value as? String)

        XCTAssertNotEqual(first, second)
        XCTAssertEqual((read(
            DMPBridgeParam(value: ["filePath": first, "encoding": "utf8"]), env, nil
        ) as? DMPSyncResult)?.value as? String, "first")
        XCTAssertEqual((read(
            DMPBridgeParam(value: ["filePath": second, "encoding": "utf8"]), env, nil
        ) as? DMPSyncResult)?.value as? String, "second")

        _ = unlink(DMPBridgeParam(value: ["filePath": first]), env, nil)
        _ = unlink(DMPBridgeParam(value: ["filePath": second]), env, nil)
    }

    func testSetupInstallsOneContainerOwnedCapsule() {
        let navigationController = UINavigationController()
        navigationController.loadViewIfNeeded()
        let navigator = DMPNavigator()

        navigator.setup(navigationController: navigationController)
        navigator.setCapsuleVisible(true)

        XCTAssertEqual(capsules(in: navigationController.view).count, 1)
        XCTAssertFalse(capsules(in: navigationController.view)[0].isHidden)
    }

    func testRepeatedSetupReplacesRatherThanDuplicatesCapsule() {
        let navigationController = UINavigationController()
        navigationController.loadViewIfNeeded()
        let navigator = DMPNavigator()

        navigator.setup(navigationController: navigationController)
        navigator.setup(navigationController: navigationController)

        XCTAssertEqual(capsules(in: navigationController.view).count, 1)
    }

    func testCrossMiniProgramCloseKeepsTheCompleteOpenerStack() async {
        let host = UIViewController()
        let openerRoot = UIViewController()
        let openerDetail = UIViewController()
        let targetRoot = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers(
            [host, openerRoot, openerDetail, targetRoot],
            animated: false
        )

        let navigator = DMPNavigator()
        navigator.setup(
            navigationController: navigationController,
            preserving: [host, openerRoot, openerDetail]
        )

        let closed = expectation(description: "target closes")
        navigator.closeMiniProgram(animated: false) {
            closed.fulfill()
        }
        await fulfillment(of: [closed], timeout: 1)

        XCTAssertEqual(navigationController.viewControllers.count, 3)
        XCTAssertTrue(navigationController.viewControllers[0] === host)
        XCTAssertTrue(navigationController.viewControllers[1] === openerRoot)
        XCTAssertTrue(navigationController.viewControllers[2] === openerDetail)
        XCTAssertFalse(navigationController.viewControllers.contains { $0 === targetRoot })
    }

    /// 首页上的返回是一次退出，不是路由：微信没有 App 级销毁生命周期，关闭走
    /// onAppEnterBackground(mode: close)，服务侧只看到 App.onHide。
    func testBackOnTheEntryPageExitsToTheHostAndDispatchesAppHide() async throws {
        let appConfig = DMPAppConfig(appName: "exit", appId: "exit-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureEntryPageExit")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let host = UIViewController()
        let entryPage = DMPPageController(
            pagePath: "pages/index/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true
        )
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, entryPage], animated: false)
        navigator.setup(navigationController: navigationController)

        navigator.navigateBack(animated: false)
        // 页面控制器的销毁跟着转场走，退出返回后才发生。断言必须跨过它，否则那条迟到的
        // pageUnload 落在测量窗口之外，看起来像没发生过。
        entryPage.destroy()
        await service.drainPendingContainerMessages()

        XCTAssertEqual(recorder.types, ["appHide"])
        XCTAssertEqual(navigationController.viewControllers.count, 1)
        XCTAssertTrue(navigationController.viewControllers[0] === host)
    }

    /// closeMiniProgram 拆的是整个页面栈，页面控制器随转场销毁。退出不是路由，
    /// 这条销毁路径也不能补 pageUnload。
    func testClosingTheMiniProgramNeverUnloadsPagesEvenAfterTheTransitionDestroysThem() async throws {
        let appConfig = DMPAppConfig(appName: "close", appId: "close-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureCloseTeardown")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let host = UIViewController()
        let entryPage = DMPPageController(
            pagePath: "pages/index/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true
        )
        let detailPage = DMPPageController(
            pagePath: "pages/detail/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: false
        )
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, entryPage, detailPage], animated: false)
        navigator.setup(navigationController: navigationController)

        navigator.closeMiniProgram(animated: false) {}
        entryPage.destroy()
        detailPage.destroy()
        await service.drainPendingContainerMessages()

        XCTAssertFalse(recorder.types.contains("pageUnload"))
    }

    /// 冷重启是「关掉再重开」而不是一次路由：旧运行时整体销毁，旧页面不补 onUnload。
    func testReloadingTheRuntimeNeverUnloadsTheOldPages() async throws {
        let appConfig = DMPAppConfig(appName: "reload", appId: "reload-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureReloadTeardown")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let host = UIViewController()
        let entryPage = DMPPageController(
            pagePath: "pages/index/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true
        )
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, entryPage], animated: false)
        navigator.setup(navigationController: navigationController)

        // prepareRuntime 返回 nil：这条用例只看拆掉旧页面这一半，不需要真的建出新运行时。
        let reloaded = await navigator.reloadMiniProgram(animated: false) { nil }
        entryPage.destroy()
        await service.drainPendingContainerMessages()

        XCTAssertFalse(reloaded)
        XCTAssertFalse(recorder.types.contains("pageUnload"))
    }

    /// Tab 页经 DMPTabBarContainerController.destroy() 走同一条销毁路径，退出时同样不发 pageUnload。
    func testClosingTheMiniProgramNeverUnloadsTabPages() async throws {
        let appConfig = DMPAppConfig(appName: "tab-exit", appId: "tab-exit-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureTabExitTeardown")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let tabBarConfig = DMPTabBarConfig(
            color: "#999999",
            selectedColor: "#000000",
            borderStyle: "black",
            backgroundColor: "#FFFFFF",
            list: [
                DMPTabBarItem(
                    pagePath: "pages/home/index",
                    iconPath: "",
                    selectedIconPath: "",
                    text: "Home"
                ),
            ]
        )
        let tabBarController = DMPTabBarContainerController(
            initialPath: "pages/home/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            tabBarConfig: tabBarConfig,
            showsLaunchLoading: false
        )
        let preparedTab = await tabBarController.prepareInitialTab()
        let record = try XCTUnwrap(preparedTab)
        XCTAssertGreaterThan(record.webViewId, 0)

        let host = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, tabBarController], animated: false)
        navigator.setup(navigationController: navigationController)

        navigator.closeMiniProgram(animated: false) {}
        tabBarController.destroy()
        await service.drainPendingContainerMessages()

        XCTAssertFalse(recorder.types.contains("pageUnload"))
    }

    /// 反过来的那一半：路由确实卸载页面，销毁路径照常发 pageUnload。
    func testRoutingTeardownStillUnloadsThePage() async throws {
        let appConfig = DMPAppConfig(appName: "routing", appId: "routing-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureRoutingTeardown")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let page = DMPPageController(
            pagePath: "pages/detail/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: false
        )

        page.destroy()
        await service.drainPendingContainerMessages()

        XCTAssertTrue(recorder.types.contains("pageUnload"))
    }

    /// guest 只能从 exitMiniProgram / navigateBackMiniProgram 退出——那里才把 scene 1038 和
    /// referrerInfo 交还 opener。首页上的返回在微信同样是失败，既不派发生命周期也不动栈。
    func testBackOnTheEntryPageOfAGuestMiniProgramChangesNothing() async throws {
        let appConfig = DMPAppConfig(appName: "guest", appId: "guest-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
            app.render = nil
        }
        app.render = DMPRender(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureGuestEntryPageBack")
        app.markAppRuntimeReady()

        let navigator = try XCTUnwrap(app.getNavigator())
        let host = UIViewController()
        let openerPage = DMPPageController(
            pagePath: "pages/opener/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true
        )
        let targetPage = DMPPageController(
            pagePath: "pages/target/index",
            query: nil,
            appConfig: appConfig,
            app: app,
            navigator: navigator,
            isRoot: true
        )
        defer {
            openerPage.destroy()
            targetPage.destroy()
        }
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, openerPage, targetPage], animated: false)
        navigator.setup(
            navigationController: navigationController,
            preserving: [host, openerPage]
        )

        navigator.navigateBack(animated: false)
        await service.drainPendingContainerMessages()

        XCTAssertEqual(recorder.types, [])
        XCTAssertEqual(navigationController.viewControllers.count, 3)
        XCTAssertTrue(navigationController.viewControllers[2] === targetPage)
    }

    /// 跨小程序打开时，目标从拿到导航所有权到 service 建起来之间有一段窗口。系统在这段
    /// 窗口里进后台，App.onHide 的接收方已经是目标，但它还没有 service——直接发就整条
    /// 丢了，小程序会在后台以为自己仍在前台。
    func testASystemHideDuringLaunchReachesTheServiceOnceItExists() async throws {
        let appConfig = DMPAppConfig(appName: "late", appId: "late-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)

        await MainActor.run { app.notifyMiniProgramHide() }

        let service = DMPService(app: app)
        let recorder = await recordContainerMessages(on: service, as: "captureLateService")
        defer {
            app.service = nil
            service.destroy()
        }
        app.service = service
        // service 建起来还不够：service.js 求值完、DiminaServiceBridge 注册之后才收得到消息。
        app.markAppRuntimeReady()
        await service.drainPendingContainerMessages()

        XCTAssertEqual(recorder.types, ["appHide"])
    }

    /// service 存在不等于收得到消息：`initService` 只建引擎，`loadBundle` 之后
    /// `DiminaServiceBridge` 才存在。这中间投递的消息会丢在引擎队列里，且账本会把它
    /// 记成「已送达」，就绪后再也补不回来——所以就绪之前只记账不派发。
    func testAHideBetweenServiceCreationAndBundleEvaluationWaitsForReadiness() async throws {
        let appConfig = DMPAppConfig(appName: "window", appId: "window-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }
        let recorder = await recordContainerMessages(on: service, as: "captureLaunchWindow")

        await MainActor.run { app.notifyMiniProgramHide() }
        await service.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, [])

        app.markAppRuntimeReady()
        await service.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, ["appHide"])
    }

    /// App.onShow/onHide 在微信里严格交替。同一个状态第二次到达（退出已经派发过
    /// hide，紧接着系统又进后台）不再派发。
    func testTheSameAppVisibilityIsNeverDispatchedTwice() async throws {
        let appConfig = DMPAppConfig(appName: "ledger", appId: "ledger-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }
        let recorder = await recordContainerMessages(on: service, as: "captureVisibilityLedger")
        app.markAppRuntimeReady()

        await MainActor.run {
            app.notifyMiniProgramShow()
            app.notifyMiniProgramHide()
            app.notifyMiniProgramHide()
            app.notifyMiniProgramShow()
            app.notifyMiniProgramShow()
        }
        await service.drainPendingContainerMessages()

        XCTAssertEqual(recorder.types, ["appHide", "appShow"])
    }

    /// bundle 求值完不等于 service 侧 App 实例存在：App 由 loader 的 `modRequire('app')` 建出来，
    /// 容器只有收到 `serviceResourceLoaded` 才知道那一步跑完了。更早把账本置为就绪，窗口期欠下的
    /// appHide 会被 service 侧 `runtime.appHide()` 的 `this.app` 判空静默丢掉。
    func testTheRuntimeBecomesReadyOnlyWhenTheServiceReportsItsResourceLoaded() async throws {
        let appConfig = DMPAppConfig(appName: "ready", appId: "ready-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }
        let recorder = await recordContainerMessages(on: service, as: "captureReadySignal")

        await MainActor.run { app.notifyMiniProgramHide() }
        await service.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, [])

        _ = DMPChannelProxy.messageHandler(
            type: "serviceResourceLoaded",
            body: DMPMap(["bridgeId": 0]),
            target: "service",
            app: app
        )
        await service.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, ["appHide"])
    }

    /// restart 发给旧运行时的 App.onHide 是终态，不是一次容器隐藏。把它记成容器意图，新运行时
    /// 就绪后会先收到一条并不该收的 appHide，随后真正的 Home 键又被去重吃掉。
    func testARuntimeRestartDoesNotHandTheNewRuntimeAStaleHide() async throws {
        let appConfig = DMPAppConfig(appName: "restart", appId: "restart-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let oldService = DMPService(app: app)
        app.service = oldService
        app.markAppRuntimeReady()
        await MainActor.run { app.notifyRuntimeTeardownHide() }

        let newService = DMPService(app: app)
        let recorder = await recordContainerMessages(on: newService, as: "captureRestartedRuntime")
        app.service = newService
        oldService.destroy()
        defer {
            app.service = nil
            newService.destroy()
        }

        app.markAppRuntimeReady()
        await newService.drainPendingContainerMessages()
        // 新 Worker 自己会派发 onLaunch/onShow，容器一直可见，这里不该再补任何东西。
        XCTAssertEqual(recorder.types, [])

        await MainActor.run { app.notifyMiniProgramHide() }
        await newService.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, ["appHide"])
    }

    /// 销毁旧运行时和建起新运行时之间按 Home：这条隐藏没有可投递的目标，必须留到新运行时
    /// 就绪时结算，否则小程序在后台以为自己仍在前台。
    func testASystemBackgroundDuringARestartReachesTheNewRuntime() async throws {
        let appConfig = DMPAppConfig(appName: "restartbg", appId: "restartbg-\(UUID().uuidString)")
        let app = DMPApp(appConfig: appConfig, appIndex: -1)
        let oldService = DMPService(app: app)
        app.service = oldService
        app.markAppRuntimeReady()
        await MainActor.run {
            app.notifyRuntimeTeardownHide()
            app.notifyMiniProgramHide()
        }

        let newService = DMPService(app: app)
        let recorder = await recordContainerMessages(on: newService, as: "captureRestartedBackground")
        app.service = newService
        oldService.destroy()
        defer {
            app.service = nil
            newService.destroy()
        }

        app.markAppRuntimeReady()
        await newService.drainPendingContainerMessages()
        XCTAssertEqual(recorder.types, ["appHide"])
    }

    func testTargetNavigatorNeverAdoptsOpenerTabBarContainer() {
        let appConfig = DMPAppConfig(appName: "tabs", appId: "tabs")
        let tabBarConfig = DMPTabBarConfig(
            color: "#999999",
            selectedColor: "#000000",
            borderStyle: "black",
            backgroundColor: "#FFFFFF",
            list: [
                DMPTabBarItem(
                    pagePath: "pages/home/index",
                    iconPath: "",
                    selectedIconPath: "",
                    text: "Home"
                ),
            ]
        )
        let openerTab = DMPTabBarContainerController(
            initialPath: "pages/home/index",
            query: nil,
            appConfig: appConfig,
            app: nil,
            navigator: nil,
            tabBarConfig: tabBarConfig,
            showsLaunchLoading: false
        )
        let targetPage = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers([openerTab, targetPage], animated: false)

        let targetNavigator = DMPNavigator()
        targetNavigator.setup(
            navigationController: navigationController,
            preserving: [openerTab]
        )

        XCTAssertNil(targetNavigator.currentTabBarContainer())

        let targetTab = DMPTabBarContainerController(
            initialPath: "pages/home/index",
            query: nil,
            appConfig: appConfig,
            app: nil,
            navigator: targetNavigator,
            tabBarConfig: tabBarConfig,
            showsLaunchLoading: false
        )
        navigationController.setViewControllers([openerTab, targetTab], animated: false)

        XCTAssertTrue(targetNavigator.currentTabBarContainer() === targetTab)
    }

    func testLaunchReturnsFalseWithoutANavigationController() async {
        let navigator = DMPNavigator()

        let launched = await navigator.launch(to: "pages/index/index")

        XCTAssertFalse(launched)
    }

    func testLaunchReturnsFalseWhenNavigatorIsNotTheActiveOwner() async {
        let navigationController = UINavigationController()
        navigationController.loadViewIfNeeded()
        let firstNavigator = DMPNavigator()
        firstNavigator.setup(navigationController: navigationController)
        let secondNavigator = DMPNavigator()
        secondNavigator.setup(navigationController: navigationController)
        XCTAssertFalse(firstNavigator.isActiveNavigationOwner())

        let launched = await firstNavigator.launch(to: "pages/index/index")

        XCTAssertFalse(launched)
    }

    func testPrepareInitialTabReturnsNilWithoutAnApp() async {
        let appConfig = DMPAppConfig(appName: "tabs", appId: "tabs-\(UUID().uuidString)")
        let tabBarConfig = DMPTabBarConfig(
            color: "#999999",
            selectedColor: "#000000",
            borderStyle: "black",
            backgroundColor: "#FFFFFF",
            list: [
                DMPTabBarItem(
                    pagePath: "pages/home/index",
                    iconPath: "",
                    selectedIconPath: "",
                    text: "Home"
                ),
            ]
        )
        let tabBarController = DMPTabBarContainerController(
            initialPath: "pages/home/index",
            query: nil,
            appConfig: appConfig,
            app: nil,
            navigator: nil,
            tabBarConfig: tabBarConfig,
            showsLaunchLoading: false
        )

        let record = await tabBarController.prepareInitialTab()

        // DMPNavigator.launch's tab-bar branch relies on this nil short-circuit
        // to return false instead of pushing a blank tab-bar container.
        XCTAssertNil(record)
    }

    func testRouteAPIRegistersMiniProgramLevelMethods() {
        _ = RouteAPI()

        let registered = Set(DMPContainerApi.getAllRegisteredMethods())
        XCTAssertTrue(registered.isSuperset(of: [
            "navigateToMiniProgram",
            "navigateBackMiniProgram",
            "exitMiniProgram",
            "restartMiniProgram",
        ]))
    }

    func testNavigateToMiniProgramRejectsMissingAppIdThroughUnifiedCallbacks() throws {
        _ = RouteAPI()
        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateToMiniProgram"))
        var callbackTypes: [DMPBridgeCallbackType] = []
        var failure: DMPMap?
        var complete: DMPMap?

        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: -1, appId: "source", webViewId: 1)
        ) { result, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .fail {
                failure = result
            } else if callbackType == .complete {
                complete = result
            }
        }

        XCTAssertEqual(callbackTypes, [.fail, .complete])
        XCTAssertEqual(
            failure?.get("errMsg") as? String,
            "navigateToMiniProgram:fail appId is required"
        )
        XCTAssertEqual(
            complete?.get("errMsg") as? String,
            "navigateToMiniProgram:fail appId is required"
        )
    }

    func testMiniProgramRouteCompleteCarriesSuccessAndFailureErrMsg() {
        let apis = [
            "navigateToMiniProgram",
            "navigateBackMiniProgram",
            "exitMiniProgram",
            "restartMiniProgram",
        ]

        for api in apis {
            var successCallbacks: [(DMPBridgeCallbackType, String?)] = []
            RouteAPI.invokeSuccess(api: api) { result, callbackType in
                successCallbacks.append((callbackType, result.get("errMsg") as? String))
            }
            XCTAssertEqual(successCallbacks.map(\.0), [.success, .complete])
            XCTAssertEqual(successCallbacks.map(\.1), ["\(api):ok", "\(api):ok"])

            var failureCallbacks: [(DMPBridgeCallbackType, String?)] = []
            RouteAPI.invokeFailure(api: api, callback: { result, callbackType in
                failureCallbacks.append((callbackType, result.get("errMsg") as? String))
            }, reason: "test reason")
            XCTAssertEqual(failureCallbacks.map(\.0), [.fail, .complete])
            XCTAssertEqual(
                failureCallbacks.map(\.1),
                ["\(api):fail test reason", "\(api):fail test reason"]
            )
        }
    }

    func testNavigateToMiniProgramRejectsUnsupportedBundledOptions() throws {
        _ = RouteAPI()
        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateToMiniProgram"))

        let cases: [([String: Any], String)] = [
            (
                ["shortLink": "#mini-program://example"],
                "navigateToMiniProgram:fail shortLink is not supported for bundled mini programs"
            ),
            (
                ["appId": "target", "envVersion": "trial"],
                "navigateToMiniProgram:fail envVersion must be release"
            ),
            (
                ["appId": "target", "noRelaunchIfPathUnchanged": true],
                "navigateToMiniProgram:fail noRelaunchIfPathUnchanged is not supported for bundled mini programs"
            ),
            (
                ["shortLink": 7],
                "navigateToMiniProgram:fail shortLink must be a string"
            ),
            (
                ["appId": "target", "envVersion": 7],
                "navigateToMiniProgram:fail envVersion must be release"
            ),
            (
                ["appId": "target", "noRelaunchIfPathUnchanged": "true"],
                "navigateToMiniProgram:fail noRelaunchIfPathUnchanged must be a boolean"
            ),
            (
                ["appId": "target", "path": 7],
                "navigateToMiniProgram:fail path must be a string"
            ),
            (
                ["appId": "target", "extraData": "invalid"],
                "navigateToMiniProgram:fail extraData must be an object"
            ),
        ]

        for (params, expectedError) in cases {
            var callbackTypes: [DMPBridgeCallbackType] = []
            var failure: DMPMap?
            _ = handler(
                DMPBridgeParam(value: params),
                DMPBridgeEnv(appIndex: -1, appId: "source", webViewId: 1)
            ) { result, callbackType in
                callbackTypes.append(callbackType)
                if callbackType == .fail {
                    failure = result
                }
            }

            XCTAssertEqual(callbackTypes, [.fail, .complete])
            XCTAssertEqual(failure?.get("errMsg") as? String, expectedError)
        }
    }

    func testHiddenOpenerCannotMutateOrDestroyPresentedTarget() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let openerAppId = "hidden-opener-\(UUID().uuidString)"
        let opener = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "opener", appId: openerAppId)
        )
        defer { manager.removeApp(appId: openerAppId) }

        let host = UIViewController()
        let openerPage = UIViewController()
        let targetPage = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers(
            [host, openerPage, targetPage],
            animated: false
        )
        opener.getNavigator()?.setup(navigationController: navigationController)

        let targetNavigator = DMPNavigator()
        targetNavigator.setup(
            navigationController: navigationController,
            preserving: [host, openerPage]
        )
        XCTAssertFalse(opener.getNavigator()?.isActiveNavigationOwner() ?? true)
        XCTAssertTrue(targetNavigator.isActiveNavigationOwner())

        let cases: [(String, [String: Any])] = [
            ("navigateTo", ["url": "pages/hidden/index"]),
            ("exitMiniProgram", [:]),
            ("restartMiniProgram", ["path": "pages/restart/index"]),
        ]
        for (api, params) in cases {
            let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: api))
            let completed = expectation(description: "\(api) rejects hidden opener")
            var callbackTypes: [DMPBridgeCallbackType] = []
            var failure: DMPMap?

            _ = handler(
                DMPBridgeParam(value: params),
                DMPBridgeEnv(appIndex: opener.getAppIndex(), appId: openerAppId, webViewId: 1)
            ) { result, callbackType in
                callbackTypes.append(callbackType)
                if callbackType == .fail {
                    failure = result
                } else if callbackType == .complete {
                    completed.fulfill()
                }
            }

            await fulfillment(of: [completed], timeout: 1)
            XCTAssertEqual(callbackTypes, [.fail, .complete])
            XCTAssertEqual(
                failure?.get("errMsg") as? String,
                "\(api):fail source mini program is not currently presented"
            )
            XCTAssertEqual(navigationController.viewControllers.count, 3)
            XCTAssertTrue(navigationController.viewControllers[0] === host)
            XCTAssertTrue(navigationController.viewControllers[1] === openerPage)
            XCTAssertTrue(navigationController.viewControllers[2] === targetPage)
        }
    }

    func testNavigateBackMiniProgramFailsWhenThereIsNoOpener() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let appId = "standalone-\(UUID().uuidString)"
        let app = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "standalone", appId: appId)
        )
        defer { manager.removeApp(appId: appId) }

        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateBackMiniProgram"))
        let completed = expectation(description: "failure and complete callbacks")
        var callbackTypes: [DMPBridgeCallbackType] = []
        var failure: DMPMap?

        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: app.getAppIndex(), appId: appId, webViewId: 1)
        ) { result, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .fail {
                failure = result
            } else if callbackType == .complete {
                completed.fulfill()
            }
        }

        await fulfillment(of: [completed], timeout: 1)
        XCTAssertEqual(callbackTypes, [.fail, .complete])
        XCTAssertEqual(
            failure?.get("errMsg") as? String,
            "navigateBackMiniProgram:fail current mini program was not opened by another mini program"
        )
    }

    func testNavigateBackMiniProgramRestoresOpenerThroughTheRealManagerPath() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let openerAppId = "opener-\(UUID().uuidString)"
        let targetAppId = "target-\(UUID().uuidString)"
        let opener = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "opener", appId: openerAppId)
        )
        let target = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "target", appId: targetAppId)
        )
        defer {
            manager.removeApp(appId: openerAppId)
            manager.removeApp(appId: targetAppId)
        }

        let host = UIViewController()
        let openerPage = UIViewController()
        let targetPage = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, openerPage, targetPage], animated: false)
        opener.getNavigator()?.setup(navigationController: navigationController)
        let readOpenerEvents = await attachLifecycleCapture(to: opener)
        // navigateToMiniProgram 先挂起 opener 再把导航所有权交给 target，opener 的
        // App.onHide 就在这一步派发；跨小程序返回时的 onShow 必须与它配对。
        opener.getNavigator()?.suspendForMiniProgramNavigation()
        target.getNavigator()?.setup(
            navigationController: navigationController,
            preserving: [host, openerPage]
        )
        XCTAssertTrue(target.getNavigator()?.isActiveNavigationOwner() ?? false)

        manager.markOpenedByMiniProgramForTesting(target: target, opener: opener)

        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateBackMiniProgram"))
        let completed = expectation(description: "navigateBackMiniProgram completes")
        var callbackTypes: [DMPBridgeCallbackType] = []
        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: target.getAppIndex(), appId: targetAppId, webViewId: 1)
        ) { _, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .complete {
                completed.fulfill()
            }
        }
        await fulfillment(of: [completed], timeout: 1)
        XCTAssertEqual(callbackTypes, [.success, .complete])

        // navigateBackMiniProgram's success callback fires via onAccepted before
        // closeMiniProgram's CATransaction completion, destroy(), and restoreOpener()
        // run. withMiniProgramOperation only clears its in-flight flag once that whole
        // chain returns, so poll it instead of trusting the success/complete callbacks
        // for ordering.
        while manager.isMiniProgramOperationInFlight() {
            await Task.yield()
        }
        await opener.service?.drainPendingContainerMessages()
        waitForNavigationStack(navigationController, toSettleAt: 2)

        // The opener's stack is restored and it becomes the active owner again.
        XCTAssertEqual(navigationController.viewControllers.count, 2)
        XCTAssertTrue(navigationController.viewControllers[0] === host)
        XCTAssertTrue(navigationController.viewControllers[1] === openerPage)
        XCTAssertTrue(opener.getNavigator()?.isActiveNavigationOwner() ?? false)

        // The opener actually receives an appShow carrying the 1038 "mini
        // program back" scene and the target's appId as referrer.
        let openerEvents = readOpenerEvents()
        XCTAssertEqual(openerEvents.map { $0["type"] as? String }, ["appHide", "appShow"])
        let showBody = openerEvents.last?["body"] as? [String: Any]
        XCTAssertEqual(showBody?["scene"] as? Int, DMPScene.fromMiniProgramBack.rawValue)
        let referrerInfo = showBody?["referrerInfo"] as? [String: Any]
        XCTAssertEqual(referrerInfo?["appId"] as? String, targetAppId)

        // A successful navigateBackMiniProgram both destroys the target and
        // consumes the opener context; repeating it against the same index
        // now fails because the target app itself is gone.
        let repeatCompleted = expectation(description: "second navigateBackMiniProgram completes")
        var repeatFailure: DMPMap?
        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: target.getAppIndex(), appId: targetAppId, webViewId: 1)
        ) { result, callbackType in
            if callbackType == .fail {
                repeatFailure = result
            } else if callbackType == .complete {
                repeatCompleted.fulfill()
            }
        }
        await fulfillment(of: [repeatCompleted], timeout: 1)
        XCTAssertEqual(
            repeatFailure?.get("errMsg") as? String,
            "navigateBackMiniProgram:fail invalid app"
        )
    }

    func testOpenerRestoredWhileHostIsBackgroundedGetsItsAppShowOnTheRealForeground() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let openerAppId = "opener-\(UUID().uuidString)"
        let targetAppId = "target-\(UUID().uuidString)"
        let opener = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "opener", appId: openerAppId)
        )
        let target = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "target", appId: targetAppId)
        )
        defer {
            // 宿主可见性是进程级单例状态，失败退出时也要还原，否则污染后续用例。
            NotificationCenter.default.post(
                name: UIApplication.willEnterForegroundNotification,
                object: nil
            )
            manager.removeApp(appId: openerAppId)
            manager.removeApp(appId: targetAppId)
        }

        let host = UIViewController()
        let openerPage = UIViewController()
        let targetPage = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, openerPage, targetPage], animated: false)
        opener.getNavigator()?.setup(navigationController: navigationController)
        let readOpenerEvents = await attachLifecycleCapture(to: opener)
        opener.getNavigator()?.suspendForMiniProgramNavigation()
        target.getNavigator()?.setup(
            navigationController: navigationController,
            preserving: [host, openerPage]
        )
        manager.markOpenedByMiniProgramForTesting(target: target, opener: opener)

        // 用户在返回过程中把宿主切走：跨小程序返回可以整个发生在后台。
        NotificationCenter.default.post(
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        await waitForHostVisible(false, on: manager)
        XCTAssertFalse(manager.isHostVisibleForTesting())

        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateBackMiniProgram"))
        let completed = expectation(description: "navigateBackMiniProgram completes")
        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: target.getAppIndex(), appId: targetAppId, webViewId: 1)
        ) { _, callbackType in
            if callbackType == .complete {
                completed.fulfill()
            }
        }
        await fulfillment(of: [completed], timeout: 1)
        while manager.isMiniProgramOperationInFlight() {
            await Task.yield()
        }
        await opener.service?.drainPendingContainerMessages()
        waitForNavigationStack(navigationController, toSettleAt: 2)

        // opener 拿回了展示关系，但宿主整体不可见——此刻派发 App.onShow 会让账本以为
        // 它已经显示，宿主真正回到前台时那条 show 就被去重掉。
        XCTAssertTrue(opener.getNavigator()?.isActiveNavigationOwner() ?? false)
        XCTAssertEqual(readOpenerEvents().map { $0["type"] as? String }, ["appHide"])

        // 宿主回到前台，这才是本次返回真正的 App.onShow：它必须带上返回场景值和 referrerInfo，
        // 而不是 opener 自己的启动场景。
        NotificationCenter.default.post(
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        await waitForHostVisible(true, on: manager)
        await opener.service?.drainPendingContainerMessages()

        let openerEvents = readOpenerEvents()
        XCTAssertEqual(openerEvents.map { $0["type"] as? String }, ["appHide", "appShow"])
        let showBody = openerEvents.last?["body"] as? [String: Any]
        XCTAssertEqual(showBody?["scene"] as? Int, DMPScene.fromMiniProgramBack.rawValue)
        let referrerInfo = showBody?["referrerInfo"] as? [String: Any]
        XCTAssertEqual(referrerInfo?["appId"] as? String, targetAppId)
    }

    func testExitMiniProgramRestoresOpenerThroughTheRealManagerPath() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let openerAppId = "opener-\(UUID().uuidString)"
        let targetAppId = "target-\(UUID().uuidString)"
        let opener = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "opener", appId: openerAppId)
        )
        let target = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "target", appId: targetAppId)
        )
        defer {
            manager.removeApp(appId: openerAppId)
            manager.removeApp(appId: targetAppId)
        }

        let host = UIViewController()
        let openerPage = UIViewController()
        let targetPage = UIViewController()
        let navigationController = UINavigationController()
        navigationController.setViewControllers([host, openerPage, targetPage], animated: false)
        opener.getNavigator()?.setup(navigationController: navigationController)
        let readOpenerEvents = await attachLifecycleCapture(to: opener)
        // navigateToMiniProgram 先挂起 opener 再把导航所有权交给 target，opener 的
        // App.onHide 就在这一步派发；跨小程序返回时的 onShow 必须与它配对。
        opener.getNavigator()?.suspendForMiniProgramNavigation()
        target.getNavigator()?.setup(
            navigationController: navigationController,
            preserving: [host, openerPage]
        )

        manager.markOpenedByMiniProgramForTesting(target: target, opener: opener)

        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "exitMiniProgram"))
        let completed = expectation(description: "exitMiniProgram completes")
        var callbackTypes: [DMPBridgeCallbackType] = []
        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: target.getAppIndex(), appId: targetAppId, webViewId: 1)
        ) { _, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .complete {
                completed.fulfill()
            }
        }
        await fulfillment(of: [completed], timeout: 1)
        XCTAssertEqual(callbackTypes, [.success, .complete])

        // exitMiniProgram's success callback fires via onAccepted before
        // closeMiniProgram's CATransaction completion, destroy(), and restoreOpener()
        // run. withMiniProgramOperation only clears its in-flight flag once that whole
        // chain returns, so poll it instead of trusting the success/complete callbacks
        // for ordering.
        while manager.isMiniProgramOperationInFlight() {
            await Task.yield()
        }
        await opener.service?.drainPendingContainerMessages()
        waitForNavigationStack(navigationController, toSettleAt: 2)

        XCTAssertEqual(navigationController.viewControllers.count, 2)
        XCTAssertTrue(opener.getNavigator()?.isActiveNavigationOwner() ?? false)

        // exitMiniProgram carries no extraData, unlike navigateBackMiniProgram.
        let openerEvents = readOpenerEvents()
        XCTAssertEqual(openerEvents.map { $0["type"] as? String }, ["appHide", "appShow"])
        let showBody = openerEvents.last?["body"] as? [String: Any]
        XCTAssertEqual(showBody?["scene"] as? Int, DMPScene.fromMiniProgramBack.rawValue)
        let referrerInfo = showBody?["referrerInfo"] as? [String: Any]
        XCTAssertEqual(referrerInfo?["appId"] as? String, targetAppId)
        XCTAssertNil(referrerInfo?["extraData"])
    }

    func testRestartMiniProgramRequiresPathThroughUnifiedCallbacks() throws {
        _ = RouteAPI()
        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "restartMiniProgram"))
        var callbackTypes: [DMPBridgeCallbackType] = []
        var failure: DMPMap?

        _ = handler(
            DMPBridgeParam(value: [:]),
            DMPBridgeEnv(appIndex: -1, appId: "source", webViewId: 1)
        ) { result, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .fail {
                failure = result
            }
        }

        XCTAssertEqual(callbackTypes, [.fail, .complete])
        XCTAssertEqual(
            failure?.get("errMsg") as? String,
            "restartMiniProgram:fail path is required"
        )
    }

    func testLaunchConfigCarriesMiniProgramSceneAndReferrerInfo() {
        let launchConfig = DMPLaunchConfig(
            appEntryPath: "pages/detail/index",
            scene: DMPScene.fromMiniProgram.rawValue,
            referrerInfo: [
                "appId": "opener",
                "extraData": ["token": "abc"],
            ]
        )

        XCTAssertEqual(launchConfig.scene, 1037)
        XCTAssertEqual(launchConfig.referrerInfo?["appId"] as? String, "opener")
        XCTAssertEqual(
            (launchConfig.referrerInfo?["extraData"] as? [String: String])?["token"],
            "abc"
        )
        XCTAssertEqual(DMPScene.fromMiniProgramBack.rawValue, 1038)
    }

    func testInitialResourceMessageCarriesLaunchQueryAndOptionalReferrer() {
        let body = DMPContainer.makeResourceBody(
            webViewId: 7,
            appId: "target",
            pagePath: "pages/detail/index",
            root: "main",
            launchConfig: DMPLaunchConfig(
                appEntryPath: "pages/detail/index",
                query: ["ticket": "42"],
                scene: DMPScene.fromMiniProgram.rawValue,
                referrerInfo: ["appId": "opener"]
            )
        )

        XCTAssertEqual((body["query"] as? [String: Any])?["ticket"] as? String, "42")
        XCTAssertEqual(body["scene"] as? Int, 1037)
        XCTAssertEqual(
            (body["referrerInfo"] as? [String: Any])?["appId"] as? String,
            "opener"
        )

        let defaultBody = DMPContainer.makeResourceBody(
            webViewId: 8,
            appId: "standalone",
            pagePath: "pages/home/index",
            root: "main",
            launchConfig: nil
        )
        XCTAssertEqual((defaultBody["query"] as? [String: Any])?.count, 0)
        XCTAssertEqual(defaultBody["scene"] as? Int, 1001)
        XCTAssertNil(defaultBody["referrerInfo"])
    }

    func testContainerInitializationReplaysPendingExtModules() {
        let manager = DMPAppManager.sharedInstance()
        let moduleName = "navigation-test-\(UUID().uuidString)"
        manager.registerExtModule(moduleName) { _, _, _ in nil }

        let app = manager.newAppWithConfig(
            appConfig: DMPAppConfig(
                appName: "ext-target",
                appId: "ext-target-\(UUID().uuidString)"
            )
        )
        defer { app.destroy() }

        app.initContainer()

        XCTAssertNotNil(app.container?.extModules[moduleName])
    }

    func testReturnedAppShowKeepsOpenerPathAndQuery() async throws {
        let app = DMPApp(
            appConfig: DMPAppConfig(appName: "opener", appId: "opener-\(UUID().uuidString)"),
            appIndex: -1
        )
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }

        await app.openPage(
            launchConfig: DMPLaunchConfig(
                appEntryPath: "pages/detail/index",
                query: ["ticket": "42"]
            )
        )

        let received = expectation(description: "appShow reaches opener service")
        var receivedBody: [String: Any]?
        service.getEngine().registerMethod(name: "captureReturnedAppShow") { value in
            let message = value.toDictionary() as? [String: Any]
            receivedBody = message?["body"] as? [String: Any]
            received.fulfill()
            return nil
        }
        _ = await service.evaluateScript(
            "DiminaServiceBridge.onMessage = function(message) { captureReturnedAppShow(message); };"
        )

        app.notifyAppShow(
            scene: DMPScene.fromMiniProgramBack.rawValue,
            referrerInfo: ["appId": "target"]
        )
        await fulfillment(of: [received], timeout: 1)

        XCTAssertEqual(receivedBody?["path"] as? String, "pages/detail/index")
        XCTAssertEqual(
            (receivedBody?["query"] as? [String: Any])?["ticket"] as? String,
            "42"
        )
        XCTAssertEqual(receivedBody?["scene"] as? Int, 1038)
        XCTAssertEqual(
            (receivedBody?["referrerInfo"] as? [String: Any])?["appId"] as? String,
            "target"
        )
    }

    func testNavigateBackMiniProgramLifecycleRunsOnceInOrder() async {
        let events = await captureMiniProgramLifecycle(rounds: [(
            DMPScene.fromMiniProgramBack.rawValue,
            ["appId": "target", "extraData": ["source": "navigateBackMiniProgram"]]
        )])

        XCTAssertEqual(events, ["pageHide", "appHide", "appShow", "pageShow"])
    }

    func testExitMiniProgramLifecycleRunsOnceInOrder() async {
        let events = await captureMiniProgramLifecycle(rounds: [(
            DMPScene.fromMiniProgramBack.rawValue,
            ["appId": "target"]
        )])

        XCTAssertEqual(events, ["pageHide", "appHide", "appShow", "pageShow"])
    }

    func testFailedTargetLaunchRollsLifecycleBackOnceInOrder() async {
        let events = await captureMiniProgramLifecycle(rounds: [(nil, nil)])

        XCTAssertEqual(events, ["pageHide", "appHide", "appShow", "pageShow"])
    }

    func testCrossMiniProgramLifecycleRemainsBalancedAcrossTwoRounds() async {
        let events = await captureMiniProgramLifecycle(rounds: [
            (DMPScene.fromMiniProgramBack.rawValue, ["appId": "target"]),
            (DMPScene.fromMiniProgramBack.rawValue, ["appId": "target"]),
        ])

        XCTAssertEqual(events, [
            "pageHide", "appHide", "appShow", "pageShow",
            "pageHide", "appHide", "appShow", "pageShow",
        ])
    }

    func testNativeCrossMiniProgramEntriesUseTheRoutePageDispatcher() throws {
        let repositoryRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let iosNavigator = try String(
            contentsOf: repositoryRoot.appendingPathComponent(
                "iOS/dimina/DiminaKit/Navigator/DMPNavigator.swift"
            ),
            encoding: .utf8
        )
        let iosApp = try String(
            contentsOf: repositoryRoot.appendingPathComponent(
                "iOS/dimina/DiminaKit/App/DMPApp.swift"
            ),
            encoding: .utf8
        )
        let harmonyApp = try String(
            contentsOf: repositoryRoot.appendingPathComponent(
                "harmony/dimina/src/main/ets/DApp/DMPApp.ets"
            ),
            encoding: .utf8
        )
        let harmonyNavigator = try String(
            contentsOf: repositoryRoot.appendingPathComponent(
                "harmony/dimina/src/main/ets/Navigator/DMPNavigator.ets"
            ),
            encoding: .utf8
        )

        XCTAssertTrue(iosNavigator.contains("dispatchPageHide(webViewId:"))
        XCTAssertTrue(iosNavigator.contains("dispatchPageShow(webViewId:"))
        XCTAssertTrue(iosNavigator.contains("app?.notifyMiniProgramHide()"))
        XCTAssertTrue(iosNavigator.contains("app?.notifyMiniProgramShow(scene:"))
        XCTAssertTrue(iosApp.contains("notifyMiniProgramHide(webViewId: getCurrentWebViewId())"))
        XCTAssertTrue(iosApp.contains("webViewId: getCurrentWebViewId(),"))
        XCTAssertTrue(harmonyApp.contains("navigatorManager.dispatchPageHide(bridgeId)"))
        XCTAssertTrue(harmonyApp.contains("navigatorManager.dispatchPageShow(bridgeId)"))
        XCTAssertTrue(harmonyNavigator.contains("dispatchPageHide(webViewId: number)"))
        XCTAssertTrue(harmonyNavigator.contains("dispatchPageShow(webViewId: number)"))
        XCTAssertEqual(iosNavigator.components(separatedBy: "pageLifecycle?.onHide").count - 1, 1)
        XCTAssertEqual(iosNavigator.components(separatedBy: "pageLifecycle?.onShow").count - 1, 1)
        XCTAssertEqual(harmonyNavigator.components(separatedBy: "this.pageLifecycle.onHide").count - 1, 1)
        XCTAssertEqual(harmonyNavigator.components(separatedBy: "this.pageLifecycle.onShow").count - 1, 1)

        let appHide = try XCTUnwrap(harmonyApp.range(of: "type: 'appHide'"))
        let pageHide = try XCTUnwrap(
            harmonyApp.range(of: "navigatorManager.dispatchPageHide(bridgeId)")
        )
        let appShow = try XCTUnwrap(harmonyApp.range(of: "type: 'appShow'"))
        let pageShow = try XCTUnwrap(
            harmonyApp.range(of: "navigatorManager.dispatchPageShow(bridgeId)")
        )
        XCTAssertLessThan(pageHide.lowerBound, appHide.lowerBound)
        XCTAssertLessThan(appShow.lowerBound, pageShow.lowerBound)
    }

    func testServiceEngineResolversStayIsolatedAfterTargetDestroy() {
        var opener: DMPApp? = DMPApp(
            appConfig: DMPAppConfig(appName: "opener", appId: "opener-\(UUID().uuidString)"),
            appIndex: -1
        )
        var target: DMPApp? = DMPApp(
            appConfig: DMPAppConfig(appName: "target", appId: "target-\(UUID().uuidString)"),
            appIndex: -2
        )
        let openerService = DMPService(app: opener!)
        let targetService = DMPService(app: target!)
        opener?.service = openerService
        target?.service = targetService
        defer {
            openerService.destroy()
            targetService.destroy()
            opener?.destroy()
        }

        XCTAssertTrue(openerService.getEngine().resolveApp() === opener)
        XCTAssertTrue(targetService.getEngine().resolveApp() === target)

        target?.destroy()

        // The caller can still strongly retain a destroyed app while the old
        // engine drains. Its service generation must already be detached.
        XCTAssertNotNil(target)
        XCTAssertNil(targetService.getEngine().resolveApp())
        XCTAssertTrue(openerService.getEngine().resolveApp() === opener)
        target = nil
        opener = nil
    }

    func testOldContainerCallbackCannotReachReplacementService() async {
        let app = DMPApp(
            appConfig: DMPAppConfig(
                appName: "callback-generation",
                appId: "callback-generation-\(UUID().uuidString)"
            ),
            appIndex: -1
        )
        let replacementService = DMPService(app: app)
        app.service = replacementService
        defer {
            replacementService.destroy()
            app.service = nil
            app.container = nil
        }

        var oldContainer: DMPContainer? = DMPContainer(app: app)
        app.container = oldContainer
        let staleCallback = oldContainer?.makeBridgeCallback(
            param: DMPBridgeParam(value: [
                "success": "old-success",
                "complete": "old-complete",
            ])
        )
        weak var weakOldContainer: DMPContainer?
        weakOldContainer = oldContainer

        app.container = DMPContainer(app: app)
        oldContainer = nil
        XCTAssertNil(weakOldContainer)

        var replacementCallbackCount = 0
        replacementService.getEngine().registerMethod(name: "captureStaleCallback") { _ in
            replacementCallbackCount += 1
            return nil
        }
        _ = await replacementService.evaluateScript(
            "DiminaServiceBridge.onMessage = function(message) { captureStaleCallback(message); };"
        )

        staleCallback?(DMPMap(["errMsg": "stale:ok"]), .success)
        staleCallback?(DMPMap(["errMsg": "stale:ok"]), .complete)
        await replacementService.drainPendingContainerMessages()

        XCTAssertEqual(replacementCallbackCount, 0)
    }

    func testClearingAppInvalidatesUploadEventOwnerTokens() {
        let appId = "upload-generation-\(UUID().uuidString)"
        let taskId = "task"
        let ownerToken = NetworkAPI.activateUploadTask(appId: appId, taskId: taskId)
        defer { NetworkAPI.clearApp(appId) }

        XCTAssertTrue(
            NetworkAPI.isUploadTaskActive(
                appId: appId,
                taskId: taskId,
                ownerToken: ownerToken
            )
        )

        NetworkAPI.clearApp(appId)

        XCTAssertFalse(
            NetworkAPI.isUploadTaskActive(
                appId: appId,
                taskId: taskId,
                ownerToken: ownerToken
            )
        )
    }

    func testAcceptedCallbackDrainsBeforeEngineTeardown() async {
        let engine = DMPEngine()
        let received = expectation(description: "accepted callbacks run before teardown")
        received.expectedFulfillmentCount = 2
        var events: [String] = []
        engine.registerMethod(name: "restartAccepted") { value in
            events.append(value.toString() ?? "")
            received.fulfill()
            return nil
        }

        // RouteAPI enqueues success and complete synchronously at the restart
        // commit point, then DMPApp destroys the old engine immediately.
        engine.enqueueScript("restartAccepted('success')")
        engine.enqueueScript("restartAccepted('complete')")
        engine.destroy()

        await fulfillment(of: [received], timeout: 1)
        XCTAssertEqual(events, ["success", "complete"])
    }

    func testServiceDrainWaitsForCallbacksBeforeNativeTeardown() async {
        let app = DMPApp(
            appConfig: DMPAppConfig(appName: "drain", appId: "drain-\(UUID().uuidString)"),
            appIndex: -1
        )
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }

        var resolverWasLive = false
        service.getEngine().registerMethod(name: "callbackBeforeTeardown") { _ in
            resolverWasLive = service.getEngine().resolveApp() === app
            return nil
        }
        _ = await service.evaluateScript(
            "DiminaServiceBridge.onMessage = function() { callbackBeforeTeardown({}); };"
        )

        service.fromContainer(data: DMPMap(["type": "triggerCallback", "body": [:]]))
        await service.drainPendingContainerMessages()

        XCTAssertTrue(resolverWasLive)
    }

    func testMiniProgramOperationGuardRejectsOverlapAndReleases() async throws {
        let manager = DMPAppManager.sharedInstance()
        let entered = expectation(description: "first operation entered")
        var releaseFirst: CheckedContinuation<Void, Never>?

        let firstOperation = Task { @MainActor in
            try await manager.withMiniProgramOperation {
                entered.fulfill()
                await withCheckedContinuation { continuation in
                    releaseFirst = continuation
                }
            }
        }
        await fulfillment(of: [entered], timeout: 1)

        do {
            try await manager.withMiniProgramOperation {}
            XCTFail("overlapping operation must be rejected")
        } catch {
            XCTAssertEqual(
                error.localizedDescription,
                "another mini program operation is in progress"
            )
        }

        releaseFirst?.resume()
        releaseFirst = nil
        try await firstOperation.value

        try await manager.withMiniProgramOperation {}
    }

    func testPageRouteIsRejectedWhileMiniProgramOperationIsInFlight() async throws {
        _ = RouteAPI()
        let manager = DMPAppManager.sharedInstance()
        let appId = "route-during-mini-op-\(UUID().uuidString)"
        let app = manager.newAppWithConfig(
            appConfig: DMPAppConfig(appName: "source", appId: appId)
        )
        defer { manager.removeApp(appId: appId) }

        let existingPage = UIViewController()
        let navigationController = UINavigationController(rootViewController: existingPage)
        app.getNavigator()?.setup(navigationController: navigationController)
        let handler = try XCTUnwrap(DMPContainerApi.getHandler(for: "navigateTo"))

        let entered = expectation(description: "mini operation entered")
        var releaseOperation: CheckedContinuation<Void, Never>?
        let operation = Task { @MainActor in
            try await manager.withMiniProgramOperation {
                entered.fulfill()
                await withCheckedContinuation { continuation in
                    releaseOperation = continuation
                }
            }
        }
        await fulfillment(of: [entered], timeout: 1)

        let completed = expectation(description: "page route rejected")
        var callbackTypes: [DMPBridgeCallbackType] = []
        var failure: DMPMap?
        _ = handler(
            DMPBridgeParam(value: ["url": "pages/race/index"]),
            DMPBridgeEnv(appIndex: app.getAppIndex(), appId: appId, webViewId: 1)
        ) { result, callbackType in
            callbackTypes.append(callbackType)
            if callbackType == .fail {
                failure = result
            } else if callbackType == .complete {
                completed.fulfill()
            }
        }
        await fulfillment(of: [completed], timeout: 1)

        XCTAssertEqual(callbackTypes, [.fail, .complete])
        XCTAssertEqual(
            failure?.get("errMsg") as? String,
            "navigateTo:fail another mini program operation is in progress"
        )
        XCTAssertEqual(navigationController.viewControllers.count, 1)
        XCTAssertTrue(navigationController.viewControllers[0] === existingPage)

        releaseOperation?.resume()
        releaseOperation = nil
        try await operation.value
    }

    func testBundledTargetConfigIsResolvedByResourceManager() throws {
        // Use a checked-in shared/jsapp fixture. Locally installed mini programs
        // are gitignored and therefore do not exist in a clean CI checkout.
        let config = try XCTUnwrap(
            DMPResourceManager.getDMPAppConfig(appId: "wxe5f52902cf4de896")
        )

        XCTAssertEqual(config.appId, "wxe5f52902cf4de896")
        XCTAssertEqual(config.path, "page/tabBar/component/index")
    }

    func testContainerReloadResetClearsTransientLoadingAndNavigationState() {
        let container = DMPContainer()
        container.isNavigating = true
        container.hasLoadResource(webViewId: 7, type: .serviceLoaded)
        container.hasLoadResource(webViewId: 7, type: .renderLoaded)

        XCTAssertTrue(container.isResourceLoaded(webViewId: 7))

        container.resetForReload()

        XCTAssertFalse(container.isNavigating)
        XCTAssertFalse(container.isResourceLoaded(webViewId: 7))
    }

    func testStalePageCannotClearLoadingObserverOfReusedWebView() {
        let webview = DMPWebview(delegate: nil, appName: "test", appId: "test")
        let oldPageToken = UUID()
        let newPageToken = UUID()
        var loadingStates: [Bool] = []

        webview.setLoadingStateObserver(ownerToken: oldPageToken) { _ in
            XCTFail("The old page observer must be replaced")
        }
        webview.setLoadingStateObserver(ownerToken: newPageToken) { isLoading in
            loadingStates.append(isLoading)
        }

        webview.clearLoadingStateObserver(ownerToken: oldPageToken)
        webview.poolState = .loading
        webview.poolState = .ready

        XCTAssertEqual(loadingStates, [true, false])

        webview.clearLoadingStateObserver(ownerToken: newPageToken)
        webview.poolState = .loading

        XCTAssertEqual(loadingStates, [true, false])
    }

    /// 容器发往 service 的全部消息类型，按到达顺序记录——断言「没有派发某个生命周期」
    /// 需要看到完整序列，只挑白名单会让多余的一条消息静默通过。
    private final class ContainerMessageRecorder {
        var types: [String] = []
    }

    private func recordContainerMessages(
        on service: DMPService,
        as methodName: String
    ) async -> ContainerMessageRecorder {
        let recorder = ContainerMessageRecorder()
        service.getEngine().registerMethod(name: methodName) { value in
            if let type = (value.toDictionary() as? [String: Any])?["type"] as? String {
                recorder.types.append(type)
            }
            return nil
        }
        _ = await service.evaluateScript(
            "DiminaServiceBridge.onMessage = function(message) { \(methodName)(message); };"
        )
        return recorder
    }

    private func captureMiniProgramLifecycle(
        rounds: [(scene: Int?, referrerInfo: [String: Any]?)]
    ) async -> [String] {
        let app = DMPApp(
            appConfig: DMPAppConfig(appName: "lifecycle", appId: "lifecycle-\(UUID().uuidString)"),
            appIndex: -1
        )
        let service = DMPService(app: app)
        app.service = service
        defer {
            app.service = nil
            service.destroy()
        }

        var events: [String] = []
        service.getEngine().registerMethod(name: "captureMiniProgramLifecycle") { value in
            let message = value.toDictionary() as? [String: Any]
            if let type = message?["type"] as? String,
               ["appHide", "pageHide", "appShow", "pageShow"].contains(type)
            {
                events.append(type)
            }
            return nil
        }
        _ = await service.evaluateScript(
            "DiminaServiceBridge.onMessage = function(message) { captureMiniProgramLifecycle(message); };"
        )
        app.markAppRuntimeReady()

        for round in rounds {
            app.notifyMiniProgramHide(webViewId: 7)
            app.notifyMiniProgramShow(
                webViewId: 7,
                scene: round.scene,
                referrerInfo: round.referrerInfo
            )
        }
        await service.drainPendingContainerMessages()
        return events
    }

    /// Wires a real `DMPService` onto `app` and captures every lifecycle
    /// message it receives, so a test can drive `app` through the real
    /// `DMPAppManager` navigation paths and observe what actually reaches
    /// the service layer instead of asserting on internal call sites.
    private func attachLifecycleCapture(to app: DMPApp) async -> () -> [[String: Any]] {
        let service = DMPService(app: app)
        app.service = service
        var events: [[String: Any]] = []
        service.getEngine().registerMethod(name: "captureMiniProgramLifecycle") { value in
            if let message = value.toDictionary() as? [String: Any],
               let type = message["type"] as? String,
               ["appHide", "pageHide", "appShow", "pageShow"].contains(type)
            {
                events.append(message)
            }
            return nil
        }
        _ = await service.evaluateScript(
            "DiminaServiceBridge.onMessage = function(message) { captureMiniProgramLifecycle(message); };"
        )
        app.markAppRuntimeReady()
        return { events }
    }

    /// The manager closes the target with an animated pop. A navigation controller that is not
    /// in a window can still report the pre-pop stack when `closeMiniProgram`'s CATransaction
    /// completion - and with it the manager's in-flight flag - has already run, because the
    /// transition itself only advances on the run loop. Spin it until the stack settles so the
    /// assertions measure the pop rather than the transition's timing; a pop that never lands
    /// still fails on the assertion that follows.
    private func waitForNavigationStack(
        _ navigationController: UINavigationController,
        toSettleAt count: Int
    ) {
        let deadline = Date().addingTimeInterval(2)
        while navigationController.viewControllers.count != count, Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
    }

    /// 宿主前后台通知要经 NotificationCenter 的 main queue 和一次 MainActor Task 两跳才生效，
    /// 只能挂起等待——同步空转 run loop 不会让这两跳跑起来。条件始终不成立时超时返回，
    /// 由随后的断言给出失败。
    private func waitForHostVisible(
        _ expected: Bool,
        on manager: DMPAppManager,
        timeout: TimeInterval = 2
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while manager.isHostVisibleForTesting() != expected, Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func capsules(in view: UIView) -> [UIView] {
        let current = view.accessibilityIdentifier == "dimina.navigation.capsule" ? [view] : []
        return current + view.subviews.flatMap(capsules(in:))
    }
}
