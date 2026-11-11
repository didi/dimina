//
//  DMPStorage.swift
//  dimina
//
//  Created by Lehem on 2025/5/13.
//

import Foundation
import CoreFoundation
import MMKV

/**
 * Wrapper utility class for MMKV
 * Provides thread-safe storage capabilities
 * Supports all functionalities required by Mini Program Storage API
 */
public class DMPStorage {
    private static let managerQueue = DispatchQueue(label: "com.dimina.mmkv.manager")
    private static var instances: [String: DMPStorage] = [:]

    /// Legacy default namespace. Runtime APIs use `storage(for:)` so data is
    /// never shared between mini-programs.
    public static var shared: DMPStorage {
        storage(for: "default")
    }

    public static func storage(for appId: String) -> DMPStorage {
        let namespace = appId.isEmpty ? "default" : appId
        return managerQueue.sync {
            if let instance = instances[namespace] {
                return instance
            }
            let instance = DMPStorage(appId: namespace)
            instances[namespace] = instance
            return instance
        }
    }
    
    // Queue for synchronizing cross-thread access
    private let queue = DispatchQueue(label: "com.dimina.mmkv.queue", attributes: .concurrent)
    
    // MMKV instance
    private var mmkv: MMKV?
    
    // Encrypted MMKV instance
    private var encryptedMMKV: MMKV?
    
    private let appId: String

    private init(appId: String) {
        self.appId = appId
        MMKV.initialize(rootDir: nil)
        mmkv = MMKV(mmapID: "com.dimina.storage.\(appId)")

        let cryptKey = "DiminaEncryptKey"
        if let cryptKeyData = cryptKey.data(using: .utf8) {
            encryptedMMKV = MMKV(
                mmapID: "com.dimina.storage.encrypted.\(appId)",
                cryptKey: cryptKeyData
            )
        }
        DMPLogger.debug("DMPStorage: Initialization successful for \(appId)")
    }

    @available(*, deprecated, message: "Use DMPStorage.storage(for:) to select an app namespace")
    public func initialize(appId: String? = nil) {
        // Instances returned by `storage(for:)` are initialized atomically.
    }

    // Module initialization, should be called during app startup
    public static func setupModule(appId: String? = nil) {
        _ = storage(for: appId ?? "default")
    }

    // Destroy only the namespace owned by the closing mini-program.
    public static func teardownModule(appId: String? = nil) {
        let namespace = appId ?? "default"
        let instance = managerQueue.sync { instances.removeValue(forKey: namespace) }
        instance?.destroy()
    }
    
    // Get MMKV instance
    public func getInstance(encrypted: Bool = false) -> MMKV? {
        return encrypted ? encryptedMMKV : mmkv
    }
    
    static let storageLimitKB = 10 * 1024

