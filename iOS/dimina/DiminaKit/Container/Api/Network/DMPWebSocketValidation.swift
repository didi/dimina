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
        static let reachMaxCount = "reach max websocket connect count 5"
        static let invalidUrl = "invalid url"
        static let invalidTimeout = "invalid timeout"
        static let protocolsNotArray = "protocols must be an array"
        static let invalidProtocol = "invalid protocol"
        static let headerNotObject = "header must be an object"
        static let invalidHeader = "invalid header"
        static let interrupted = "interrupted"
        static let timedOut = "timed out"
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

    /// scheme must be ws/wss, must parse, must carry no fragment.
    static func validateUrl(_ raw: Any?) -> Result<URL> {
        guard let str = raw as? String, !str.isEmpty,
              let components = URLComponents(string: str),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              components.fragment == nil,
              let url = components.url,
              url.host != nil
        else {
            return .failure(ErrorTail.invalidUrl)
        }
        return .success(url)
    }

    // MARK: - timeout

    /// Missing -> default. Non-finite or > 0x7fffffff -> error. <=0 -> silent
    /// fallback to default. Otherwise floored to an integer, matching
    /// `dimina-kit`'s `normalize.ts` (`Math.floor`), not rounded.
    static func validateTimeout(_ raw: Any?) -> Result<Int> {
        guard let raw = raw, !(raw is NSNull) else {
            return .success(defaultTimeoutMs)
        }
        let number = jsNumberValue(raw)
        if !number.isFinite {
            return .failure(ErrorTail.invalidTimeout)
        }
        if number > Double(0x7fffffff) {
            return .failure(ErrorTail.invalidTimeout)
        }
        if number <= 0 {
            return .success(defaultTimeoutMs)
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

    // MARK: - header (+ origin injection)

    /// Missing -> {}. Non-object -> error. Per-entry: trimmed-empty name or
    /// forbidden name -> silently dropped (not an error). Name or value
    /// containing CR/LF -> hard error (header injection guard). Null/undefined
    /// value -> dropped. Everything else stringified and kept.
    ///
    /// `scheme`/`host`/`port` (already-validated connect URL) are used only to
    /// synthesize the auto-injected `Origin` header when the caller didn't
    /// supply one (case-insensitively).
    static func validateHeader(_ raw: Any?, url: URL) -> Result<[String: String]> {
        var header: [String: String] = [:]

        if let raw = raw, !(raw is NSNull) {
            guard let dict = raw as? [String: Any] else {
                return .failure(ErrorTail.headerNotObject)
            }
            for (rawName, rawValue) in dict {
                let trimmedName = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmedName.isEmpty || forbiddenHeaderNames.contains(trimmedName.lowercased()) {
                    continue
                }
                if containsCRLF(rawName) {
                    return .failure(ErrorTail.invalidHeader)
                }
                if rawValue is NSNull {
                    continue
                }
                let stringValue = jsStringValue(rawValue)
                if containsCRLF(stringValue) {
                    return .failure(ErrorTail.invalidHeader)
                }
                header[trimmedName] = stringValue
            }
        }

        if !header.keys.contains(where: { $0.lowercased() == "origin" }) {
            header["Origin"] = originValue(for: url)
        }

        return .success(header)
    }

    private static func containsCRLF(_ s: String) -> Bool {
        // NOTE: deliberately scans unicodeScalars, not `String.contains`:
        // Swift merges "\r\n" into a single extended grapheme cluster, which
        // makes Character-based `contains("\n")` silently fail to match a
        // lone "\n" search term against text containing "\r\n".
        return s.unicodeScalars.contains { $0 == "\r" || $0 == "\n" }
    }

    /// `ws` -> `http`, `wss` -> `https`; scheme+host[:port] only, no path. An explicitly-present
    /// port equal to the scheme's default (80 for http, 443 for https) is omitted, matching
    /// Android's `URI`-based origin computation and the `dimina-kit` `new URL(...).origin` ground
    /// truth.
    private static func originValue(for url: URL) -> String {
        let scheme = (url.scheme?.lowercased() == "wss") ? "https" : "http"
        guard let host = url.host else { return "" }
        let defaultPort = (scheme == "https") ? 443 : 80
        if let port = url.port, port != defaultPort {
            return "\(scheme)://\(host):\(port)"
        }
        return "\(scheme)://\(host)"
    }

    // MARK: - closeSocket code

    /// Missing -> 1000. Non-integer, or neither exactly 1000 nor within
    /// [3000, 4999] -> error.
    static func validateCloseCode(_ raw: Any?) -> Result<Int> {
        guard let raw = raw, !(raw is NSNull) else {
            return .success(defaultCloseCode)
        }
        let number = jsNumberValue(raw)
        guard number.isFinite, number == number.rounded() else {
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

    // MARK: - JS-ish coercions

    /// Best-effort approximation of JavaScript's `Number(x)` coercion for the
    /// value shapes that can realistically cross the JSON bridge
    /// (NSNumber/Bool/String/NSNull). Non-numeric, non-coercible input
    /// (dictionaries/arrays-with-not-exactly-one-numeric-item) yields NaN,
    /// matching `Number({})` / `Number([1,2])` semantics closely enough for
    /// the contract's purposes.
    static func jsNumberValue(_ raw: Any) -> Double {
        switch raw {
        case is NSNull:
            return 0
        case let b as Bool:
            return b ? 1 : 0
        case let n as NSNumber:
            return n.doubleValue
        case let s as String:
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return 0 }
            return Double(trimmed) ?? Double.nan
        default:
            return Double.nan
        }
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
