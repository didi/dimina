import XCTest
@testable import dimina

final class CanvasTempFileValidationTests: XCTestCase {
    func testBase64BudgetRejectsUnicodeThatHasFewGraphemesButManyBytes() {
        let combiningPayload = "a" + String(repeating: "\u{0301}", count: 100_000)

        XCTAssertEqual(combiningPayload.count, 1)
        XCTAssertNil(ImageAPI.validatedCanvasBase64ByteCount(combiningPayload))
        XCTAssertEqual(ImageAPI.validatedCanvasBase64ByteCount("iVBORw0KGgo="), 12)
        XCTAssertNil(ImageAPI.validatedCanvasBase64ByteCount("iVBORw0KGgo==="))
    }

    // 排队中的每个请求各自持有一份 base64 副本。单次上限只约束其中一份，连续入队时占用是累加的，
    // 所以预算必须在把字符串交给后台队列之前判：拒绝之后那份副本才可回收。
    func testRejectsExportsThatWouldExceedThePendingBudget() {
        let half = ImageAPI.maxPendingCanvasBase64Bytes / 2

        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: "app-budget", bytes: half))
        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: "app-budget", bytes: half))
        XCTAssertFalse(ImageAPI.tryReserveCanvasExport(appId: "app-budget", bytes: half))

        ImageAPI.releaseCanvasExport(appId: "app-budget", bytes: half)
        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: "app-budget", bytes: half))
    }

    func testRejectsTheThirdPendingExportEvenWhenPayloadsAreTiny() {
        let appId = "app-count-\(UUID().uuidString)"
        let chars = 12
        let first = ImageAPI.tryReserveCanvasExport(appId: appId, bytes: chars)
        let second = ImageAPI.tryReserveCanvasExport(appId: appId, bytes: chars)
        let third = ImageAPI.tryReserveCanvasExport(appId: appId, bytes: chars)

        XCTAssertTrue(first)
        XCTAssertTrue(second)
        XCTAssertFalse(third)
        if first { ImageAPI.releaseCanvasExport(appId: appId, bytes: chars) }
        if second { ImageAPI.releaseCanvasExport(appId: appId, bytes: chars) }
        if third { ImageAPI.releaseCanvasExport(appId: appId, bytes: chars) }
    }

    @MainActor
    func testInvalidationReleasesReservationsThatHaveNotStarted() {
        let appId = "app-reset-\(UUID().uuidString)"
        let half = ImageAPI.maxPendingCanvasBase64Bytes / 2

        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: appId, bytes: half))
        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: appId, bytes: half))
        ImageAPI.clearApp(appId)

        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: appId, bytes: half))
        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: appId, bytes: half))
    }

    @MainActor
    func testInvalidationCancelsOnlyQueuedJobsAndLetsTheNewRuntimeUseTheRemainingSlot() {
        let appId = "app-running-reset-\(UUID().uuidString)"
        let running = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "old1")!
        let queued = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "old2")!
        XCTAssertEqual(ImageAPI.beginCanvasExport(running), "old1")

        ImageAPI.clearApp(appId)

        XCTAssertTrue(queued.cancelled)
        XCTAssertNil(queued.payload)
        XCTAssertNotNil(ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "new1"))
        XCTAssertNil(ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "new2"))

        ImageAPI.finishCanvasExport(running)
        XCTAssertNotNil(ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "new2"))
    }

    // 一个任务都不剩时队列上没有工作项，回收它再重建不会绕过串行。
    @MainActor
    func testReleasesAnIdleQueueWhenTheRuntimeIsInvalidated() {
        let appId = "app-idle-queue-\(UUID().uuidString)"
        let first = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "first")!
        let firstQueue = first.queue
        ImageAPI.finishCanvasExport(first)
        ImageAPI.clearApp(appId)

        let second = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "next")!

        XCTAssertFalse(firstQueue === second.queue)
        ImageAPI.finishCanvasExport(second)
    }

    func testOneAppsPendingExportsDoNotConsumeAnothersBudget() {
        let whole = ImageAPI.maxPendingCanvasBase64Bytes

        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: "app-full", bytes: whole))
        XCTAssertFalse(ImageAPI.tryReserveCanvasExport(appId: "app-full", bytes: 1))
        XCTAssertTrue(ImageAPI.tryReserveCanvasExport(appId: "app-empty", bytes: whole))
    }

    // 小程序退出重开后 appId 照旧，只有代次能判出迟到的结果属于哪一次运行。
    @MainActor
    func testRefusesToDeliverAnExportIssuedByAPreviousRuntime() {
        let generation = ImageAPI.canvasExportGeneration(appId: "app-gen")
        XCTAssertTrue(ImageAPI.shouldDeliverCanvasExport(appId: "app-gen", generation: generation))

        ImageAPI.clearApp("app-gen")

        XCTAssertFalse(ImageAPI.shouldDeliverCanvasExport(appId: "app-gen", generation: generation))
        XCTAssertTrue(
            ImageAPI.shouldDeliverCanvasExport(
                appId: "app-gen",
                generation: ImageAPI.canvasExportGeneration(appId: "app-gen")
            )
        )
    }

    @MainActor
    func testDestroyAfterWritingButBeforeMainDeliveryDropsCallbackAndPublishedFile() throws {
        _ = ImageAPI(app: nil)
        let appId = "canvas-queued-delivery-\(UUID().uuidString)"
        let tmpDirectory = URL(
            fileURLWithPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId),
            isDirectory: true
        )
        defer { try? FileManager.default.removeItem(at: tmpDirectory.deletingLastPathComponent()) }
        var callbackCount = 0
        let writeFinished = DispatchSemaphore(value: 0)
        let param = DMPBridgeParam(value: [
            "dataURL": "data:image/png;base64,iVBORw0KGgo=",
            "fileType": "png",
        ] as [String: Any])
        let env = DMPBridgeEnv(appIndex: 0, appId: appId, webViewId: 0)
        guard let handler = DMPContainerApi.bridgeHandlerMap["saveCanvasTempFile"] else {
            return XCTFail("saveCanvasTempFile is not registered")
        }

        _ = handler(param, env) { _, _ in callbackCount += 1 }
        ImageAPI.canvasExportQueue(appId: appId).async { writeFinished.signal() }

        XCTAssertEqual(writeFinished.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(
                at: tmpDirectory,
                includingPropertiesForKeys: nil
            ).count,
            1
        )

        ImageAPI.clearApp(appId)
        let mainDeliveryDrained = expectation(description: "main delivery queue drained")
        DispatchQueue.main.async { mainDeliveryDrained.fulfill() }
        wait(for: [mainDeliveryDrained], timeout: 1)

        XCTAssertEqual(callbackCount, 0)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(
                at: tmpDirectory,
                includingPropertiesForKeys: nil
            ).count,
            0
        )
    }

    // 没有接收方的导出已经把文件写出去了；iOS 的 tmp 在 Documents/Dimina 下，进程结束也不会回收。
    func testDeletesThePublishedFileOfAnUndeliverableExport() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let published = directory.appendingPathComponent("canvas_orphan.png")
        try Data([1, 2, 3]).write(to: published)

        ImageAPI.discardPublishedCanvasFile(at: published)

        XCTAssertFalse(FileManager.default.fileExists(atPath: published.path))
    }

    func testCanvasAppIdRejectsTraversalAndSeparators() {
        XCTAssertFalse(ImageAPI.isValidCanvasAppId("../other-app"))
        XCTAssertFalse(ImageAPI.isValidCanvasAppId("foo/bar"))
        XCTAssertFalse(ImageAPI.isValidCanvasAppId("foo\\bar"))
        XCTAssertFalse(ImageAPI.isValidCanvasAppId(".."))
        XCTAssertTrue(ImageAPI.isValidCanvasAppId("wx92269e3b2f304afc"))
    }

    func testCanvasImageSignatureMustMatchFileType() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0])
        let fake = Data([0x00, 0x00, 0x00])

        XCTAssertTrue(ImageAPI.matchesCanvasImageType(png, fileType: "png"))
        XCTAssertFalse(ImageAPI.matchesCanvasImageType(png, fileType: "jpg"))
        XCTAssertTrue(ImageAPI.matchesCanvasImageType(jpeg, fileType: "jpg"))
        XCTAssertFalse(ImageAPI.matchesCanvasImageType(jpeg, fileType: "png"))
        XCTAssertFalse(ImageAPI.matchesCanvasImageType(fake, fileType: "png"))
    }

    func testCanvasSuccessCompleteCarriesTheSameResult() {
        let result = DMPMap()
        result.set("errMsg", "canvasToTempFilePath:ok")
        result.set("tempFilePath", "difile://tmp/canvas.png")
        var callbacks: [(DMPBridgeCallbackType, [String: Any])] = []

        ImageAPI.invokeCanvasSuccess(callback: { args, type in
            callbacks.append((type, args.toDictionary()))
        }, result: result)

        XCTAssertEqual(callbacks.count, 2)
        XCTAssertEqual(callbacks[0].0, .success)
        XCTAssertEqual(callbacks[1].0, .complete)
        XCTAssertEqual(callbacks[1].1["errMsg"] as? String, "canvasToTempFilePath:ok")
        XCTAssertEqual(callbacks[1].1["tempFilePath"] as? String, "difile://tmp/canvas.png")
    }

    func testCanvasFailureCompleteCarriesTheSameError() {
        var callbacks: [(DMPBridgeCallbackType, [String: Any])] = []

        ImageAPI.invokeCanvasFailure(callback: { args, type in
            callbacks.append((type, args.toDictionary()))
        }, reason: "write failed")

        XCTAssertEqual(callbacks.count, 2)
        XCTAssertEqual(callbacks[0].0, .fail)
        XCTAssertEqual(callbacks[1].0, .complete)
        XCTAssertEqual(callbacks[1].1["errMsg"] as? String, "canvasToTempFilePath:fail write failed")
    }

    func testCanvasAppDirectoryRejectsSymlinkEscapeBeforeCreatingTempDirectory() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sandbox = root.appendingPathComponent("sandbox")
        let outside = root.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createSymbolicLink(
            at: sandbox.appendingPathComponent("safe-app"),
            withDestinationURL: outside
        )

        XCTAssertNil(ImageAPI.resolvedCanvasAppDirectory(sandboxRoot: sandbox, appId: "safe-app"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("tmp").path))
    }

    func testWriteCanvasTempFileWritesDecodedBytesUnderTheAppTempDirectory() throws {
        let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

        let outcome = ImageAPI.writeCanvasTempFile(
            base64Data: png.base64EncodedString(),
            fileType: "png",
            appId: "wx92269e3b2f304afc",
            sandboxRoot: sandbox,
            tmpDirectoryName: "tmp"
        )

        guard case .success(let fileURL) = outcome else {
            return XCTFail("expected a written file, got \(outcome)")
        }
        XCTAssertEqual(try Data(contentsOf: fileURL), png)
        XCTAssertTrue(
            fileURL.path.hasPrefix(
                sandbox.resolvingSymlinksInPath()
                    .appendingPathComponent("wx92269e3b2f304afc/tmp").path + "/"
            ),
            "written outside the app temp directory: \(fileURL.path)"
        )
    }

    // 解码与落盘要放在后台队列上：bridge handler 跑在主线程，32 MB 的图片同步处理会卡住
    // 同一条主线程上的触摸与 setData。判据是 handler 返回时回调还没发生。
    func testSaveCanvasTempFileDefersDecodeAndWriteOffTheCallingThread() {
        _ = ImageAPI(app: nil)
        guard let handler = DMPContainerApi.bridgeHandlerMap["saveCanvasTempFile"] else {
            return XCTFail("saveCanvasTempFile is not registered")
        }

        var callbackTypes: [DMPBridgeCallbackType] = []
        let settled = expectation(description: "canvasToTempFilePath settles")
        let param = DMPBridgeParam(value: [
            "dataURL": "data:image/png;base64,iVBORw0KGgo=",
            "fileType": "png",
        ] as [String: Any])
        let env = DMPBridgeEnv(appIndex: 0, appId: "wx92269e3b2f304afc", webViewId: 0)

        _ = handler(param, env) { _, type in
            callbackTypes.append(type)
            if type == .complete { settled.fulfill() }
        }

        XCTAssertTrue(callbackTypes.isEmpty, "handler settled synchronously on the calling thread")
        wait(for: [settled], timeout: 5)
        XCTAssertEqual(callbackTypes.last, .complete)
    }

    // 单次上限只约束一次请求，导出改成后台执行之后并发几次就能把峰值叠起来；串行是那个上限之所以
    // 还成立的前提。
    func testCanvasExportsOfOneAppRunOneAtATime() {
        let queue = ImageAPI.canvasExportQueue(appId: "wx92269e3b2f304afc")
        let lock = NSLock()
        var active = 0
        var peak = 0
        let done = expectation(description: "all exports finish")
        done.expectedFulfillmentCount = 6

        for _ in 0..<6 {
            queue.async {
                lock.lock()
                active += 1
                peak = max(peak, active)
                lock.unlock()
                Thread.sleep(forTimeInterval: 0.01)
                lock.lock()
                active -= 1
                lock.unlock()
                done.fulfill()
            }
        }

        wait(for: [done], timeout: 10)
        XCTAssertEqual(peak, 1)
    }

    func testCanvasExportQueueIsPerApp() {
        let first = ImageAPI.canvasExportQueue(appId: "wx-first")
        let second = ImageAPI.canvasExportQueue(appId: "wx-second")

        XCTAssertTrue(first === ImageAPI.canvasExportQueue(appId: "wx-first"))
        XCTAssertFalse(first === second)
    }

    // 销毁只取消还没开始的任务，已经进入队列执行的旧任务会继续解码和写盘。队列一旦按代次分片，
    // 新 runtime 的任务就会拿到另一条队列，和旧任务并发各占一份位图。
    @MainActor
    func testARestartedRuntimeKeepsExportingOnTheQueueOfTheStillRunningExport() {
        let appId = "canvas-restart-\(UUID().uuidString)"
        guard let running = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "old") else {
            return XCTFail("the first export should be reservable")
        }
        XCTAssertEqual(ImageAPI.beginCanvasExport(running), "old")

        ImageAPI.clearApp(appId)

        guard let restarted = ImageAPI.reserveCanvasExport(appId: appId, bytes: 4, payload: "new") else {
            return XCTFail("a restarted runtime should still be able to reserve an export")
        }
        XCTAssertNotEqual(running.generation, restarted.generation)
        XCTAssertTrue(running.queue === restarted.queue)

        ImageAPI.finishCanvasExport(running)
        ImageAPI.finishCanvasExport(restarted)
    }
}
