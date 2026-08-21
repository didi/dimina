//
//  DMPNavigatorCapsuleTests.swift
//  diminaTests
//

import UIKit
import XCTest
@testable import dimina

@MainActor
final class DMPNavigatorCapsuleTests: XCTestCase {

    func testSetupInstallsOneContainerOwnedCapsule() {
        let navigationController = UINavigationController()
        navigationController.loadViewIfNeeded()
        let navigator = DMPNavigator()

        navigator.setup(navigationController: navigationController)
        navigator.setCapsuleVisible(true)

        XCTAssertEqual(capsules(in: navigationController.view).count, 1)
        XCTAssertFalse(capsules(in: navigationController.view)[0].isHidden)
    }

    func testOldSetupOverloadKeepsPageOrientationDisabled() {
        let plainNavigator = DMPNavigator()
        let kitNavigator = DMPNavigator()

        plainNavigator.setup(navigationController: UINavigationController())
        kitNavigator.setup(navigationController: DMPNavigationController())

        XCTAssertEqual(plainNavigator.pageOrientationSupport, .disabled)
        XCTAssertEqual(kitNavigator.pageOrientationSupport, .disabled)
    }

    func testOptInRejectsPlainNavigationController() {
        let navigator = DMPNavigator()

        navigator.setup(
            navigationController: UINavigationController(),
            pageOrientationEnabled: true
        )

        XCTAssertEqual(navigator.pageOrientationSupport, .unsupportedNavigationController)
    }

    func testOptInSupportsKitNavigationController() {
        let navigator = DMPNavigator()

        navigator.setup(
            navigationController: DMPNavigationController(),
            pageOrientationEnabled: true
        )

        XCTAssertEqual(navigator.pageOrientationSupport, .supported)
    }

    func testOptInAcceptsAHostNavigationControllerThatDeclaresTheForwardingContract() {
        let navigator = DMPNavigator()

        navigator.setup(
            navigationController: HostForwardingNavigationController(),
            pageOrientationEnabled: true
        )

        XCTAssertEqual(navigator.pageOrientationSupport, .supported)
    }

    func testPageOrientationResolutionFallsThroughInvalidValues() {
        XCTAssertEqual(
            DMPPageOrientation.resolve(pageValue: "invalid", appValue: "landscape"),
            .landscape
        )
        XCTAssertEqual(
            DMPPageOrientation.resolve(pageValue: nil, appValue: nil),
            .portrait
        )
    }

    func testPageOrientationOwnsUIKitMaskMapping() {
        XCTAssertEqual(DMPPageOrientation.portrait.interfaceOrientations, .portrait)
        XCTAssertEqual(DMPPageOrientation.auto.interfaceOrientations, .allButUpsideDown)
        XCTAssertEqual(DMPPageOrientation.landscape.interfaceOrientations, .landscape)
    }

    func testCurrentVisiblePageShowIsReleasedWhenOrientationRequestFails() {
        XCTAssertTrue(
            DMPPageController.shouldReleasePageShowAfterOrientationFailure(
                isDisplayed: true,
                pendingGeneration: 7,
                currentGeneration: 7
            )
        )
        XCTAssertFalse(
            DMPPageController.shouldReleasePageShowAfterOrientationFailure(
                isDisplayed: true,
                pendingGeneration: 6,
                currentGeneration: 7
            )
        )
        XCTAssertFalse(
            DMPPageController.shouldReleasePageShowAfterOrientationFailure(
                isDisplayed: false,
                pendingGeneration: 7,
                currentGeneration: 7
            )
        )
    }

    /// 一页被压住期间窗口转过去、回来时窗口不再动一次：`viewWillTransition` 不触发，tab 切换连 `viewDidAppear` 都不走。
    /// 路由落地这条上报是它唯一的来源。
    func testARouteLandingOnASettledWindowIsReported() {
        XCTAssertTrue(
            DMPPageController.shouldReportRouteGeometry(
                isDisplayed: true,
                expected: .allButUpsideDown,
                currentSize: CGSize(width: 852, height: 393)
            )
        )
    }

    /// 几何没变也要报：`Page.onResize` 的收件人由宿主指名，宿主每次路由都报落点页，不看几何是否和上一次相同。
    func testARouteLandingOnAnUnchangedGeometryIsStillReported() {
        let portrait = CGSize(width: 393, height: 852)
        XCTAssertTrue(
            DMPPageController.shouldReportRouteGeometry(
                isDisplayed: true,
                expected: .portrait,
                currentSize: portrait
            )
        )
    }

    /// 窗口还没转到这一页要求的方向：这份几何这一页从没展示过，报了就是给业务代码一份中途尺寸，随之而来的 `viewWillTransition` 会带着目标尺寸补上。
    func testARouteLandingBeforeTheWindowRotatedIsNotReported() {
        XCTAssertFalse(
            DMPPageController.shouldReportRouteGeometry(
                isDisplayed: true,
                expected: .landscape,
                currentSize: CGSize(width: 393, height: 852)
            )
        )
    }

