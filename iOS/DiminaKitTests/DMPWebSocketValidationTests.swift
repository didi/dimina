//
//  DMPWebSocketValidationTests.swift
//  DiminaKitTests
//
//  Pure validation rules for connectSocket / closeSocket.

import XCTest
@testable import dimina

final class DMPWebSocketValidationTests: XCTestCase {

    // MARK: url

    func test_validateUrl_acceptsWsAndWss() {
        XCTAssertNotNil(DMPWebSocketValidation.validateUrl("ws://example.com/socket").value)
        XCTAssertNotNil(DMPWebSocketValidation.validateUrl("wss://example.com/socket").value)
    }

    func test_validateUrl_rejectsNonWebSocketScheme() {
        let result = DMPWebSocketValidation.validateUrl("http://example.com")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    func test_validateUrl_rejectsFragment() {
        let result = DMPWebSocketValidation.validateUrl("wss://example.com/socket#frag")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    func test_validateUrl_rejectsUnparseable() {
        let result = DMPWebSocketValidation.validateUrl("not a url")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    func test_validateUrl_rejectsMissingOrWrongType() {
        XCTAssertEqual(DMPWebSocketValidation.validateUrl(nil).errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
        XCTAssertEqual(DMPWebSocketValidation.validateUrl(123).errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    // MARK: timeout

    func test_validateTimeout_defaultsWhenMissing() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(nil).value, 60000)
    }

    func test_validateTimeout_fallsBackSilentlyWhenNonPositive() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(0).value, 60000)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(-5).value, 60000)
    }

    func test_validateTimeout_errorsOnNonFinite() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(Double.nan).errorTail, DMPWebSocketValidation.ErrorTail.invalidTimeout)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout("not-a-number").errorTail, DMPWebSocketValidation.ErrorTail.invalidTimeout)
    }

    func test_validateTimeout_errorsWhenAboveInt32Max() {
        let result = DMPWebSocketValidation.validateTimeout(Double(0x7fffffff) + 1)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidTimeout)
    }

    func test_validateTimeout_acceptsPositiveValue() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1500).value, 1500)
    }

    // MARK: protocols

    func test_validateProtocols_defaultsToEmpty() {
        XCTAssertEqual(DMPWebSocketValidation.validateProtocols(nil).value, [])
    }

    func test_validateProtocols_errorsOnNonArray() {
        XCTAssertEqual(DMPWebSocketValidation.validateProtocols("chat").errorTail, DMPWebSocketValidation.ErrorTail.protocolsNotArray)
    }

    func test_validateProtocols_errorsOnEmptyStringItem() {
        XCTAssertEqual(DMPWebSocketValidation.validateProtocols(["chat", ""]).errorTail, DMPWebSocketValidation.ErrorTail.invalidProtocol)
    }

    func test_validateProtocols_errorsOnNonStringItem() {
        XCTAssertEqual(DMPWebSocketValidation.validateProtocols(["chat", 5]).errorTail, DMPWebSocketValidation.ErrorTail.invalidProtocol)
    }

    func test_validateProtocols_acceptsValidArray() {
        XCTAssertEqual(DMPWebSocketValidation.validateProtocols(["chat", "superchat"]).value, ["chat", "superchat"])
    }

    // MARK: header

    func test_validateHeader_errorsOnNonObject() {
        let url = URL(string: "wss://example.com/socket")!
        XCTAssertEqual(DMPWebSocketValidation.validateHeader("nope", url: url).errorTail, DMPWebSocketValidation.ErrorTail.headerNotObject)
    }

    func test_validateHeader_dropsForbiddenHeadersSilently() {
        let url = URL(string: "wss://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader([
            "Connection": "keep-alive",
            "Sec-WebSocket-Key": "abc",
            "X-Custom": "value",
        ], url: url)
        let header = result.value!
        XCTAssertNil(header["Connection"])
        XCTAssertNil(header["Sec-WebSocket-Key"])
        XCTAssertEqual(header["X-Custom"], "value")
    }

    func test_validateHeader_errorsOnCRLFInjection() {
        let url = URL(string: "wss://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader(["X-Evil": "value\r\nInjected: true"], url: url)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidHeader)
    }

    func test_validateHeader_dropsNullValue() {
        let url = URL(string: "wss://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader(["X-Null": NSNull()], url: url)
        XCTAssertNil(result.value!["X-Null"])
    }

    func test_validateHeader_injectsOriginForWss() {
        let url = URL(string: "wss://example.com:8443/socket")!
        let result = DMPWebSocketValidation.validateHeader(nil, url: url)
        XCTAssertEqual(result.value?["Origin"], "https://example.com:8443")
    }

    func test_validateHeader_injectsOriginForWs() {
        let url = URL(string: "ws://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader(nil, url: url)
        XCTAssertEqual(result.value?["Origin"], "http://example.com")
    }

    func test_validateHeader_originStripsExplicitDefaultPort() {
        // An explicitly-written default port (:80 for ws, :443 for wss) must be stripped from the
        // Origin header, matching Android's URI-based origin computation and the dimina-kit
        // `new URL(...).origin` ground truth - a non-default port must be kept.
        let wss = DMPWebSocketValidation.validateHeader(nil, url: URL(string: "wss://example.com:443/socket")!)
        XCTAssertEqual(wss.value?["Origin"], "https://example.com")

        let ws = DMPWebSocketValidation.validateHeader(nil, url: URL(string: "ws://example.com:80/socket")!)
        XCTAssertEqual(ws.value?["Origin"], "http://example.com")

        let nonDefault = DMPWebSocketValidation.validateHeader(nil, url: URL(string: "wss://example.com:80/socket")!)
        XCTAssertEqual(nonDefault.value?["Origin"], "https://example.com:80", "port 80 is not the default for wss, must be kept")
    }

    func test_validateHeader_doesNotOverrideCallerSuppliedOrigin_caseInsensitive() {
        let url = URL(string: "wss://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader(["origin": "https://caller.example"], url: url)
        XCTAssertEqual(result.value?["origin"], "https://caller.example")
        XCTAssertNil(result.value?["Origin"])
    }

    // MARK: closeSocket code

    func test_validateCloseCode_defaultsTo1000() {
        XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(nil).value, 1000)
    }

    func test_validateCloseCode_acceptsBoundaries() {
        XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(1000).value, 1000)
        XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(3000).value, 3000)
        XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(4999).value, 4999)
    }

    func test_validateCloseCode_rejectsOutOfRange() {
        for invalid in [999, 1001, 2999, 5000] {
            XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(invalid).errorTail, DMPWebSocketValidation.ErrorTail.invalidCode,
                           "expected \(invalid) to be rejected")
        }
    }

    func test_validateCloseCode_rejectsNonInteger() {
        XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(1000.5).errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    // MARK: closeSocket reason

    func test_validateCloseReason_defaultsToEmptyString() {
        XCTAssertEqual(DMPWebSocketValidation.validateCloseReason(nil).value, "")
    }

    func test_validateCloseReason_rejectsNonString() {
        XCTAssertEqual(DMPWebSocketValidation.validateCloseReason(42).errorTail, DMPWebSocketValidation.ErrorTail.reasonMustBeString)
    }

    func test_validateCloseReason_rejectsOver123Utf8Bytes() {
        let longReason = String(repeating: "a", count: 124)
        XCTAssertEqual(DMPWebSocketValidation.validateCloseReason(longReason).errorTail, DMPWebSocketValidation.ErrorTail.reasonTooLong)
    }

    func test_validateCloseReason_accepts123Utf8Bytes() {
        let reason = String(repeating: "a", count: 123)
        XCTAssertEqual(DMPWebSocketValidation.validateCloseReason(reason).value, reason)
    }

    // MARK: hasSocketId

    func test_hasSocketId_isKeyPresenceNotTruthiness() {
        // The wire contract branches on `params.has("socketId")`, not on
        // whether the value is a non-empty string — {socketId: ""} is a
        // malformed *task-mode* call, not a legacy-mode call.
        XCTAssertTrue(DMPWebSocketValidation.hasSocketId(DMPMap(["socketId": "abc"])))
        XCTAssertTrue(DMPWebSocketValidation.hasSocketId(DMPMap(["socketId": ""])), "an empty string key must still count as present")
        XCTAssertTrue(DMPWebSocketValidation.hasSocketId(DMPMap(["socketId": NSNull()])), "a present-but-null value must still count as present, not fall back to legacy mode")
        XCTAssertFalse(DMPWebSocketValidation.hasSocketId(DMPMap([:])))
    }

    // MARK: timeout normalization fidelity vs dimina-kit (Math.floor, not round)

    func test_validateTimeout_flooredNotRounded() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1500.7).value, 1500, "dimina-kit uses Math.floor, not round-half-away-from-zero")
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1500.1).value, 1500)
    }

    // MARK: header name trimming fidelity

    func test_validateHeader_storesTrimmedNameNotRawName() {
        let url = URL(string: "wss://example.com/socket")!
        let result = DMPWebSocketValidation.validateHeader(["  X-Custom  ": "value"], url: url)
        XCTAssertEqual(result.value?["X-Custom"], "value")
        XCTAssertNil(result.value?["  X-Custom  "], "the untrimmed key must not leak into the outgoing header")
    }
}