    // New writes keep the JS-produced typed string and its exact UTF-16 entry length.
    // MMKV's allocated bytes and our own record metadata are not part of the quota.
    static func storageWireEntry(key: String, value: Any) -> [String: Any] {
        let type: String
        let data: String
        if value is NSNull {
            type = "Null"; data = "null"
        } else if let string = value as? String {
            type = "String"; data = string
        } else if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                type = "Boolean"; data = number.boolValue ? "true" : "false"
            } else {
                type = "Number"; data = storageNumberString(number.doubleValue)
            }
        } else if let date = value as? Date {
            type = "Date"; data = storageNumberString(date.timeIntervalSince1970 * 1000)
        } else if value is [Any] || value is [String: Any] {
            type = value is [Any] ? "Array" : "Object"
            let encoded = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes])
            data = encoded.flatMap { String(data: $0, encoding: .utf8) } ?? "null"
        } else {
            type = "Unknown"; data = ""
        }
        let entryLength = storageQuotedLength(key) + 1
            + 21 + storageQuotedLength(data) + storageQuotedLength(type)
        return ["data": data, "dataType": type, "entrySize": entryLength]
    }

    private static func storageNumberString(_ number: Double) -> String {
        if number.isNaN { return "NaN" }
        if number == .infinity { return "Infinity" }
        if number == -.infinity { return "-Infinity" }
        if number == 0 { return "0" }
        // JSONSerialization uses the same shortest round-trip number representation.
        let encoded = (try? JSONSerialization.data(withJSONObject: number, options: [.fragmentsAllowed]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? String(number)
        let parts = encoded.lowercased().split(separator: "e").map(String.init)
        let mantissa = parts[0].hasSuffix(".0") ? String(parts[0].dropLast(2)) : parts[0]
        guard parts.count == 2, let exponent = Int(parts[1]) else { return mantissa }
        if abs(number) >= 0.000001 && abs(number) < 1e21 {
            return NSDecimalNumber(string: encoded).stringValue
        }
        return mantissa + "e" + (exponent >= 0 ? "+" : "") + String(exponent)
    }

    private static func storageQuotedLength(_ value: String) -> Int {
        // JSON.stringify quotes strings without escaping '/' or non-ASCII characters.
        value.utf16.reduce(2) { count, unit in
            if unit == 34 || unit == 92 || [8, 9, 10, 12, 13].contains(unit) { return count + 2 }
            return count + (unit < 32 ? 6 : 1)
        }
    }

    private static func decodedWireValue(_ wire: [String: Any]) -> Any {
        let data = wire["data"] as? String ?? ""
        switch wire["dataType"] as? String {
        case "String": return data
        case "Number": return Double(data) ?? Double.nan
        case "Boolean": return data == "true"
        case "Null", "Undefined": return NSNull()
        case "Date": return Date(timeIntervalSince1970: (Double(data) ?? .nan) / 1000)
        case "Array", "Object":
            return data.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? NSNull()
        default: return ""
        }
    }

    private func record(in storage: MMKV, key: String) -> [String: Any]? {
        guard let data = storage.data(forKey: key) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func value(in record: [String: Any]) -> Any? {
        if let wire = record["storageWire"] as? [String: Any] { return Self.decodedWireValue(wire) }
        return record["dmpvalue"]
    }

    private func entries(encrypted: Bool? = nil) -> [(key: String, size: Int)] {
        let stores: [MMKV?] = encrypted.map { [$0 ? encryptedMMKV : mmkv] } ?? [mmkv, encryptedMMKV]
        return stores.compactMap { $0 }.flatMap { storage in
            (storage.allKeys() as? [String] ?? []).compactMap { key in
                guard let stored = record(in: storage, key: key), let value = value(in: stored) else { return nil }
                let wire = stored["storageWire"] as? [String: Any] ?? Self.storageWireEntry(key: key, value: value)
                return (key: key, size: (wire["entrySize"] as? NSNumber)?.intValue ?? 0)
            }
        }
    }

    private static func spaceSize(_ sizes: [Int]) -> Int {
        2 + sizes.reduce(0, +) + max(0, sizes.count - 1)
    }

    /// Returns an error message without modifying the previous value on failure.
    func write(key: String, value: Any, encrypted: Bool = false, wire suppliedWire: [String: Any]? = nil) -> String? {
        queue.sync(flags: .barrier) {
            guard !key.isEmpty else { return "key is empty" }
            guard let storage = getInstance(encrypted: encrypted) else { return "storage unavailable" }
            var wire = suppliedWire ?? Self.storageWireEntry(key: key, value: value)
            guard let dataString = wire["data"] as? String,
                  let dataType = wire["dataType"] as? String else { return "invalid storage record" }
            let size = Self.storageQuotedLength(key) + 1 + 21
                + Self.storageQuotedLength(dataString) + Self.storageQuotedLength(dataType)
            wire["entrySize"] = size
            let sameNamespace = entries(encrypted: encrypted).filter { $0.key != key }.map(\.size)
            let otherNamespace = entries(encrypted: !encrypted).map(\.size)
            let total = Self.spaceSize(sameNamespace + otherNamespace + [size]) + 6
            guard total <= Self.storageLimitKB * 1024 else { return "exceed storage max size 10Mb" }
            let stored: [String: Any] = ["dmpvalue": "", "type": "Wire", "storageWire": wire]
            do {
                let encoded = try JSONSerialization.data(withJSONObject: stored, options: [.withoutEscapingSlashes])
                return storage.set(encoded, forKey: key) ? nil : "write failed"
            } catch {
                return "invalid storage data"
            }
        }
    }

    public func set(key: String, value: Any, encrypted: Bool = false) -> Bool {
        write(key: key, value: value, encrypted: encrypted) == nil
    }

    func bridgeValue(key: String, encrypted: Bool = false, wireRequested: Bool) -> Any? {
        queue.sync {
            guard let storage = getInstance(encrypted: encrypted),
                  let stored = record(in: storage, key: key), let value = value(in: stored) else { return nil }
            guard wireRequested else { return value }
            if let wire = stored["storageWire"] as? [String: Any] {
                return ["__diminaStorageResult": 1, "record": wire]
            }
            return ["__diminaStorageResult": 1, "value": value]
        }
    }

    public func get(key: String, encrypted: Bool = false) -> Any? {
        bridgeValue(key: key, encrypted: encrypted, wireRequested: false)
    }

    // Delete key
    public func remove(key: String, encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            getInstance(encrypted: encrypted)?.removeValue(forKey: key)
        }
    }
    
    // Delete multiple keys
    public func removeMultiple(keys: [String], encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            getInstance(encrypted: encrypted)?.removeValues(forKeys: keys)
        }
    }
    
    // Clear all data
    public func clearAll(encrypted: Bool = false) {
        queue.sync(flags: .barrier) {
            if encrypted {
                encryptedMMKV?.clearAll()
            } else {
                mmkv?.clearAll()
            }
        }
    }
    
    // Clear all data (including encrypted and non-encrypted)
    public func clearAllStorage() {
        queue.sync(flags: .barrier) {
            mmkv?.clearAll()
            encryptedMMKV?.clearAll()
        }
    }
    
    // Check if key exists
    public func contains(key: String, encrypted: Bool = false) -> Bool {
        var result = false
        queue.sync {
            result = getInstance(encrypted: encrypted)?.contains(key: key) ?? false
        }
        return result
    }
    
    // Get all keys
    public func getAllKeys(encrypted: Bool = false) -> [String] {
        var result: [String] = []
        queue.sync {
            // Use type conversion to ensure return type is [String]
            if let keys = getInstance(encrypted: encrypted)?.allKeys() as? [String] {
                result = keys
            }
        }
        return result
    }
    
    public func getStorageInfo(encrypted: Bool = false) -> (keys: [String], currentSize: Int, limitSize: Int) {
        queue.sync {
            let stored = entries(encrypted: encrypted)
            return (stored.map(\.key), (Self.spaceSize(stored.map(\.size)) + 1023) / 1024, Self.storageLimitKB)
        }
    }

    public func getAllStorageInfo() -> (keys: [String], currentSize: Int, limitSize: Int) {
        queue.sync {
            let stored = entries()
            return (Array(Set(stored.map(\.key))), (Self.spaceSize(stored.map(\.size)) + 1023) / 1024, Self.storageLimitKB)
        }
    }

    /// Debug-only callers receive decoded MMKV values from this app's two namespaces.
    func debugSnapshot() -> [[String: Any]] {
        let namespaces: [(Bool, [String])] = queue.sync {
            [(false, mmkv?.allKeys() as? [String] ?? []),
             (true, encryptedMMKV?.allKeys() as? [String] ?? [])]
        }
        return namespaces.flatMap { encrypted, keys in
            keys.sorted().compactMap { key in
                guard let value = get(key: key, encrypted: encrypted) else { return nil }
                return ["key": key, "data": value, "encrypted": encrypted]
            }
        }
    }

    // Destroy instances
    public func destroy() {
        queue.sync(flags: .barrier) {
            mmkv = nil
            encryptedMMKV = nil
            DMPLogger.debug("DMPStorage: Destroyed \(appId)")
        }
    }
}
