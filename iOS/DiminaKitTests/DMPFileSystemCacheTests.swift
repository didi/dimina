import XCTest
@testable import dimina

final class DMPFileSystemCacheTests: XCTestCase {
    func testReadsPackagedWasmAndBrotliWithoutAllowingWritesOrTraversal() throws {
        let appId = "wasm-package-test-\(UUID().uuidString)"
        let env = DMPBridgeEnv(appIndex: 0, appId: appId, webViewId: 0)
        let root = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(appId))
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("main/utils")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let wasm = Data([0, 97, 115, 109, 1, 0, 0, 0])
        let compressed = Data([139, 3, 128, 0, 97, 115, 109, 1, 0, 0, 0, 3])
        try wasm.write(to: directory.appendingPathComponent("module.wasm"))
        try compressed.write(to: directory.appendingPathComponent("module.wasm.br"))
        let api = FileAPI()
        func read(_ method: DMPBridgeMethodHandler, path: String, ok: Bool = true) -> DMPMap {
            var output = DMPMap()
            var outcome: DMPBridgeCallbackType?
            _ = method(DMPBridgeParam(value: ["filePath": path, "compressionAlgorithm": "br"]), env) { result, type in
                if type != .complete { output = result; outcome = type }
            }
            XCTAssertEqual(outcome, ok ? .success : .fail)
            return output
        }
        for path in ["utils/module.wasm", "/utils/module.wasm"] {
            let data = read(api.readFile, path: path).get("data") as? [String: Any]
            XCTAssertEqual(data?["__diminaArrayBufferBase64"] as? String, wasm.base64EncodedString())
        }
        let result = read(api.readCompressedFile, path: "/utils/module.wasm.br").get("data") as? [String: Any]
        XCTAssertEqual(result?["__diminaArrayBufferBase64"] as? String, wasm.base64EncodedString())
        _ = read(api.readFile, path: "../../outside.wasm", ok: false)
        _ = read(api.writeFile, path: "/utils/module.wasm", ok: false)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("module.wasm")), wasm)
    }

    func testTwoMegabyteCacheLifecycle() throws {
        let appId = "file-cache-test-\(UUID().uuidString)"
        let env = DMPBridgeEnv(appIndex: 0, appId: appId, webViewId: 0)
        let api = FileAPI()
        defer {
            try? FileManager.default.removeItem(atPath: DMPSandboxManager.appStoreResourceDirectoryPath(appId: appId))
            try? FileManager.default.removeItem(atPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId))
        }
        func call(_ handler: DMPBridgeMethodHandler, _ params: [String: Any], ok: Bool = true) -> DMPMap {
            var result = DMPMap()
            var outcome: DMPBridgeCallbackType?
            _ = handler(DMPBridgeParam(value: params), env) { value, type in
                if type != .complete { result = value; outcome = type }
            }
            XCTAssertEqual(outcome, ok ? .success : .fail, result.getString(key: "errMsg") ?? "missing callback")
            return result
        }
        let base = "\(DMPFileUtil.virtualFilePrefix)usr/form-cache"
        let file = base + "/form.json"
        _ = call(api.access, ["path": base], ok: false)
        _ = call(api.mkdir, ["dirPath": base, "recursive": true])
        let json = "{\"form\":\"" + String(repeating: "x", count: 2 * 1024 * 1024) + "中文\"}"
        _ = call(api.writeFile, ["filePath": file, "data": json, "encoding": "utf8"])
        XCTAssertEqual(call(api.readFile, ["filePath": file, "encoding": "utf8"]).getString(key: "data"), json)
        _ = call(api.writeFile, ["filePath": file, "data": "{}", "encoding": "utf8"])
        XCTAssertEqual(call(api.readFile, ["filePath": file, "encoding": "utf8"]).getString(key: "data"), "{}")
        _ = call(api.mkdir, ["dirPath": base, "recursive": true], ok: false)
        _ = call(api.copyFile, ["srcPath": file, "destPath": file])
        _ = call(api.copyFile, ["srcPath": base + "/missing", "destPath": file], ok: false)
        XCTAssertEqual(call(api.readFile, ["filePath": file, "encoding": "utf8"]).getString(key: "data"), "{}")
        _ = call(api.copyFile, ["srcPath": file, "destPath": base], ok: false)
        for root in ["\(DMPFileUtil.virtualFilePrefix)usr", "\(DMPFileUtil.virtualFilePrefix)tmp"] {
            _ = call(api.rmdir, ["dirPath": root, "recursive": true], ok: false)
            _ = call(api.rename, ["oldPath": root, "newPath": base + "/moved"], ok: false)
            _ = call(api.rename, ["oldPath": base, "newPath": root], ok: false)
        }
        let fileStat = call(api.stat, ["path": file, "recursive": true]).get("stats") as? [String: Any]
        XCTAssertEqual(fileStat?["size"] as? Int, 2)
        let stats = call(api.stat, ["path": base, "recursive": true]).get("stats") as? [String: Any]
        XCTAssertEqual((stats?[""] as? [String: Any])?["isDirectory"] as? Bool, true)
        XCTAssertEqual(((stats?["/form.json"] as? [String: Any])?["mode"] as? Int ?? 0) & 0o170000, 0o100000)
        _ = call(api.writeFile, ["filePath": base + "/replacement", "data": "new", "encoding": "utf8"])
        _ = call(api.rename, ["oldPath": base + "/replacement", "newPath": file])
        XCTAssertEqual(call(api.readFile, ["filePath": file, "encoding": "utf8"]).getString(key: "data"), "new")
        _ = call(api.copyFile, ["srcPath": file, "destPath": base + "/copy.json"])
        _ = call(api.rename, ["oldPath": base + "/copy.json", "newPath": base + "/renamed.json"])
        XCTAssertEqual((call(api.readdir, ["dirPath": base]).get("files") as? [String])?.count, 2)
        XCTAssertNotNil(call(api.stat, ["path": base, "recursive": true]).get("stats"))
        // Invalid cleanup must leave the cache untouched.
        _ = call(api.rmdir, ["dirPath": base], ok: false)
        _ = call(api.rmdir, ["dirPath": file, "recursive": true], ok: false)
        _ = call(api.unlink, ["filePath": base], ok: false)
        _ = call(api.access, ["path": file])
        _ = call(api.unlink, ["filePath": base + "/renamed.json"])
        _ = call(api.rmdir, ["dirPath": base, "recursive": true])
        _ = call(api.access, ["path": file], ok: false)
    }
}
