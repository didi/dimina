//
//  DMPWebSocketValidation.swift
//  dimina
//
//  Native wx.connectSocket / SocketTask support.
//  Pure, side-effect-free validation helpers mirroring dimina-kit's
//  `normalize.ts`. Kept dependency-free (no UIKit/Foundation networking
//  types beyond Foundation itself) so it is directly unit-testable.
//
//  Validation order and error strings must reproduce dimina-kit's verbatim.

import Foundation

/// Namespace for the WebSocket parameter validation rules shared by
/// connectSocket / sendSocketMessage / closeSocket. Every function returns
/// the *tail* of the eventual `"<api>:fail <tail>"` error message (e.g.
/// `"invalid url"`), never the full string — callers prepend the api name.
enum DMPWebSocketValidation {

    // MARK: - Error tails (verbatim strings, must match dimina-kit)

    enum ErrorTail {
        static let invalidSocketId = "invalid socketId"
        /// Carries the word `fail` twice on purpose. The script layer builds
        /// `"\(api):fail \(errMsg)"` while the errMsg for the connection cap already starts
        /// with `fail `, so a mini program sees
        /// `connectSocket:fail fail reach max websocket connect count 5`. That doubled word is
        /// part of the string WeChat emits, not a typo to correct.
        static let reachMaxCount = "fail reach max websocket connect count 5"
        static let invalidUrl = "invalid url"
        static let invalidTimeout = "invalid timeout"
        static let protocolsNotArray = "protocols must be an array"
        static let invalidProtocol = "invalid protocol"
        static let headerNotObject = "header must be an object"
        static let invalidHeader = "invalid header"
        static let interrupted = "interrupted"
        /// The one string every timed-out connect attempt reports, whichever clock noticed first —
        /// the container's own connect watchdog or the transport's. A second, near-synonymous
        /// constant is how the two paths drifted apart before; one constant is what keeps them
        /// together.
        static let timeout = "timeout"
        static let connectionFailed = "WebSocket connection failed"
        static let notConnected = "WebSocket is not connected"
        static let dataMustBeStringOrBuffer = "data must be string or ArrayBuffer"
        static let invalidCode = "invalid code"
        static let reasonMustBeString = "reason must be a string"
        static let reasonTooLong = "reason must not exceed 123 UTF-8 bytes"
    }

    static let defaultTimeoutMs = 60000
    static let defaultCloseCode = 1000

    /// Header names the caller may not set (case-insensitive). These are
    /// silently dropped from the caller-supplied header, they do not block
    /// native itself from setting e.g. Sec-WebSocket-Protocol.
    static let forbiddenHeaderNames: Set<String> = [
        "connection", "content-length", "host", "referer",
        "sec-websocket-accept", "sec-websocket-extensions", "sec-websocket-key",
        "sec-websocket-protocol", "sec-websocket-version", "upgrade",
    ]

    enum Result<T> {
        case success(T)
        case failure(String)

        var value: T? {
            if case let .success(v) = self { return v }
            return nil
        }

        var errorTail: String? {
            if case let .failure(m) = self { return m }
            return nil
        }
    }

    // MARK: - url

    /// scheme must be wss, must parse, must carry no fragment, and must not hold a character a
    /// url may only carry percent-encoded.
    static func validateUrl(_ raw: Any?) -> Result<URL> {
        guard let str = raw as? String, !str.isEmpty,
              !containsIllegalURLCharacter(str),
              let components = URLComponents(string: str),
              let scheme = components.scheme?.lowercased(),
              scheme == "wss",
              components.fragment == nil,
              let url = components.url,
              url.host != nil
        else {
            return .failure(ErrorTail.invalidUrl)
        }
        return .success(url)
    }

    /// Characters a url may never carry literally: RFC 3986's excluded set, minus the two that
    /// carry meaning here. `[` and `]` stay legal because an IPv6 literal host needs them, and `%`
    /// is checked separately below since it must introduce an escape rather than stand alone.
    private static let urlExcludedScalars = Set<Unicode.Scalar>(" \"<>{}|\\^`".unicodeScalars)

