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
