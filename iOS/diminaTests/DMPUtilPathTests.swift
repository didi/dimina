//
//  DMPUtilPathTests.swift
//  diminaTests
//

import XCTest
@testable import dimina

final class DMPUtilPathTests: XCTestCase {

    func testVirtualFilePrefix_normalizesSchemeAndRejectsPaths() {
        XCTAssertEqual(DMPFileUtil.normalizedVirtualFilePrefix("HostFile://"), "hostfile://")
        XCTAssertNil(DMPFileUtil.normalizedVirtualFilePrefix("host-file://usr/"))
        XCTAssertNil(DMPFileUtil.normalizedVirtualFilePrefix("host-file"))
        XCTAssertNil(DMPFileUtil.normalizedVirtualFilePrefix("https://"))
    }

    func testVirtualFilePrefix_configurationUpdatesSchemeAndPrefixTogether() {
        let previous = DMPFileUtil.virtualFilePrefix
        defer { XCTAssertTrue(DMPFileUtil.configureVirtualFilePrefix(previous)) }

        XCTAssertTrue(DMPFileUtil.configureVirtualFilePrefix("HostFile://"))
        XCTAssertEqual(DMPFileUtil.DMPFileURLScheme, "hostfile")
        XCTAssertEqual(DMPFileUtil.virtualFilePrefix, "hostfile://")
    }

    // MARK: - normalizePagePath

    func testNormalizePagePath_stripsSingleLeadingSlash() {
        XCTAssertEqual(DMPUtil.normalizePagePath("/pages/detail/index"), "pages/detail/index")
    }

    func testNormalizePagePath_stripsMultipleLeadingSlashes() {
        XCTAssertEqual(DMPUtil.normalizePagePath("//pages/detail/index"), "pages/detail/index")
    }

    func testNormalizePagePath_leavesAlreadyNormalizedPathUnchanged() {
        XCTAssertEqual(DMPUtil.normalizePagePath("pages/index/index"), "pages/index/index")
    }

    func testNormalizePagePath_emptyStringStaysEmpty() {
        XCTAssertEqual(DMPUtil.normalizePagePath(""), "")
    }

    func testNormalizePagePath_singleSlashStripsToEmpty() {
        XCTAssertEqual(DMPUtil.normalizePagePath("/"), "")
    }

    func testNormalizePagePath_doesNotTouchTrailingSlash() {
        XCTAssertEqual(DMPUtil.normalizePagePath("pages/a/b/"), "pages/a/b/")
    }

    // MARK: - queryPath

    func testQueryPath_normalizesLeadingSlashAndParsesQuery() {
        let result = DMPUtil.queryPath(path: "/pages/detail/index?id=1&name=foo")

        XCTAssertEqual(result["pagePath"] as? String, "pages/detail/index")
        XCTAssertEqual(result["query"] as? [String: String], ["id": "1", "name": "foo"])
    }

    func testQueryPath_noLeadingSlashNoQuery() {
        let result = DMPUtil.queryPath(path: "pages/index/index")

        XCTAssertEqual(result["pagePath"] as? String, "pages/index/index")
        XCTAssertEqual(result["query"] as? [String: String], [:])
    }

    func testQueryPath_trailingQuestionMarkWithNoQueryYieldsEmptyQuery() {
        let result = DMPUtil.queryPath(path: "/pages/index/index?")

        XCTAssertEqual(result["pagePath"] as? String, "pages/index/index")
        XCTAssertEqual(result["query"] as? [String: String], [:])
    }

    func testQueryPath_multipleLeadingSlashesStripped() {
        let result = DMPUtil.queryPath(path: "//pages/a/b?x=1")

        XCTAssertEqual(result["pagePath"] as? String, "pages/a/b")
        XCTAssertEqual(result["query"] as? [String: String], ["x": "1"])
    }

