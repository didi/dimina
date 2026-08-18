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
}
