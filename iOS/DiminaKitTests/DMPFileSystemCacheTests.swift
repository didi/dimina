import XCTest
import JavaScriptCore
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
            XCTAssertEqual(read(api.readFile, path: path).get("data") as? Data, wasm)
        }
        XCTAssertEqual(read(api.readCompressedFile, path: "/utils/module.wasm.br").get("data") as? Data, wasm)
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
        XCTAssertEqual(Set(try XCTUnwrap(stats).keys), ["", "/form.json"])
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

    @MainActor
    func testLargeBinaryFilesCrossTheRealServiceBridgeWithoutSerialization() async throws {
        let appId = "binary-files-\(UUID().uuidString)"
        let app = DMPApp(appConfig: DMPAppConfig(appName: "binary", appId: appId), appIndex: 0)
        app.container = DMPContainer(app: app)
        let api = FileAPI(app: app)
        let service = DMPService(app: app)
        app.service = service
        defer {
            service.destroy()
            FileAPI.clearOpenFiles(appId: appId)
            try? FileManager.default.removeItem(atPath: DMPSandboxManager.appStoreResourceDirectoryPath(appId: appId))
        }
        let engine = service.getEngine()
        // A native function delivery must work even if JSON serialization is disabled.
        let setup = await engine.evaluateScript("""
            var events = [];
            DiminaServiceBridge.onMessage = function(msg) {
                var bytes = new Uint8Array(msg.body.args.data);
                events.push([msg.body.id, bytes.length, bytes[0], bytes[bytes.length - 1]]);
            };
            JSON.stringify = function() { throw new Error('file bridge must not stringify'); };
            function file(name, params) {
                return DiminaServiceBridge.invoke({ type: 'invokeAPI', target: 'container',
                    body: { name: 'FileSystemManager.' + name, bridgeId: 0, params: params } });
            }
            var payload = new Uint8Array(8 * 1024 * 1024);
            payload.fill(173); payload[0] = 0; payload[payload.length - 1] = 255;
            var path = __VIRTUAL_FILE_PREFIX__ + 'usr/asset.bin';
            file('writeFileSync', {filePath: path, data: payload.buffer});
            var bytes = new Uint8Array(file('readFileSync', {filePath: path}));
            bytes.length === payload.length && bytes[0] === 0 && bytes[bytes.length - 1] === 255;
            """)
        XCTAssertEqual(setup?.toBool(), true)
        XCTAssertNotNil(api)
        _ = await engine.evaluateScript("file('readFile', {filePath: path, success:'success', complete:'complete'});")
        let result = await engine.evaluateScript("events.length === 2 && events[0][0] === 'success' && events[1][0] === 'complete' && events.every(e => e[1] === payload.length && e[2] === 0 && e[3] === 255)")
        XCTAssertEqual(result?.toBool(), true)
        let descriptor = await engine.evaluateScript("""
            var fd = file('openSync', {filePath:path, flag:'r+'});
            var part = file('readSync', {fd:fd, position:payload.length-2, length:10});
            file('writeSync', {fd:fd, position:1, arrayBuffer:new Uint8Array([7,8]).buffer});
            file('closeSync', {fd:fd});
            var updated = new Uint8Array(file('readFileSync', {filePath:path, position:0, length:4}));
            part.bytesRead === 2 && part.arrayBuffer instanceof ArrayBuffer &&
                new Uint8Array(part.arrayBuffer)[1] === 255 && updated[1] === 7 && updated[2] === 8;
            """)
        XCTAssertEqual(descriptor?.toBool(), true)
    }

    func testBinaryBridgeOwnsBuffersAndPreservesEmptyNestedData() throws {
        let context = try XCTUnwrap(JSContext())
        var data = Data([0, 128, 255])
        context.setObject(DMPBinaryBridge.encode(["entries": ["a.bin": ["data": data]], "empty": Data(), "__proto__": "own property"], in: context),
                          forKeyedSubscript: "packet" as NSString)
        data[1] = 1
        XCTAssertTrue(context.evaluateScript("packet.empty instanceof ArrayBuffer && packet.empty.byteLength === 0 && new Uint8Array(packet.entries['a.bin'].data)[1] === 128")!.toBool())
        XCTAssertEqual(DMPBinaryBridge.decodeBuffer(context.evaluateScript("packet.entries['a.bin'].data")), Data([0, 128, 255]))
        XCTAssertEqual(DMPBinaryBridge.decodeBuffer(context.evaluateScript("packet.empty")), Data())
        XCTAssertTrue(context.evaluateScript("Object.getPrototypeOf(packet) === Object.prototype && packet.__proto__ === 'own property'")!.toBool())
    }
}
