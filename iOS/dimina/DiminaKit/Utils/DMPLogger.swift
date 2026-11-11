import Foundation

/// SDK diagnostics are compiled out of release builds. In particular, bridge
/// payloads and WebView console messages must never reach production logs.
public enum DMPLogger {
    public static func debug(
        _ items: Any...,
        separator: String = " ",
        terminator: String = "\n"
    ) {
        #if DEBUG
        let message = items.map { String(describing: $0) }.joined(separator: separator)
        // Large scripts and Canvas capability payloads can block stdout while
        // holding its process-wide lock, starving main-thread bridge replies.
        let byteCount = message.utf8.count
        let limit = 4 * 1024
        if byteCount > limit {
            let prefix = String(decoding: message.utf8.prefix(limit), as: UTF8.self)
            Swift.print("\(prefix)… [truncated; \(byteCount) bytes total]", terminator: terminator)
        } else {
            Swift.print(message, terminator: terminator)
        }
        #endif
    }
}
