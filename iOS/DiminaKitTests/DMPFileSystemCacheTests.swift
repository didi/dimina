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

    @MainActor
    func testBundledSDKBinaryFileBatchAndDescriptorRanges() async throws {
        let appId = "file-batch-\(UUID().uuidString)"
        let app = DMPApp(appConfig: DMPAppConfig(appName: "file batch", appId: appId), appIndex: 0)
        app.container = DMPContainer(app: app)
        _ = FileAPI(app: app)
        let service = DMPService(app: app)
        app.service = service
        defer {
            service.destroy()
            FileAPI.clearOpenFiles(appId: appId)
            try? FileManager.default.removeItem(atPath: DMPSandboxManager.appStoreResourceDirectoryPath(appId: appId))
        }
        DMPResourceManager.prepareSdk()
        await service.loadFile(path: DMPSandboxManager.sdkServicePath())
        let finished = expectation(description: "bundled SDK file batch completed")
        let reports = ThreadSafeEventLog()
        let engine = service.getEngine()
        engine.registerMethod(name: "__fileBatchFinished") { value in
            reports.record(value.toString() ?? "")
            finished.fulfill()
            return nil
        }
        engine.enqueueScript("""
            (async function() {
                const stringify = JSON.stringify;
                const report = {samples: [], checks: {}};
                try {
                    const fsm = wx.getFileSystemManager();
                    const root = wx.env.USER_DATA_PATH + '/';
                    if (!DiminaServiceBridge.fileBinarySupported) throw new Error('binary bridge unavailable');
                    JSON.stringify = function() { throw new Error('file payload must not stringify'); };
                    DiminaServiceBridge.encodeArrayBuffer = function() { throw new Error('file payload must not use Base64'); };
                    function check(buffer, size, first) {
                        const bytes = new Uint8Array(buffer);
                        if (!(buffer instanceof ArrayBuffer) || bytes.length !== size ||
                            bytes[0] !== first || bytes[size >> 1] !== 173 || bytes[size - 1] !== 255)
                            throw new Error('binary payload mismatch');
                    }
                    for (const [mib, count] of [[1, 32], [8, 8], [32, 2]]) {
                        const payload = new Uint8Array(mib * 1024 * 1024).fill(173);
                        payload[payload.length - 1] = 255;
                        let start = Date.now();
                        for (let i = 0; i < count; i++) {
                            payload[0] = i;
                            fsm.writeFileSync(root + 'asset-' + i, payload.buffer);
                        }
                        const writeMs = Date.now() - start;
                        start = Date.now();
                        for (let i = 0; i < count; i++) check(fsm.readFileSync(root + 'asset-' + i), payload.length, i);
                        const readMs = Date.now() - start;
                        report.samples.push({mode: 'sync', mib, count, writeMs, readMs});
                        for (let i = 0; i < count; i++) fsm.unlinkSync(root + 'asset-' + i);
                    }
                    const payload = new Uint8Array(8 * 1024 * 1024).fill(173);
                    payload[0] = 0; payload[payload.length - 1] = 255;
                    const path = root + 'async-asset';
                    let start = Date.now();
                    for (let i = 0; i < 8; i++) await fsm.writeFile({filePath: path, data: payload.buffer});
                    const writeMs = Date.now() - start;
                    start = Date.now();
                    for (let i = 0; i < 8; i++) check((await fsm.readFile({filePath: path})).data, payload.length, 0);
                    report.samples.push({mode: 'promise', mib: 8, count: 8, writeMs, readMs: Date.now() - start});
                    await new Promise((resolve, reject) => {
                        const events = [];
                        fsm.readFile({filePath: path, success(res) {
                            try { check(res.data, payload.length, 0); events.push('success'); }
                            catch (error) { reject(error); }
                        }, fail: reject, complete(res) {
                            try {
                                check(res.data, payload.length, 0); events.push('complete');
                                report.checks.callbackOrder = events.join(',') === 'success,complete';
                                resolve();
                            } catch (error) { reject(error); }
                        }});
                    });
                    fsm.unlinkSync(path);
                    const slicePath = root + 'slice-asset';
                    const large = new Uint8Array(32 * 1024 * 1024).fill(173);
                    large[large.length - 1] = 255;
                    fsm.writeFileSync(slicePath, large.buffer);
                    start = Date.now();
                    for (let i = 0; i < 64; i++) {
                        const bytes = new Uint8Array(fsm.readFileSync(slicePath, undefined, i * 65536, 65536));
                        if (bytes.length !== 65536 || bytes[0] !== 173 || bytes[65535] !== 173)
                            throw new Error('partial read mismatch');
                    }
                    report.samples.push({mode: 'slice', mib: 32, count: 64, length: 65536, readMs: Date.now() - start});
                    const eof = fsm.readFileSync(slicePath, undefined, large.length - 2, 10);
                    report.checks.partialEOF = eof.byteLength === 2 && new Uint8Array(eof)[1] === 255;
                    report.checks.beyondEOF = fsm.readFileSync(slicePath, undefined, large.length + 1, 10).byteLength === 0;
                    fsm.unlinkSync(slicePath);
                    const rangePath = root + 'ranges';
                    fsm.writeFileSync(rangePath, new Uint8Array([90, 91, 92, 93, 94]).buffer);
                    const fd = fsm.openSync({filePath: rangePath, flag: 'r+'});
                    const written = fsm.writeSync({fd, position: 1, data: new Uint8Array([8, 7, 6, 5]).buffer,
                        offset: 1, length: 2});
                    report.checks.writeRange = written.bytesWritten === 2 &&
                        Array.from(new Uint8Array(fsm.readFileSync(rangePath))).join(',') === '90,7,6,93,94';
                    const zero = fsm.writeSync({fd, position: 0, data: payload.buffer, offset: 1, length: 0});
                    report.checks.zeroLengthWrite = zero.bytesWritten === 0;
                    const remaining = await fsm.write({fd, position: 0, data: new Uint8Array([8, 7, 6, 5]).buffer, offset: 2});
                    report.checks.asyncWriteRange = remaining.bytesWritten === 2 &&
                        new Uint8Array(fsm.readFileSync(rangePath))[0] === 6;
                    let rejected = false;
                    try { fsm.writeSync({fd, data: new ArrayBuffer(4), offset: 3, length: 2}); }
                    catch (error) { rejected = true; }
                    report.checks.invalidWriteRange = rejected;
                    fsm.closeSync({fd});
                    fsm.writeFileSync(rangePath, new Uint8Array([90, 91, 92, 93, 94]).buffer);
                    const readFd = fsm.openSync({filePath: rangePath, flag: 'r'});
                    const target = new Uint8Array(6).fill(99);
                    const read = fsm.readSync({fd: readFd, position: 1, arrayBuffer: target.buffer, offset: 2, length: 2});
                    report.checks.readRange = read.bytesRead === 2 && read.arrayBuffer === target.buffer &&
                        Array.from(target).join(',') === '99,99,91,92,99,99';
                    fsm.closeSync({fd: readFd}); fsm.unlinkSync(rangePath);
                } catch (error) {
                    report.error = String(error); report.stack = error.stack;
                } finally {
                    JSON.stringify = stringify;
                    __fileBatchFinished(stringify(report));
                }
            })();
            """)
        await fulfillment(of: [finished], timeout: 60)
        let json = try XCTUnwrap(reports.events.first)
        print("FILE_BATCH_REPORT=\(json)")
        let report = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertNil(report["error"], json)
        let checks = try XCTUnwrap(report["checks"] as? [String: Bool])
        XCTAssertEqual(checks, ["callbackOrder": true, "writeRange": true, "zeroLengthWrite": true,
                                "asyncWriteRange": true, "invalidWriteRange": true, "readRange": true,
                                "partialEOF": true, "beyondEOF": true], json)
        XCTAssertEqual((report["samples"] as? [[String: Any]])?.count, 5)
    }
}
