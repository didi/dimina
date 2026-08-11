//
//  DMPWebSocketValidationTests.swift
//  DiminaKitTests
//
//  Pure validation rules for connectSocket / closeSocket, plus the two links of the chain that
//  supplies connectSocket's default timeout: parsing `networkTimeout.connectSocket` out of
//  app.json, and the guard that keeps a mini program's JS from running before that config exists.

import CFNetwork
import JavaScriptCore
import XCTest
@testable import dimina

final class DMPWebSocketValidationTests: XCTestCase {

    // MARK: error text

    /// Every other assertion in this file compares an `errorTail` against the very constant the
    /// production code returns, so a typo inside `ErrorTail` would appear on both sides of the
    /// comparison and stay green. These strings are contract: a mini program branches on them and
    /// the other two platforms carry byte-identical copies. Spelling them out literally once is
    /// what makes the rest of the file mean something.
    func test_errorTails_areTheContractStrings() {
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidSocketId, "invalid socketId")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.reachMaxCount,
                       "fail reach max websocket connect count 5")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidUrl, "invalid url")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidTimeout, "invalid timeout")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.protocolsNotArray, "protocols must be an array")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidProtocol, "invalid protocol")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.headerNotObject, "header must be an object")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidHeader, "invalid header")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.interrupted, "interrupted")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.timeout, "timeout")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.connectionFailed, "WebSocket connection failed")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.notConnected, "WebSocket is not connected")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.dataMustBeStringOrBuffer,
                       "data must be string or ArrayBuffer")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.invalidCode, "invalid code")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.reasonMustBeString, "reason must be a string")
        XCTAssertEqual(DMPWebSocketValidation.ErrorTail.reasonTooLong,
                       "reason must not exceed 123 UTF-8 bytes")
    }

    // MARK: url

    func test_validateUrl_acceptsWssAndRejectsWs() {
        XCTAssertNotNil(DMPWebSocketValidation.validateUrl("wss://example.com/socket").value)
        XCTAssertEqual(DMPWebSocketValidation.validateUrl("ws://example.com/socket").errorTail,
                       DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    func test_validateUrl_rejectsNonWebSocketScheme() {
        let result = DMPWebSocketValidation.validateUrl("http://example.com")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    /// URI schemes are case-insensitive, while the public network policy permits only WSS.
    func test_validateUrl_wssSchemeMatchIsCaseInsensitive() {
        for accepted in ["wss://example.com/socket", "WSS://example.com/socket",
                         "Wss://example.com/socket", "wSs://example.com/socket"] {
            XCTAssertNotNil(DMPWebSocketValidation.validateUrl(accepted).value,
                            "expected \(accepted) to be accepted")
        }
    }

    func test_validateUrl_plainWsIsRejected() {
        let result = DMPWebSocketValidation.validateUrl("ws://example.com/socket")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    /// A bare space is not a legal URL character. `URLComponents` accepts one and quietly
    /// percent-encodes it, so the container would dial a url the caller never wrote — and one the
    /// other platforms refuse outright, since `java.net.URI` rejects the character class a space
    /// belongs to. Silently rewriting a caller's url is worse than failing it: the mini program
    /// gets a connection to a different resource with no indication anything was changed.
    func test_validateUrl_rejectsBareSpace() {
        XCTAssertEqual(DMPWebSocketValidation.validateUrl("wss://example.com/a b").errorTail,
                       DMPWebSocketValidation.ErrorTail.invalidUrl)
    }

    /// The other half of the same rule: rejecting the raw character must not cost the caller the
    /// legitimate way to express it. An already-encoded space is a well-formed url and stays one.
    func test_validateUrl_acceptsPercentEncodedSpace() {
        let result = DMPWebSocketValidation.validateUrl("wss://example.com/a%20b")
        XCTAssertEqual(result.value?.absoluteString, "wss://example.com/a%20b",
                       "an encoded space is valid and must survive validation unchanged")
    }

    func test_validateUrl_rejectsEveryNonWebSocketScheme() {
        for rejected in ["ws://example.com/socket", "WS://example.com/socket",
                         "http://example.com/socket", "https://example.com/socket",
                         "ftp://example.com/socket", "file:///tmp/socket",
                         "wsx://example.com/socket", "//example.com/socket",
                         "example.com/socket"] {
            XCTAssertEqual(DMPWebSocketValidation.validateUrl(rejected).errorTail,
                           DMPWebSocketValidation.ErrorTail.invalidUrl,
                           "expected \(rejected) to be rejected")
        }
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

    func test_validateTimeout_rejectsNonNumberTypes() {
        for invalid: Any in ["5000", true, [5000], ["timeout": 5000]] {
            XCTAssertEqual(DMPWebSocketValidation.validateTimeout(invalid).errorTail, DMPWebSocketValidation.ErrorTail.invalidTimeout)
        }
    }

    func test_validateTimeout_errorsWhenAboveInt32Max() {
        let result = DMPWebSocketValidation.validateTimeout(Double(0x7fffffff) + 1)
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidTimeout)
    }

    func test_validateTimeout_acceptsPositiveValue() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1500).value, 1500)
    }

    // MARK: timeout — app.json networkTimeout.connectSocket
    //
    // 60000 is the last resort, not the configured default: `app.json`'s
    // `networkTimeout.connectSocket` supplies the default when the caller omits `timeout`, and the
    // value passed at the call site outranks it.

    func test_validateTimeout_missingUsesAppJsonNetworkTimeout() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(nil, appDefaultMs: 8000).value, 8000)
    }

    func test_validateTimeout_missingWithoutAppJsonNetworkTimeoutUses60000() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(nil, appDefaultMs: nil).value, 60000)
    }

    func test_validateTimeout_appJsonValueAboveInt32MaxUses60000() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(nil, appDefaultMs: Int.max).value, 60000)
    }

    func test_validateTimeout_callSiteValueOutranksAppJsonNetworkTimeout() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(3000, appDefaultMs: 8000).value, 3000)
    }

    func test_validateTimeout_nonPositiveFallsBackToAppJsonNetworkTimeout() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(0, appDefaultMs: 8000).value, 8000)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(-5, appDefaultMs: 8000).value, 8000)
    }

    /// A timeout below one millisecond floors to 0, and 0 is not "no deadline" here — it is a
    /// deadline that has already passed, so the attempt fails before the handshake can possibly
    /// finish. Nothing expressible below the unit carries usable intent, so it counts as
    /// unspecified and the configured default applies, exactly like a missing value.
    func test_validateTimeout_subMillisecondValueCountsAsUnspecified() {
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(0.5, appDefaultMs: 8000).value, 8000)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(0.001).value, 60000)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(0.999).value, 60000)
    }

    func test_validateTimeout_oneMillisecondIsTheSmallestUsableValue() {
        // The boundary on the other side: 1 ms is expressible and must be honoured verbatim, so
        // the rule cannot be implemented as "anything under some comfortable floor is unspecified".
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1).value, 1)
        XCTAssertEqual(DMPWebSocketValidation.validateTimeout(1.5).value, 1)
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

    /// RFC 7230 deprecated obs-text (bytes >= 0x80) in field values, and OkHttp enforces exactly
    /// that, so a Chinese header value connects on one platform and fails on another today. fe
    /// passes string header values through untouched, which makes this a reachable input rather
    /// than a theoretical one.
    func test_validateHeader_rejectsNonAsciiValue() {
        XCTAssertEqual(DMPWebSocketValidation.validateHeader(["X-A": "中文"]).errorTail,
                       DMPWebSocketValidation.ErrorTail.invalidHeader)
    }

    func test_validateHeader_rejectsNonAsciiValueRegardlessOfPosition() {
        for value in ["中文", "prefix-中文", "中文-suffix", "a中b", "café", "emoji-🙂"] {
            XCTAssertEqual(DMPWebSocketValidation.validateHeader(["X-A": value]).errorTail,
                           DMPWebSocketValidation.ErrorTail.invalidHeader,
                           "expected \(value) to be rejected")
        }
    }

    func test_validateHeader_keepsEveryPrintableAsciiValue() {
        // The other half: tightening to ASCII must not cost the values that were always legal.
        let printable = (0x20...0x7E).map { Character(Unicode.Scalar($0)!) }
        let value = String(printable)
        XCTAssertEqual(DMPWebSocketValidation.validateHeader(["X-A": value]).value?["X-A"], value)
    }

    /// The url is governed by percent-encoding and IDN rules, not by RFC 7230's field-value rules.
    /// Tightening header values to ASCII must not bleed into url validation and start refusing
    /// Chinese paths or internationalised hosts.
    func test_validateUrl_nonAsciiPathIsNotSubjectToTheHeaderAsciiRule() {
        XCTAssertNotNil(DMPWebSocketValidation.validateUrl("wss://example.com/中文").value,
                        "url and header values are two different rule sets")
    }

    /// Request headers are deliberately not case-folded: WeChat sends what the caller wrote, and
    /// two names differing only in case are two separate fields. Validation gets this right today,
    /// which localises the loss further down the chain — the request builder, not this function.
    func test_validateHeader_keepsBothCaseVariantsOfAFieldName() {
        let result = DMPWebSocketValidation.validateHeader(["X-Dimina-Case": "upper",
                                                            "x-dimina-case": "lower"])
        XCTAssertEqual(result.value?["X-Dimina-Case"], "upper")
        XCTAssertEqual(result.value?["x-dimina-case"], "lower")
        XCTAssertEqual(result.value?.count, 2, "case folding request header names is the response-side rule, not this one")
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

    /// The RFC 6455 range check is a transport-layer rule, not an API-surface rule:
    /// `URLSessionWebSocketTask` (like OkHttp and `@ohos.net.webSocket`) refuses to send a close
    /// frame carrying anything outside `1000` or `3000...4999`, so native has to reject those
    /// codes rather than hand them to a transport that will drop them. This test pins that range
    /// so a later alignment pass on the service-layer close semantics does not delete it.
    func test_validateCloseCode_nativeKeepsTheRfc6455SendableRange() {
        for accepted in [1000, 3000, 3999, 4000, 4999] {
            XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(accepted).value, accepted,
                           "expected \(accepted) to be sendable")
        }
        for rejected in [0, 999, 1001, 1005, 1006, 1011, 2999, 5000, 65535] {
            XCTAssertEqual(DMPWebSocketValidation.validateCloseCode(rejected).errorTail,
                           DMPWebSocketValidation.ErrorTail.invalidCode,
                           "expected \(rejected) to be refused by the transport-layer range check")
        }
    }

    // MARK: closeSocket code — cross-platform boundary table
    //
    // One test per input shape, kept 1:1 with the Android/HarmonyOS
    // counterparts for this contract: missing/NSNull -> default 1000; only
    // finite integer numbers are accepted. Range: exactly 1000 or [3000, 4999].

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

    func test_boundaryTable_stringPlainDigits3000_isRejected() {
        let result = DMPWebSocketValidation.validateCloseCode("3000")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringPaddedWithSpaces3000_isRejected() {
        let result = DMPWebSocketValidation.validateCloseCode(" 3000 ")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
    }

    func test_boundaryTable_stringDecimalWhole3000Point0_isRejected() {
        let result = DMPWebSocketValidation.validateCloseCode("3000.0")
        XCTAssertEqual(result.errorTail, DMPWebSocketValidation.ErrorTail.invalidCode)
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

// MARK: - app.json networkTimeout.connectSocket

/// `DMPBundleAppConfig.networkTimeoutConnectSocketMs` is where connectSocket's default timeout
/// enters the container. It returns nil for "not configured", and every shape that is not a usable
/// positive number counts as not configured — the caller then falls back to 60000. Returning a
/// value for junk input would silently replace WeChat's documented default with, say, 0 or 1.
final class DMPBundleAppConfigNetworkTimeoutTests: XCTestCase {

    private func timeout(fromAppJson json: String,
                         file: StaticString = #filePath, line: UInt = #line) throws -> Int? {
        let config = try XCTUnwrap(DMPBundleAppConfig.fromJsonString(json: json),
                                   "app.json fixture did not parse: \(json)", file: file, line: line)
        return config.networkTimeoutConnectSocketMs
    }

    func test_networkTimeout_readsConfiguredConnectSocketValue() throws {
        XCTAssertEqual(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":10000}}}"#), 10000)
    }

    func test_networkTimeout_readsConnectSocketAlongsideSiblingTimeouts() throws {
        // The other networkTimeout keys belong to request/uploadFile/downloadFile and must not be
        // picked up by mistake.
        let json = #"{"app":{"networkTimeout":{"request":5000,"connectSocket":10000,"uploadFile":7000}}}"#
        XCTAssertEqual(try timeout(fromAppJson: json), 10000)
    }

    func test_networkTimeout_missingConnectSocketKeyIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"request":5000}}}"#))
    }

    func test_networkTimeout_missingNetworkTimeoutBlockIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"pages":["pages/index/index"]}}"#))
    }

    func test_networkTimeout_missingAppBlockIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"modules":{}}"#))
    }

    func test_networkTimeout_nullConnectSocketIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":null}}}"#))
    }

    func test_networkTimeout_zeroIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":0}}}"#))
    }

    func test_networkTimeout_negativeIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":-1}}}"#))
    }

    func test_networkTimeout_stringIsNotConfigured() throws {
        // app.json documents this key as a number. A quoted "10000" is a malformed config, not a
        // value to coerce — coercing it would make the container accept configs WeChat rejects.
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":"10000"}}}"#))
    }

    func test_networkTimeout_booleanIsNotConfigured() throws {
        // JSON `true` bridges to an NSNumber whose doubleValue is 1.0, so a plain NSNumber cast
        // would let it through as a 1 ms timeout. The CFBoolean type check is what stops it, and
        // it is the piece most likely to be dropped as redundant-looking.
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":true}}}"#))
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":false}}}"#))
    }

    func test_networkTimeout_fractionalValueIsFlooredNotRounded() throws {
        XCTAssertEqual(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":10000.7}}}"#), 10000)
    }

    func test_networkTimeout_valueAboveInt32MaxIsNotConfigured() throws {
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":1e100}}}"#))
        XCTAssertNil(try timeout(fromAppJson: #"{"app":{"networkTimeout":{"connectSocket":2147483648}}}"#))
    }

    func test_networkTimeout_nonFiniteValueIsNotConfigured() {
        // JSON cannot express infinity, so this shape only arrives through the dictionary
        // initializer; the isFinite guard is unreachable from `fromJsonString` and would otherwise
        // never be exercised.
        let config = DMPBundleAppConfig(data: ["app": ["networkTimeout": ["connectSocket": Double.infinity]]])
        XCTAssertNil(config.networkTimeoutConnectSocketMs)

        let notANumber = DMPBundleAppConfig(data: ["app": ["networkTimeout": ["connectSocket": Double.nan]]])
        XCTAssertNil(notANumber.networkTimeoutConnectSocketMs)
    }
}

// MARK: - loadResource is gated on app.json being parsed

/// `DMPContainer.createResourceMessage` bails out to an empty `DMPMap` when
/// `app.getBundleAppConfig()` is nil, and that empty message is the structural reason app.json is
/// always available before any mini-program JS runs: with no `loadResource` message there is no
/// page bundle evaluation, hence no `onLaunch`, hence no way for a mini program to call
/// `connectSocket` (or anything else that reads app.json) before the config exists. Softening this
/// guard into a degraded fallback — a message with a guessed `root`, say — would reopen exactly
/// that window and make every "config is ready by then" assumption in the container unfounded.
final class DMPContainerLoadResourceConfigGateTests: XCTestCase {

    func test_freshApp_hasNoBundleAppConfigUntilTheBundleIsLoaded() {
        let app = DMPApp(appConfig: DMPAppConfig(appName: "gate", appId: "gateApp"), appIndex: 0)
        XCTAssertNil(app.getBundleAppConfig(),
                     "app.json is parsed by loadBundle; before that the container has no config to build a message from")
    }

    func test_loadResourceService_withoutBundleAppConfig_deliversAnEmptyMessage() async {
        let app = DMPApp(appConfig: DMPAppConfig(appName: "gate", appId: "gateApp"), appIndex: 0)
        let service = DMPService(app: app)
        defer { service.destroy() }
        app.service = service

        await service.evaluateScript("""
        globalThis.__diminaTestReceived = [];
        DiminaServiceBridge.onMessage = function (message) {
            globalThis.__diminaTestReceived.push(message);
        };
        """)

        // Prove the recorder actually sees what the container delivers, so the empty-message
        // assertion below cannot pass just because nothing was wired up.
        await service.fromContainerMessage(
            data: DMPMap(["type": "loadResource", "body": ["pagePath": "pages/index/index"]]))
        let probe = await service.evaluateScript(
            "JSON.stringify(globalThis.__diminaTestReceived.map(function (m) { return m.type; }))")
        XCTAssertEqual(probe?.toString(), "[\"loadResource\"]",
                       "the recorder must observe a real loadResource message before it can be trusted to observe its absence")

        await service.evaluateScript("globalThis.__diminaTestReceived = [];")
        XCTAssertNil(app.getBundleAppConfig(), "precondition: this app never loaded its bundle")

        let container = DMPContainer(app: app)
        await container.loadResourceService(webViewId: 7, pagePath: "pages/index/index")

        let recorded = await service.evaluateScript("JSON.stringify(globalThis.__diminaTestReceived)")
        XCTAssertEqual(recorded?.toString(), "[{}]",
                       "with no app.json parsed yet the message must stay empty: no type, no pagePath, no root — nothing the service could act on")
    }
}

// MARK: - Repeated response headers are folded before dimina sees them

/// The open payload's `header` must present repeated response headers as one comma-separated
/// value (RFC 7230 3.2.2). On this platform the HTTP parser does that itself: by the time a
/// response reaches `HTTPURLResponse.allHeaderFields` the duplicates are already one entry, so
/// `DMPURLSessionWebSocketTransport.handleOpen` only stringifies what it is handed and cannot
/// lose a value. That makes the folding a platform guarantee dimina leans on rather than
/// something it implements — this test pins the guarantee, so if it ever stops holding the
/// failure surfaces here instead of as silently dropped headers in a mini program.
final class DMPWebSocketResponseHeaderFoldingTests: XCTestCase {

    private func parsedHeaderFields(fromRawResponse raw: String) -> [String: String] {
        let message = CFHTTPMessageCreateEmpty(kCFAllocatorDefault, false).takeRetainedValue()
        let bytes = Array(raw.utf8)
        CFHTTPMessageAppendBytes(message, bytes, bytes.count)
        return CFHTTPMessageCopyAllHeaderFields(message)?.takeRetainedValue() as? [String: String] ?? [:]
    }

    func test_repeatedResponseHeadersArriveCommaJoined() throws {
        let raw = "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\n"
            + "Set-Cookie: a=1\r\n"
            + "Set-Cookie: b=2\r\n"
            + "\r\n"
        let fields = parsedHeaderFields(fromRawResponse: raw)

        XCTAssertEqual(fields.count, 2, "the two Set-Cookie lines must arrive as a single entry")
        XCTAssertEqual(fields["Set-Cookie"], "a=1, b=2")
    }

    func test_repeatedResponseHeadersAreFoldedCaseInsensitively() throws {
        // Field names are case-insensitive, so these three lines are one header with three values.
        // Were they to arrive as separate entries, the open payload would carry the same header
        // several times under different spellings.
        let raw = "HTTP/1.1 101 Switching Protocols\r\n"
            + "X-A: 1\r\n"
            + "X-A: 2\r\n"
            + "x-a: 3\r\n"
            + "\r\n"
        let fields = parsedHeaderFields(fromRawResponse: raw)

        XCTAssertEqual(fields.count, 1)
        let value = try XCTUnwrap(fields.first?.value)
        XCTAssertEqual(value, "1, 2, 3")
    }
}
