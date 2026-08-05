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
        XCTAssertEqual(DMPWebSocketValidation.validateHeader("nope").errorTail, DMPWebSocketValidation.ErrorTail.headerNotObject)
    }

    func test_validateHeader_dropsForbiddenHeadersSilently() {
        let result = DMPWebSocketValidation.validateHeader([
            "Connection": "keep-alive",
            "Sec-WebSocket-Key": "abc",
            "X-Custom": "value",
        ])
        let header = result.value!
        XCTAssertNil(header["Connection"])
        XCTAssertNil(header["Sec-WebSocket-Key"])
        XCTAssertEqual(header["X-Custom"], "value")
    }

    func test_validateHeader_errorsOnCRLFInjection() {
        let result = DMPWebSocketValidation.validateHeader(["X-Evil": "value\r\nInjected: true"])
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidHeader)
    }

    func test_validateHeader_errorsOnNamesThatAreNotRfcTokens() {
        // A CRLF-only check lets all of these through; the platform's request builder is then free
        // to reject or mangle them, and the three platforms stop agreeing on what a header is.
        for name in ["Bad:Name", "Bad Name", "Bad\tName", "Bad\"Name", "Bad(Name)", "Bad/Name"] {
            let result = DMPWebSocketValidation.validateHeader([name: "v"])
            XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidHeader, "expected \(name) to be rejected")
        }
    }

    func test_validateHeader_acceptsEveryRfcTokenCharacterInAName() {
        let name = "!#$%&'*+-.^_`|~0Az"
        let result = DMPWebSocketValidation.validateHeader([name: "v"])
        XCTAssertEqual(result.value?[name], "v")
    }

    func test_validateHeader_errorsOnControlCharactersInValue() {
        // NUL, SOH, vertical tab, unit separator, DEL - none may travel in a field value.
        for value in ["a\u{0000}b", "a\u{0001}b", "a\u{000B}b", "a\u{001F}b", "a\u{007F}b"] {
            let result = DMPWebSocketValidation.validateHeader(["X-Custom": value])
            XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidHeader)
        }
    }

    func test_validateHeader_keepsTabAndSpaceInValue() {
        let result = DMPWebSocketValidation.validateHeader(["X-Custom": "a\tb c"])
        XCTAssertEqual(result.value?["X-Custom"], "a\tb c")
    }

    func test_validateHeader_dropsNullValue() {
        let result = DMPWebSocketValidation.validateHeader(["X-Null": NSNull()])
        XCTAssertNil(result.value!["X-Null"])
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

    // MARK: closeSocket code — cross-platform boundary table
    //
    // One test per input shape, kept 1:1 with the Android/HarmonyOS
    // counterparts for this contract: missing/NSNull -> default 1000;
    // numbers must be finite integers; strings are trimmed then parsed with
    // JS `Number()` semantics (empty string -> failure, not 0); booleans and
    // other non-numeric/non-string shapes (arrays, dictionaries) fail at the
    // type layer. Range check: exactly 1000 or within [3000, 4999].
    //
    // NOTE: as of this writing, `jsNumberValue` still maps an empty/blank
    // string to 0 and a Bool to 1/0 instead of failing at the type layer —
    // but since 0 and 1 both fall outside the valid code ranges, the range
    // check downstream produces the same "invalid code" failure either way.
    // The string/bool/array/dictionary cases below therefore currently PASS
    // by coincidence, not because the type-layer check exists yet; they pin
    // the *observable* contract so a future reimplementation of either layer
    // cannot silently regress it.

    func test_boundaryTable_missing_defaultsTo1000() {
        let result = DMPWebSocketValidation.validateCloseCode(nil)
        XCTAssertEqual(result.value, 1000)
    }

    func test_boundaryTable_nsNull_defaultsTo1000() {
        let result = DMPWebSocketValidation.validateCloseCode(NSNull())
        XCTAssertEqual(result.value, 1000)
    }

    func test_boundaryTable_int1000_isValidNormalClosure() {
        let result = DMPWebSocketValidation.validateCloseCode(1000)
        XCTAssertEqual(result.value, 1000)
    }

    func test_boundaryTable_int999_isBelowValidRange() {
        let result = DMPWebSocketValidation.validateCloseCode(999)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_int1001_isJustAbove1000() {
        let result = DMPWebSocketValidation.validateCloseCode(1001)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_int2999_isJustBelowAppRange() {
        let result = DMPWebSocketValidation.validateCloseCode(2999)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_int3000_isAppRangeLowerBound() {
        let result = DMPWebSocketValidation.validateCloseCode(3000)
        XCTAssertEqual(result.value, 3000)
    }

    func test_boundaryTable_int4999_isAppRangeUpperBound() {
        let result = DMPWebSocketValidation.validateCloseCode(4999)
        XCTAssertEqual(result.value, 4999)
    }

    func test_boundaryTable_int5000_isAboveAppRange() {
        let result = DMPWebSocketValidation.validateCloseCode(5000)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_double3000Point0_isAWholeNumber() {
        let result = DMPWebSocketValidation.validateCloseCode(3000.0)
        XCTAssertEqual(result.value, 3000)
    }

    func test_boundaryTable_double3000Point5_isNotAnInteger() {
        let result = DMPWebSocketValidation.validateCloseCode(3000.5)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_doubleNaN_isNotFinite() {
        let result = DMPWebSocketValidation.validateCloseCode(Double.nan)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_doubleInfinity_isNotFinite() {
        let result = DMPWebSocketValidation.validateCloseCode(Double.infinity)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringPlainDigits3000_parsesToValidCode() {
        let result = DMPWebSocketValidation.validateCloseCode("3000")
        XCTAssertEqual(result.value, 3000)
    }

    func test_boundaryTable_stringPaddedWithSpaces3000_isTrimmedFirst() {
        let result = DMPWebSocketValidation.validateCloseCode(" 3000 ")
        XCTAssertEqual(result.value, 3000)
    }

    func test_boundaryTable_stringDecimalWhole3000Point0_parsesToValidCode() {
        let result = DMPWebSocketValidation.validateCloseCode("3000.0")
        XCTAssertEqual(result.value, 3000)
    }

    func test_boundaryTable_stringDecimalFraction3000Point5_isNotAnInteger() {
        let result = DMPWebSocketValidation.validateCloseCode("3000.5")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringNonNumericAbc_failsToParse() {
        let result = DMPWebSocketValidation.validateCloseCode("abc")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringEmpty_mustFailNotDefaultToZero() {
        // New contract: an empty string must fail at the type layer, not
        // coerce to 0 (which happens to fail anyway via the range check —
        // see the NOTE above the MARK for this section).
        let result = DMPWebSocketValidation.validateCloseCode("")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringWhitespaceOnly_mustFailNotDefaultToZero() {
        let result = DMPWebSocketValidation.validateCloseCode("  ")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_boolTrue_mustFailNotCoerceToOne() {
        // New contract: a boolean must fail at the type layer, not coerce to
        // 1 (which happens to fail anyway via the range check — see the NOTE
        // above the MARK for this section).
        let result = DMPWebSocketValidation.validateCloseCode(true)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_boolFalse_mustFailNotCoerceToZero() {
        let result = DMPWebSocketValidation.validateCloseCode(false)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_arrayWrongType_isRejected() {
        let result = DMPWebSocketValidation.validateCloseCode([3000])
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_dictionaryWrongType_isRejected() {
        let result = DMPWebSocketValidation.validateCloseCode(["code": 3000])
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
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
        let result = DMPWebSocketValidation.validateHeader(["  X-Custom  ": "value"])
        XCTAssertEqual(result.value?["X-Custom"], "value")
        XCTAssertNil(result.value?["  X-Custom  "], "the untrimmed key must not leak into the outgoing header")
    }
}