    /// True if `s` holds a character that may only appear percent-encoded.
    ///
    /// `URLComponents` accepts several of them and quietly percent-encodes them on the way out, so
    /// without this check the container would dial a url the caller never wrote — a bare space in
    /// `wss://host/a b` silently becomes `%20` and the mini program gets a live connection to a
    /// different resource with nothing reporting the rewrite. Android's `java.net.URI` refuses this
    /// same character class outright; rejecting here keeps the platforms answering alike, and the
    /// caller keeps the legitimate way to express the character by encoding it themselves.
    private static func containsIllegalURLCharacter(_ s: String) -> Bool {
        let scalars = Array(s.unicodeScalars)
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar.value < 0x20 || scalar.value == 0x7F { return true }
            if urlExcludedScalars.contains(scalar) { return true }
            if scalar == "%" {
                guard index + 2 < scalars.count,
                      isHexDigit(scalars[index + 1]), isHexDigit(scalars[index + 2])
                else {
                    return true
                }
                index += 3
                continue
            }
            index += 1
        }
        return false
    }

    private static func isHexDigit(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "0"..."9", "a"..."f", "A"..."F": return true
        default: return false
        }
    }

    // MARK: - timeout

    /// Missing -> the caller's default. Non-finite or > 0x7fffffff -> error. Below 1 ms -> silent
    /// fallback to that same default. Otherwise floored to an integer, matching
    /// `dimina-kit`'s `normalize.ts` (`Math.floor`), not rounded.
    ///
    /// `appDefaultMs` is this mini program's `app.json` `networkTimeout.connectSocket`; `nil`
    /// means the key is absent and 60000 applies. A `timeout` supplied at the call site outranks
    /// both. A `timeout` that cannot express a deadline counts as unspecified rather than as
    /// "never time out": otherwise a mistyped parameter would silently turn into an unbounded
    /// connect attempt.
    static func validateTimeout(_ raw: Any?, appDefaultMs: Int? = nil) -> Result<Int> {
        let fallbackMs = (appDefaultMs.flatMap { $0 > 0 && $0 <= 0x7fffffff ? $0 : nil }) ?? defaultTimeoutMs
        guard let raw = raw, !(raw is NSNull) else {
            return .success(fallbackMs)
        }
        guard let boxed = raw as? NSNumber, CFGetTypeID(boxed) != CFBooleanGetTypeID() else {
            return .failure(ErrorTail.invalidTimeout)
        }
        let number = boxed.doubleValue
        if !number.isFinite {
            return .failure(ErrorTail.invalidTimeout)
        }
        if number > Double(0x7fffffff) {
            return .failure(ErrorTail.invalidTimeout)
        }
        // Below 1 ms there is nothing left after flooring, and 0 is not "no deadline" — it is a
        // deadline that already passed, so the attempt would fail before the handshake could
        // possibly finish. A value smaller than the unit it is expressed in carries no usable
        // intent, so it counts as unspecified. 1 ms itself is expressible and is honoured verbatim.
        if number < 1 {
            return .success(fallbackMs)
        }
        return .success(Int(number.rounded(.down)))
    }

    // MARK: - protocols

    /// Missing -> []. Non-array -> error. Any empty-string / non-string item
    /// -> error.
    static func validateProtocols(_ raw: Any?) -> Result<[String]> {
        guard let raw = raw, !(raw is NSNull) else {
            return .success([])
        }
        guard let array = raw as? [Any] else {
            return .failure(ErrorTail.protocolsNotArray)
        }
        var result: [String] = []
        result.reserveCapacity(array.count)
        for item in array {
            guard let s = item as? String, !s.isEmpty else {
                return .failure(ErrorTail.invalidProtocol)
            }
            result.append(s)
        }
        return .success(result)
    }

    // MARK: - header

    /// Missing -> {}. Non-object -> error. Per-entry: trimmed-empty name or
    /// forbidden name -> silently dropped (not an error). Name or value
    /// containing CR/LF -> hard error (header injection guard). Null/undefined
    /// value -> dropped. Everything else stringified and kept.
    static func validateHeader(_ raw: Any?) -> Result<[String: String]> {
        var header: [String: String] = [:]

        if let raw = raw, !(raw is NSNull) {
            guard let dict = raw as? [String: Any] else {
                return .failure(ErrorTail.headerNotObject)
            }
            for (rawName, rawValue) in dict {
                // CRLF must be checked before any of the `continue`s below. Otherwise
                // "Host\r\n" gets silently dropped for being a forbidden name once trimmed,
                // and "X-Test\r\n" paired with a null value gets dropped too - the injected
                // newline goes unreported. HarmonyOS checks it first; all three must agree.
                if containsCRLF(rawName) {
                    return .failure(ErrorTail.invalidHeader)
                }
                let trimmedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmedName.isEmpty || forbiddenHeaderNames.contains(trimmedName.lowercased()) {
                    continue
                }
                // A CRLF check alone lets "Bad:Name" through. Reject anything that is not an
                // RFC token here so all three platforms accept the same set of header names.
                if !isHTTPTokenName(trimmedName) {
                    return .failure(ErrorTail.invalidHeader)
                }
                if rawValue is NSNull {
                    continue
                }
                let stringValue = jsStringValue(rawValue)
                if containsCRLF(stringValue) || containsForbiddenValueChar(stringValue) {
                    return .failure(ErrorTail.invalidHeader)
                }
                header[trimmedName] = stringValue
            }
        }

        return .success(header)
    }

    /// The container-supplied `Referer`. WeChat fixes this header and forbids the caller from
    /// setting it (`https://servicewechat.com/{appid}/{version}/page-frame.html`); dimina uses its
    /// own domain, matching what the `request` path already emits (see HarmonyOS
    /// `DMPHttpParamsNext.addCommonHeaderParams`). A caller-supplied `referer` never reaches here -
    /// it is in `forbiddenHeaderNames` and gets dropped during header validation.
    ///
    /// `appVersion` is the mini-app's `versionCode`; `0` when unknown, which is also what WeChat
    /// documents for its dev/trial/review builds.
    static func refererValue(appId: String, appVersion: String) -> String {
        let version = appVersion.isEmpty ? "0" : appVersion
        return "https://servicedimina.com/\(appId)/\(version)/page-frame.html"
    }

    /// RFC 7230 `token` - the only shape an HTTP field name may take.
    private static let httpTokenScalars = Set<Unicode.Scalar>(
        "!#$%&'*+-.^_`|~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".unicodeScalars
    )

    private static func isHTTPTokenName(_ s: String) -> Bool {
        return !s.isEmpty && s.unicodeScalars.allSatisfy { httpTokenScalars.contains($0) }
    }

    /// True if `s` holds a character an HTTP field value may not carry. A value may hold horizontal
    /// tab and printable US-ASCII (0x20–0x7E) and nothing else: control characters are illegal, and
    /// RFC 7230 deprecated obs-text (>= 0x80), which OkHttp enforces by refusing the byte outright.
    /// Accepting a Chinese header value here while Android refuses it would mean one platform
    /// connects and another does not for identical mini-program code, so the byte range is the
    /// narrower of the two. CR and LF land in this range too and are also caught by `containsCRLF`;
    /// both report the same error.
    ///
    /// This rule governs header values only. A url is bound by percent-encoding and IDN rules
    /// instead, so non-ASCII paths and internationalised hosts stay valid there.
    private static func containsForbiddenValueChar(_ s: String) -> Bool {
        return s.unicodeScalars.contains { $0 != "\t" && ($0.value < 0x20 || $0.value > 0x7E) }
    }

    private static func containsCRLF(_ s: String) -> Bool {
        // NOTE: deliberately scans unicodeScalars, not `String.contains`:
        // Swift merges "\r\n" into a single extended grapheme cluster, which
        // makes Character-based `contains("\n")` silently fail to match a
        // lone "\n" search term against text containing "\r\n".
        return s.unicodeScalars.contains { $0 == "\r" || $0 == "\n" }
    }

    // MARK: - closeSocket code

    /// Missing / NSNull -> 1000. Only host numbers are accepted. The value must be a finite integer that is either 1000 or
    /// within [3000, 4999], otherwise -> error.
    static func validateCloseCode(_ raw: Any?) -> Result<Int> {
        guard let raw = raw, !(raw is NSNull) else {
            return .success(defaultCloseCode)
        }

        guard let boxed = raw as? NSNumber, CFGetTypeID(boxed) != CFBooleanGetTypeID() else {
            return .failure(ErrorTail.invalidCode)
        }
        let number = boxed.doubleValue

        guard number.isFinite, number == number.rounded() else {
            return .failure(ErrorTail.invalidCode)
        }
        guard number >= Double(Int32.min), number <= Double(Int32.max) else {
            return .failure(ErrorTail.invalidCode)
        }
        let code = Int(number)
        if code == 1000 || (code >= 3000 && code <= 4999) {
            return .success(code)
        }
        return .failure(ErrorTail.invalidCode)
    }

    // MARK: - closeSocket reason

    /// Missing -> "". Present but not a string -> error. UTF-8 length > 123
    /// bytes -> error.
    static func validateCloseReason(_ raw: Any?) -> Result<String> {
        guard let raw = raw, !(raw is NSNull) else {
            return .success("")
        }
        guard let s = raw as? String else {
            return .failure(ErrorTail.reasonMustBeString)
        }
        if s.utf8.count > 123 {
            return .failure(ErrorTail.reasonTooLong)
        }
        return .success(s)
    }

    /// Best-effort `String(x)` stringification for header values.
    static func jsStringValue(_ raw: Any) -> String {
        switch raw {
        case let s as String:
            return s
        case let n as NSNumber:
            return n.stringValue
        case let b as Bool:
            return b ? "true" : "false"
        default:
            return "\(raw)"
        }
    }

    /// Task-vs-legacy-mode routing is a *key presence* test
    /// (`params.has("socketId")`), not a truthiness test — `{socketId: ""}`
    /// or `{socketId: null}` must still route as task mode (and then fail
    /// "not connected" against that bogus id), not silently fall back to the
    /// legacy-bound socket. `DMPMap.get` already distinguishes a missing key
    /// (nil) from a present-but-null value (NSNull), so presence alone is
    /// the key check.
    static func hasSocketId(_ params: DMPMap) -> Bool {
        return params.get("socketId") != nil
    }
}
