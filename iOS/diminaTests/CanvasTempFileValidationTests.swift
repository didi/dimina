import XCTest
@testable import dimina

final class CanvasTempFileValidationTests: XCTestCase {
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
}