    /// 不在屏幕上的页面报出去的几何不代表它自己展示时的尺寸。
    func testAnOffscreenPageIsNotReported() {
        XCTAssertFalse(
            DMPPageController.shouldReportRouteGeometry(
                isDisplayed: false,
                expected: .allButUpsideDown,
                currentSize: CGSize(width: 393, height: 852)
            )
        )
        XCTAssertFalse(
            DMPPageController.shouldReportRouteGeometry(
                isDisplayed: true,
                expected: .allButUpsideDown,
                currentSize: nil
            )
        )
    }

    /// iOS 16 之前没有能把窗口转到设备当前不在的方向的接口，`attemptRotationToDeviceOrientation()` 只按设备物理姿态重新评估，也没有成功/失败回调。
    /// 容器证明不了窗口会转，押后 pageShow 就没有放行者——这一页会永远收不到 onShow，service 侧还会一直把它当作隐藏的。
    func testPageShowRunsImmediatelyWhereTheWindowCannotBeRotated() {
        XCTAssertTrue(
            DMPPageController.shouldRunPageShowImmediately(
                isDisplayed: true,
                expected: .landscape,
                currentSize: CGSize(width: 393, height: 852),
                canRequestGeometry: false
            )
        )
        // 连窗口都还没有的时候同样不能押后：那条路径上也没有任何几何回调会来。
        XCTAssertTrue(
            DMPPageController.shouldRunPageShowImmediately(
                isDisplayed: false,
                expected: .landscape,
                currentSize: nil,
                canRequestGeometry: false
            )
        )
    }

    func testPageShowGeometryGateWaitsForTheRequestedTargetDirection() {
        XCTAssertFalse(
            DMPPageController.shouldRunPageShowImmediately(
                isDisplayed: true,
                expected: .landscape,
                currentSize: CGSize(width: 393, height: 852),
                canRequestGeometry: true
            )
        )
        XCTAssertFalse(
            DMPPageController.shouldRunPageShowImmediately(
                isDisplayed: false,
                expected: .portrait,
                currentSize: CGSize(width: 393, height: 852),
                canRequestGeometry: true
            )
        )
        XCTAssertFalse(
            DMPPageController.isTargetGeometrySettled(
                expected: .portrait,
                targetSize: CGSize(width: 852, height: 393)
            )
        )
        XCTAssertTrue(
            DMPPageController.isTargetGeometrySettled(
                expected: .portrait,
                targetSize: CGSize(width: 393, height: 852)
            )
        )
        XCTAssertTrue(
            DMPPageController.isTargetGeometrySettled(
                expected: .landscape,
                targetSize: CGSize(width: 852, height: 393)
            )
        )
    }

    /// 转场落地前这一页不认领方向，交出去的 mask 只框住窗口当前朝向（等于「别转」）：push 动画进行中跟着新栈顶转窗口，UIKit 会有相当概率把这次 push 判成被打断，刚压进去的页当场被摘出栈、WebView 未加载就回收（真机对照 42/108，关闭能力 0/20）。
    func testAPageThatHasNotLandedYetHoldsTheCurrentWindowOrientation() {
        XCTAssertEqual(
            DMPPageController.orientationsHoldingCurrentWindow(current: .landscapeLeft),
            .landscapeLeft
        )
        XCTAssertEqual(
            DMPPageController.orientationsHoldingCurrentWindow(current: .portrait),
            .portrait
        )
        // 视图还没进窗口就问不到朝向，这时没有「当前」可框，交回 UIKit 默认。
        XCTAssertNil(DMPPageController.orientationsHoldingCurrentWindow(current: nil))
        XCTAssertNil(DMPPageController.orientationsHoldingCurrentWindow(current: .unknown))
    }

