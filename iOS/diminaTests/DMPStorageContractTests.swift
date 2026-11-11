import Foundation
import Testing
@testable import dimina

@Suite(.serialized)
@MainActor
struct DMPStorageContractTests {
    private func withStorage(_ body: (DMPStorage) throws -> Void) rethrows {
        let appId = "storage-contract-\(UUID().uuidString)"
        let storage = DMPStorage.storage(for: appId)
        defer {
            storage.clearAllStorage()
            DMPStorage.teardownModule(appId: appId)
        }
        try body(storage)
    }

    @Test func logicalSizeUsesTypedJSONAndUTF16() throws {
        try withStorage { storage in
            let key = "键😀"
            let data = String(repeating: "你😀\"\\\n", count: 100)
            #expect(storage.set(key: key, value: data))
            let expected = try JSONSerialization.data(withJSONObject: [key: ["data": data, "dataType": "String"]], options: [.withoutEscapingSlashes])
            let length = try #require(String(data: expected, encoding: .utf8)).utf16.count
            let info = storage.getAllStorageInfo()
            #expect(info.keys == [key])
            #expect(info.currentSize == (length + 1023) / 1024)
            #expect(info.limitSize == 10240)
        }
    }

    @Test func failedReplacementIsAtomicAndCannotForgeItsEntrySize() throws {
        try withStorage { storage in
            #expect(storage.set(key: "saved", value: "original"))
            let data = String(repeating: "x", count: 10 * 1024 * 1024)
            let wire: [String: Any] = ["data": data, "dataType": "String", "entrySize": 0]
            #expect(storage.write(key: "saved", value: data, wire: wire) == "exceed storage max size 10Mb")
            #expect(storage.get(key: "saved") as? String == "original")
        }
    }

    @Test func replacementAndDeletionReleaseLogicalQuota() throws {
        try withStorage { storage in
            let value = String(repeating: "x", count: 6 * 1024 * 1024)
            #expect(storage.set(key: "large", value: value))
            #expect(storage.set(key: "large", value: value))
            #expect(!storage.set(key: "another", value: value))
            storage.remove(key: "large")
            #expect(storage.set(key: "another", value: value))
            storage.clearAllStorage()
            #expect(storage.getAllStorageInfo().keys.isEmpty)
            #expect(storage.getAllStorageInfo().currentSize == 1)
        }
    }

    @Test func legacyValuesExcludeMMKVAndFrameworkMetadata() throws {
        try withStorage { storage in
            let legacy = try JSONSerialization.data(withJSONObject: ["type": "String", "dmpvalue": "你好😀"])
            #expect(storage.getInstance()?.set(legacy, forKey: "legacy") == true)
            #expect(storage.get(key: "legacy") as? String == "你好😀")
            #expect(storage.getAllStorageInfo().currentSize == 1)
            let result = try #require(storage.bridgeValue(key: "legacy", wireRequested: true) as? [String: Any])
            #expect(result["__diminaStorageResult"] as? Int == 1)
            #expect(result["value"] as? String == "你好😀")
        }
    }

    @Test func syncMutationsAreVoidAndQuotaFailureThrowsThroughTheBridge() throws {
        _ = StorageAPI()
        let appId = "storage-sync-api-\(UUID().uuidString)"
        defer { DMPStorage.storage(for: appId).clearAllStorage(); DMPStorage.teardownModule(appId: appId) }
        let env = DMPBridgeEnv(appIndex: -1, appId: appId, webViewId: -1)
        let set = try #require(DMPContainerApi.getHandler(for: "setStorageSync"))
        let remove = try #require(DMPContainerApi.getHandler(for: "removeStorageSync"))
        let clear = try #require(DMPContainerApi.getHandler(for: "clearStorageSync"))
        #expect(set(DMPBridgeParam(value: ["key", "value"]), env, nil) is DMPNoneResult)
        #expect(remove(DMPBridgeParam(value: "key"), env, nil) is DMPNoneResult)
        #expect(clear(DMPBridgeParam(value: [:]), env, nil) is DMPNoneResult)
        let failure = try #require(set(DMPBridgeParam(value: ["key", String(repeating: "x", count: 10 * 1024 * 1024)]), env, nil) as? DMPErrorResult)
        #expect(failure.message == "setStorageSync:fail exceed storage max size 10Mb")
    }
}
