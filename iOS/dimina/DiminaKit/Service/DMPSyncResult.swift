import Foundation

public class DMPAPIResult: NSObject {}

/// Explicit sync result, aligned with Android's SyncResult semantics.
/// The wrapped value is converted to a JSValue and returned to JS directly.
public class DMPSyncResult: DMPAPIResult {
    public let value: Any?

    public init(_ value: Any?) {
        self.value = value
    }
}

/// Explicit async result marker, aligned with Android's AsyncResult semantics.
/// The actual payload should be delivered through success/fail/complete callbacks.
public class DMPAsyncResult: DMPAPIResult {
    public let value: DMPMap?

    public init(_ value: DMPMap? = nil) {
        self.value = value
    }
}

/// Explicit no-result marker, aligned with Android's NoneResult semantics.
public class DMPNoneResult: DMPAPIResult {}
