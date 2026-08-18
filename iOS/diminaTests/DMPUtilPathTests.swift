//
//  DMPUtilPathTests.swift
//  diminaTests
//

import XCTest
@testable import dimina

final class DMPUtilPathTests: XCTestCase {

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

    func testQueryPath_paramWithNoEqualsSignIsDropped() {
        let result = DMPUtil.queryPath(path: "pages/detail/index?flag&id=1")

        XCTAssertEqual(result["query"] as? [String: String], ["id": "1"])
    }

    func testQueryPath_emptyKeyIsDropped() {
        let result = DMPUtil.queryPath(path: "pages/detail/index?=orphaned&id=1")

        XCTAssertEqual(result["query"] as? [String: String], ["id": "1"])
    }
}
