//
//  DMPWebResourceLoaderTests.swift
//  diminaTests
//

import ImageIO
import CoreText
import UIKit
import WebKit
import UniformTypeIdentifiers
import XCTest
@testable import dimina

@MainActor
final class DMPWebResourceLoaderTests: XCTestCase {

    func testNavigationAllowsHTTPSubframesWhileKeepingTheMainFrameInternal() {
        let external = URL(string: "https://h5.example/form")!
        XCTAssertTrue(DMPWebview.allowsNavigation(external, isMainFrame: false))
        XCTAssertFalse(DMPWebview.allowsNavigation(external, isMainFrame: true))
        XCTAssertTrue(DMPWebview.allowsNavigation(URL(string: "dimina:///pageFrame.html"), isMainFrame: true))
        for value in ["javascript:alert(1)", "file:///private/data", "dimina:///secret", "https:"] {
            XCTAssertFalse(DMPWebview.allowsNavigation(URL(string: value), isMainFrame: false), value)
        }
    }

    func testHostFontRegistrationAndRemoval() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".ttf")
        defer { try? FileManager.default.removeItem(at: file); DMPHostFonts.unregister("test-brand") }
        let bytes = Data([0, 1, 2, 3])
        try bytes.write(to: file)
        XCTAssertThrowsError(try DMPHostFonts.register("../font", fileURL: file))
        try DMPHostFonts.register("test-brand", fileURL: file)
        let payload = try DMPHostFonts.load("test-brand")
        XCTAssertEqual(payload.data, bytes)
        XCTAssertEqual(payload.mimeType, "font/ttf")
        DMPHostFonts.unregister("test-brand")
        XCTAssertThrowsError(try DMPHostFonts.load("test-brand"))
    }

    func testHostFontIsDecodedByWebKitOnlyAfterExplicitLoading() async throws {
        // Use a runtime-provided TTF so the test does not ship a redundant font fixture.
        let fontURLs = ["CourierNewPSMT", "ArialMT", "Georgia"].compactMap { name -> URL? in
            let font = CTFontCreateWithName(name as CFString, 16, nil)
            return CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL
        }
        let source = try XCTUnwrap(fontURLs.first { ["ttf", "otf"].contains($0.pathExtension.lowercased()) })
        try DMPHostFonts.register("webkit-test", fileURL: source)
        defer { DMPHostFonts.unregister("webkit-test") }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(DiminaURLSchemeHandler(appId: "font-test"), forURLScheme: "dimina")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 200), configuration: config)
        let navigation = HostFontNavigation(expectation: expectation(description: "font test page"))
        web.navigationDelegate = navigation
        web.loadHTMLString("<p style='font-family:HostBrand,serif'>Shared host font</p>",
                           baseURL: URL(string: "dimina:///pageFrame.html"))
        await fulfillment(of: [navigation.expectation], timeout: 15)
        if let error = navigation.error { throw error }
        let initialCount = try await web.evaluateJavaScript("document.fonts.size") as? Int
        XCTAssertEqual(initialCount, 0)
        let result = try await web.callAsyncJavaScript("""
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            context.font = '32px HostBrand, serif';
            const before = context.measureText('iiiiiiiiii').width;
            const font = new FontFace('HostBrand', 'url("dimina:///__dimina_host_fonts/webkit-test")');
            await font.load();
            document.fonts.add(font);
            await document.fonts.ready;
            const nextContext = document.createElement('canvas').getContext('2d');
            nextContext.font = '32px HostBrand, serif';
            const after = nextContext.measureText('iiiiiiiiii').width;
            return { loaded: font.status === 'loaded' && document.fonts.has(font), before, after };
            """, arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        XCTAssertEqual(result?["loaded"] as? Bool, true)
        let before = try XCTUnwrap(result?["before"] as? Double)
        let after = try XCTUnwrap(result?["after"] as? Double)
        XCTAssertGreaterThan(abs(after - before), 1, "Font \(source.lastPathComponent): \(before) -> \(after)")
        let missing = try await web.callAsyncJavaScript("""
            try {
                await new FontFace('Missing', 'url("dimina:///__dimina_host_fonts/unregistered")').load();
                return false;
            } catch (_) { return true; }
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(missing, true)
    }

    func testHEIFFamilyUsesStandardMimeTypes() {
        XCTAssertEqual(DMPWebResourceLoader.mimeType(forExtension: "HEIC"), "image/heic")
        XCTAssertEqual(DMPWebResourceLoader.mimeType(forExtension: "heif"), "image/heif")
    }

    func testPackagedVideoServesOnlyTheRequestedBytes() throws {
        let appId = UUID().uuidString
        let root = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(appId))
        let video = root.appendingPathComponent("main/assets/clip + intro.mp4")
        let fileManager = FileManager.default
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(at: video.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([0, 1, 2, 3, 4]).write(to: video)
        let webView = WKWebView()
        let handler = DiminaURLSchemeHandler(appId: appId)

        let url = try XCTUnwrap(URL(string: "dimina:///__dimina_media?source=assets%2Fclip%20%2B%20intro.mp4"))
        var request = URLRequest(url: url)
        request.setValue("bytes=1-2", forHTTPHeaderField: "Range")
        let task = VideoSchemeTask(request: request)
        handler.webView(webView, start: task)

        XCTAssertNil(task.error)
        XCTAssertTrue(task.finished)
        XCTAssertEqual(task.response?.statusCode, 206)
        XCTAssertEqual(task.response?.mimeType, "video/mp4")
        XCTAssertEqual(task.response?.value(forHTTPHeaderField: "Content-Range"), "bytes 1-2/5")
        XCTAssertEqual(task.data, Data([1, 2]))
    }

    func testTemporaryVideoWithOpaqueExtensionServesOnlyTheRequestedBytes() throws {
        let appId = UUID().uuidString
        let root = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(appId))
        defer { try? FileManager.default.removeItem(at: root) }
        let temporaryDirectory = URL(fileURLWithPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId))
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
        let video = temporaryDirectory.appendingPathComponent("download.tmp")
        try Data([0, 1, 2, 3, 4]).write(to: video)

        let source = DMPFileUtil.vPathFromSandboxPath(sandboxPath: video.path, appId: appId)
        var url = try XCTUnwrap(URLComponents(string: "dimina:///__dimina_media"))
        url.queryItems = [URLQueryItem(name: "source", value: source)]
        var request = URLRequest(url: try XCTUnwrap(url.url))
        request.setValue("bytes=1-2", forHTTPHeaderField: "Range")
        let task = VideoSchemeTask(request: request)
        let handler = DiminaURLSchemeHandler(appId: appId)
        handler.webView(WKWebView(), start: task)

        XCTAssertNil(task.error)
        XCTAssertTrue(task.finished)
        XCTAssertEqual(task.response?.statusCode, 206)
        XCTAssertEqual(task.response?.value(forHTTPHeaderField: "Content-Range"), "bytes 1-2/5")
        XCTAssertEqual(task.data, Data([1, 2]))
    }

    func testHostImagesReadFilesAndConfineDirectoryMappings() throws {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let root = temporary.appendingPathComponent("images")
        let nested = root.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
        defer {
            DMPHostImages.unregister("Light_ON")
            DMPHostImages.unregister("icons")
            try? FileManager.default.removeItem(at: temporary)
        }
        let file = nested.appendingPathComponent("灯 on.webp")
        let bytes = Data([1, 2, 3])
        try bytes.write(to: file)
        try DMPHostImages.register("Light_ON", fileURL: file)
        XCTAssertEqual(try DMPHostImages.load("Light_ON").data, bytes)
        XCTAssertEqual(try DMPHostImages.load("Light_ON").mimeType, "image/webp")
        try Data([9]).write(to: file)
        XCTAssertEqual(try DMPHostImages.load("Light_ON").data, Data([9]))
        XCTAssertThrowsError(try DMPHostImages.load("Light_ON/extra.png"))
        DMPHostImages.unregister("Light_ON")
        XCTAssertThrowsError(try DMPHostImages.load("Light_ON"))
        XCTAssertThrowsError(try DMPHostImages.register("../invalid", fileURL: file))

        try DMPHostImages.registerDirectory("icons", directoryURL: root)
        XCTAssertEqual(try DMPHostImages.load("icons/nested/灯 on.webp").data, Data([9]))
        for key in ["icons/../outside.png", "icons//x.png", "icons/./x.png", "icons/%2e%2e/x.png", "icons/a\\b.png", "icons/", "icons/a?b.png", "icons/missing.png"] {
            XCTAssertThrowsError(try DMPHostImages.load(key), key)
        }
        let secret = root.appendingPathComponent("secret.json")
        try bytes.write(to: secret)
        XCTAssertThrowsError(try DMPHostImages.load("icons/secret.json"))
        let outside = temporary.appendingPathComponent("outside.png")
        try bytes.write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape.png"), withDestinationURL: outside)
        XCTAssertThrowsError(try DMPHostImages.load("icons/escape.png"))
    }

    func testHostImagesDecodeInWebKitAndMissingImagesFail() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer {
            DMPHostImages.unregister("formats")
            DMPHostImages.unregister("asset-catalog")
            try? FileManager.default.removeItem(at: root)
        }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 3), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 3))
        }
        try XCTUnwrap(image.pngData()).write(to: root.appendingPathComponent("image.png"))
        try XCTUnwrap(image.jpegData(compressionQuality: 1)).write(to: root.appendingPathComponent("image.jpg"))
        try XCTUnwrap(Data(base64Encoded: "UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ/Y/+ByKi/wEA"))
            .write(to: root.appendingPathComponent("image.webp"))
        try Data("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='3'><path fill='red' d='M0 0h2v3H0z'/></svg>".utf8)
            .write(to: root.appendingPathComponent("image.svg"))
        try DMPHostImages.registerDirectory("formats", directoryURL: root)
        try DMPHostImages.registerImage("asset-catalog", image: image)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(DiminaURLSchemeHandler(appId: "image-test"), forURLScheme: "dimina")
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 200), configuration: config)
        let navigation = HostFontNavigation(expectation: expectation(description: "image test page"))
        web.navigationDelegate = navigation
        web.loadHTMLString("<body></body>", baseURL: URL(string: "dimina:///pageFrame.html"))
        await fulfillment(of: [navigation.expectation], timeout: 15)
        if let error = navigation.error { throw error }
        let result = try await web.callAsyncJavaScript("""
            const paths = ['formats/image.png', 'formats/image.jpg', 'formats/image.webp', 'formats/image.svg', 'asset-catalog'];
            return await Promise.all(paths.map(path => new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
                image.onerror = () => resolve([-1, -1]);
                image.src = 'dimina:///__dimina_host_images/' + path;
                document.body.appendChild(image);
            })));
            """, arguments: [:], in: nil, contentWorld: .page) as? [[Int]]
        XCTAssertEqual(result, Array(repeating: [2, 3], count: 5))
        DMPHostImages.unregister("formats")
        let failed = try await web.callAsyncJavaScript("""
            return await new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve(false);
                image.onerror = () => resolve(true);
                image.src = 'dimina:///__dimina_host_images/formats/image.png?after-unregister';
            });
            """, arguments: [:], in: nil, contentWorld: .page) as? Bool
        XCTAssertEqual(failed, true)
    }

    func testHEIFFamilyOnlyNeedsFallbackBeforeWebKitSupport() {
        XCTAssertTrue(DMPWebResourceLoader.requiresHEIFTranscode(
            pathExtension: "HEIC",
            webKitSupportsHEIF: false
        ))
        XCTAssertFalse(DMPWebResourceLoader.requiresHEIFTranscode(
            pathExtension: "heif",
            webKitSupportsHEIF: true
        ))
        XCTAssertFalse(DMPWebResourceLoader.requiresHEIFTranscode(
            pathExtension: "jpeg",
            webKitSupportsHEIF: false
        ))
    }

    func testHEIFFallbackReturnsJPEGData() throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        let sourceImage = renderer.image { context in
            context.cgContext.setFillColor(UIColor.red.cgColor)
            context.cgContext.fill(CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        let sourceData = NSMutableData()
        let heicType = try XCTUnwrap(UTType(filenameExtension: "heic"))
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(
            sourceData,
            heicType.identifier as CFString,
            1,
            nil
        ))
        CGImageDestinationAddImage(destination, try XCTUnwrap(sourceImage.cgImage), nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))

        let payload = try DMPWebResourceLoader.makePayload(
            data: sourceData as Data,
            pathExtension: "heic",
            webKitSupportsHEIF: false
        )

        XCTAssertEqual(payload.mimeType, "image/jpeg")
        XCTAssertEqual(Array(payload.data.prefix(2)), [0xFF, 0xD8])
    }

    func testSupportedWebKitReceivesOriginalHEICPayload() throws {
        let sourceData = Data([0x01, 0x02, 0x03])

        let payload = try DMPWebResourceLoader.makePayload(
            data: sourceData,
            pathExtension: "heic",
            webKitSupportsHEIF: true
        )

        XCTAssertEqual(payload.mimeType, "image/heic")
        XCTAssertEqual(payload.data, sourceData)
    }
}

private final class VideoSchemeTask: NSObject, WKURLSchemeTask {
    let request: URLRequest
    var response: HTTPURLResponse?
    var data = Data()
    var finished = false
    var error: Error?

    init(request: URLRequest) {
        self.request = request
    }

    func didReceive(_ response: URLResponse) { self.response = response as? HTTPURLResponse }
    func didReceive(_ data: Data) { self.data.append(data) }
    func didFinish() { finished = true }
    func didFailWithError(_ error: Error) { self.error = error }
}

@MainActor
private final class HostFontNavigation: NSObject, WKNavigationDelegate {
    let expectation: XCTestExpectation
    var error: Error?
    init(expectation: XCTestExpectation) { self.expectation = expectation }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { expectation.fulfill() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.error = error
        expectation.fulfill()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.error = error
        expectation.fulfill()
    }
}