    func testQueryPath_valueContainingEqualsSignIsKeptWhole() {
        // Splits on the FIRST '=' only, matching Android Utils.kt (split("=", limit=2))
        // and Harmony DataTransformer.ets (indexOf('=')) — a value like a JWT or a
        // re-encoded nested URL commonly contains '='.
        let result = DMPUtil.queryPath(path: "pages/detail/index?token=a=b")

        XCTAssertEqual(result["query"] as? [String: String], ["token": "a=b"])
    }

    func testQueryPath_nestedURLContainingQuestionMarkIsKeptWhole() {
        let result = DMPUtil.queryPath(path: "/pages/web/index?url=https://a.com/b?c=1")

        XCTAssertEqual(result["pagePath"] as? String, "pages/web/index")
        XCTAssertEqual(result["query"] as? [String: String], ["url": "https://a.com/b?c=1"])
    }

    func testQueryPath_multipleAndTrailingQuestionMarksAreKeptWhole() {
        let result = DMPUtil.queryPath(path: "pages/web/index?url=https://a.com/b??c=1?")

        XCTAssertEqual(result["pagePath"] as? String, "pages/web/index")
        XCTAssertEqual(result["query"] as? [String: String], ["url": "https://a.com/b??c=1?"])
    }

    func testQueryPath_parsesOtherParametersAfterNestedURL() {
        let result = DMPUtil.queryPath(path: "pages/web/index?url=https://a.com/b?c=1&from=share")

        XCTAssertEqual(result["query"] as? [String: String], [
            "url": "https://a.com/b?c=1",
            "from": "share",
        ])
    }

    func testQueryPath_paramWithNoEqualsSignIsDropped() {
        let result = DMPUtil.queryPath(path: "pages/detail/index?flag&id=1")

        XCTAssertEqual(result["query"] as? [String: String], ["id": "1"])
    }

    func testQueryPath_emptyKeyIsDropped() {
        let result = DMPUtil.queryPath(path: "pages/detail/index?=orphaned&id=1")

        XCTAssertEqual(result["query"] as? [String: String], ["id": "1"])
    }

    // MARK: - appAccessiblePath

    func testAppAccessiblePath_resolvesPackageAndVirtualFilesForCurrentApp() throws {
        let appId = "path-test-\(UUID().uuidString)"
        XCTAssertTrue(DMPSandboxManager.initBundleDirectoryForApp(appId: appId))
        defer { DMPFileUtil.removeItem(at: DMPSandboxManager.appBundlePath(appId)) }

        let packageFile = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(appId))
            .appendingPathComponent("main/static/video.mp4")
        try FileManager.default.createDirectory(
            at: packageFile.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("video".utf8).write(to: packageFile)

        XCTAssertEqual(
            DMPFileUtil.appAccessiblePath(from: "main/static/video.mp4", appId: appId),
            packageFile.path
        )
        XCTAssertEqual(
            DMPFileUtil.appAccessiblePath(from: packageFile.absoluteString, appId: appId),
            packageFile.path
        )
        XCTAssertEqual(
            DMPFileUtil.appAccessiblePath(from: "difile://usr/video.mp4", appId: appId),
            URL(fileURLWithPath: DMPSandboxManager.appStoreResourceDirectoryPath(appId: appId))
                .appendingPathComponent("video.mp4").path
        )
    }

    func testAppAccessiblePath_rejectsHostAndOtherAppFiles() {
        let appId = "path-test-\(UUID().uuidString)"
        XCTAssertTrue(DMPSandboxManager.initBundleDirectoryForApp(appId: appId))
        defer { DMPFileUtil.removeItem(at: DMPSandboxManager.appBundlePath(appId)) }

        XCTAssertNil(DMPFileUtil.appAccessiblePath(from: "/private/tmp/host.mp4", appId: appId))
        XCTAssertNil(DMPFileUtil.appAccessiblePath(from: "file://example.com/private/video.mp4", appId: appId))
        XCTAssertNil(DMPFileUtil.appAccessiblePath(from: "../other-app/video.mp4", appId: appId))
    }
}