    /// 转场在飞时任何一页都不认领方向，哪怕它早就落过地：pop 回到的那一页 `hasLandedOnScreen` 是 true，只看落地拦不住它在 pop 动画里把窗口转回去。
    /// 真机抓到的后果是 UIKit 把这次 pop 判成被打断，已经发过 `pageUnload`、JS 侧已经销毁的那一页回到栈顶，还锁着自己的横屏，用户卡在横屏出不去（真机 54 次里 14 次）。
    func testNoPageClaimsItsOrientationWhileANavigationTransitionIsInFlight() {
        XCTAssertTrue(
            DMPPageController.shouldClaimOrientation(
                hasLanded: true, isOnScreen: true, isTransitioning: false)
        )
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: true, isOnScreen: true, isTransitioning: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: false, isOnScreen: true, isTransitioning: false)
        )
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: false, isOnScreen: true, isTransitioning: true)
        )
    }

    /// 视图还没挂进窗口就不是屏幕上那一页，哪怕落地标记还留着真——pop 刚发起时目的页正是这个状态。
    /// 真机 50 个试次里，那种查询 51 次全部 `noWindow=true`，而 1396 次正当的认领全部 `noWindow=false`：这一项独立于落地标记挡住同一个错误，落地标记被误删也还在。
    func testAPageWhoseViewIsNotInTheWindowDoesNotClaimItsOrientation() {
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: true, isOnScreen: false, isTransitioning: false)
        )
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: true, isOnScreen: false, isTransitioning: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldClaimOrientation(
                hasLanded: false, isOnScreen: false, isTransitioning: false)
        )
    }

    /// 旋转和导航转场撞在一起时 UIKit 会把插值中的中间尺寸交给 `viewWillTransition` （真机抓到 -66×1311）。
    /// 负宽会让 JS 的 rpx 基准变成负数，非有限数过 JSON 通道直接崩，而按宽高比判方向还会把它判成竖屏——不是窗口事实就一律不进判据、不上报。
    func testAnImpossibleTransitionSizeIsNotAWindowFact() {
        XCTAssertTrue(DMPPageController.isReportableWindowSize(CGSize(width: 393, height: 852)))
        XCTAssertFalse(DMPPageController.isReportableWindowSize(CGSize(width: -66, height: 1311)))
        XCTAssertFalse(DMPPageController.isReportableWindowSize(CGSize(width: 393, height: 0)))
        XCTAssertFalse(DMPPageController.isReportableWindowSize(CGSize(width: CGFloat.nan, height: 852)))
        XCTAssertFalse(DMPPageController.isReportableWindowSize(CGSize(width: 393, height: CGFloat.infinity)))
    }

    /// push 转场进行中不得再自己发几何请求：`setNeedsUpdateOfSupportedInterfaceOrientations()` 已经让 UIKit 按新栈顶重查方向，竞争的 `requestGeometryUpdate` 会让 UIKit 有几率把这次 push 判成被打断，刚压进去的页直接被摘出栈、WebView 未加载就回收（真机 3/47）。
    /// 落地前提交必被系统拒绝（那时交出去的 mask 还是「维持当前朝向」），而一次拒绝会让押着的 pageShow 就地放行并照旋转前的几何补报——固定方向页没有 onResize 纠正它。
    func testAGeometryRequestIsSubmittedOnlyAfterLandingAndOutsideATransition() {
        XCTAssertTrue(
            DMPPageController.shouldSubmitGeometryRequest(isTransitioning: false, hasLanded: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldSubmitGeometryRequest(isTransitioning: true, hasLanded: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldSubmitGeometryRequest(isTransitioning: false, hasLanded: false)
        )
        XCTAssertFalse(
            DMPPageController.shouldSubmitGeometryRequest(isTransitioning: true, hasLanded: false)
        )
    }

    /// 被转场闸门作废的那次方向请求要在转场结束后补提交，否则从内页 switchTab 到一个还没加载过的固定方向 tab 时，它的 appearance 早在请求之前就结清了，押着的 pageShow 再没有放行者。
    /// 还没落地时不补提交：那时交出去的 mask 还是「维持窗口当前朝向」。
    func testAVoidedGeometryRequestIsResubmittedOnlyAfterThePageHasLanded() {
        XCTAssertTrue(
            DMPPageController.shouldResubmitGeometryAfterTransition(hasLanded: true, isDisplayed: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldResubmitGeometryAfterTransition(hasLanded: false, isDisplayed: true)
        )
        XCTAssertFalse(
            DMPPageController.shouldResubmitGeometryAfterTransition(hasLanded: true, isDisplayed: false)
        )
    }

    func testKitNavigationControllerForwardsOrientationQueriesToItsTopController() {
        let page = OrientationFixtureViewController()
        let navigationController = DMPNavigationController(rootViewController: page)

        XCTAssertEqual(navigationController.supportedInterfaceOrientations, .landscape)
        XCTAssertFalse(navigationController.shouldAutorotate)
        XCTAssertEqual(navigationController.preferredInterfaceOrientationForPresentation, .landscapeRight)
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
            preserving: [host, openerRoot, openerDetail],
            pageOrientationEnabled: false
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
            preserving: [openerTab],
            pageOrientationEnabled: false
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
            preserving: [host, openerPage],
            pageOrientationEnabled: false
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

    private func capsules(in view: UIView) -> [UIView] {
        let current = view.accessibilityIdentifier == "dimina.navigation.capsule" ? [view] : []
        return current + view.subviews.flatMap(capsules(in:))
    }
}

private final class HostForwardingNavigationController: UINavigationController,
    DMPPageOrientationForwarding
{}

private final class OrientationFixtureViewController: UIViewController {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        .landscape
    }

    override var shouldAutorotate: Bool {
        false
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        .landscapeRight
    }
}
