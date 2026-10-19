import AVFoundation
import JavaScriptCore
import Network
import Testing
import UIKit
import XCTest
@testable import dimina

final class DMPVideoDecoderTests: XCTestCase {
    func testCanIUseAcceptsThePublicStringArgument() {
        _ = VideoDecoderAPI()
        let api = BaseAPI()
        let env = DMPBridgeEnv(appIndex: 0, appId: "capability-test", webViewId: 0)
        let values: [Any] = ["VideoDecoder.start", ["schema": "VideoDecoder.start"]]
        for value in values {
            let result = api.canIUse(DMPBridgeParam(value: value), env, nil) as? DMPSyncResult
            XCTAssertEqual(result?.value as? Bool, true)
        }
        let missing = api.canIUse(DMPBridgeParam(value: "unknownAPI"), env, nil) as? DMPSyncResult
        XCTAssertEqual(missing?.value as? Bool, false)
    }

    func testH264RGBAFramesSeekEndAndRemove() throws {
        let owner = "video-decoder-test-\(UUID().uuidString)"
        let directory = DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner)
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer {
            VideoDecoderStore.dispose(owner: owner)
            try? FileManager.default.removeItem(atPath: directory)
        }
        let url = URL(fileURLWithPath: directory).appendingPathComponent("colors.mp4")
        try writeVideo(url)
        let api = VideoDecoderAPI()
        let env = DMPBridgeEnv(appIndex: 0, appId: owner, webViewId: 0)
        let id = "test-decoder"
        let source = DMPFileUtil.vPathFromSandboxPath(sandboxPath: url.path, appId: owner)

        func control(_ handler: DMPBridgeMethodHandler, _ params: [String: Any] = [:]) -> DMPMap {
            let done = expectation(description: "decoder control")
            var result = DMPMap()
            _ = handler(DMPBridgeParam(value: params.merging(["decoderId": id]) { _, id in id }), env) { value, kind in
                if kind != .complete {
                    XCTAssertEqual(kind, .success, value.getString(key: "errMsg") ?? "missing result")
                    result = value
                    done.fulfill()
                }
            }
            wait(for: [done], timeout: 5)
            return result
        }
        func frame() -> [String: Any] {
            let result = api.getFrameData(DMPBridgeParam(value: ["decoderId": id]), env, nil) as? DMPSyncResult
            return result?.value as? [String: Any] ?? [:]
        }
        func nextFrame() throws -> [String: Any] {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                let value = frame()
                if let error = value["error"] as? String { throw NSError(domain: error, code: 1) }
                if value["data"] != nil { return value }
                Thread.sleep(forTimeInterval: 0.005)
            }
            throw NSError(domain: "No decoded frame", code: 1)
        }
        let metadata = control(api.start, ["source": source, "mode": 1])
        XCTAssertEqual(metadata.getInt(key: "width"), 16)
        XCTAssertEqual(metadata.getInt(key: "height"), 16)
        let first = try nextFrame()
        let pixels = try XCTUnwrap(first["data"] as? Data, "Video frames must reach the bridge as owned bytes, without Base64")
        XCTAssertEqual(pixels.count, 16 * 16 * 4)
        XCTAssertGreaterThan(pixels[0], 200) // The first encoded frame is red; verify BGRA -> RGBA.
        XCTAssertLessThan(pixels[1], 40)
        XCTAssertLessThan(pixels[2], 40)
        XCTAssertEqual(pixels[3], 255)
        let context = try XCTUnwrap(JSContext())
        context.setObject(DMPBridgeParam.from(rawValue: first).getJSValue(context: context), forKeyedSubscript: "frame" as NSString)
        XCTAssertTrue(context.evaluateScript("frame.data instanceof ArrayBuffer && frame.data.byteLength === 1024")!.toBool())
        context.evaluateScript("new Uint8Array(frame.data)[0] = 17")
        XCTAssertGreaterThan(pixels[0], 200, "JS mutation must not change the native frame")

        _ = control(api.seek, ["position": 500])
        let sought = try nextFrame()
        XCTAssertGreaterThanOrEqual(sought["pts"] as? Double ?? -1, 500_000)
        let final = try nextFrame()
        XCTAssertGreaterThan(final["pts"] as? Double ?? -1, sought["pts"] as? Double ?? -1)
        let deadline = Date().addingTimeInterval(5)
        var ended = false
        while Date() < deadline && !ended {
            ended = frame()["ended"] as? Bool == true
            if !ended { Thread.sleep(forTimeInterval: 0.005) }
        }
        XCTAssertTrue(ended)
        _ = control(api.seek, ["position": 0])
        XCTAssertLessThan(try nextFrame()["pts"] as? Double ?? -1, 500_000)
        _ = control(api.stop)
        XCTAssertNil(frame()["data"])
        _ = control(api.remove)
        XCTAssertTrue(frame().isEmpty)
        XCTAssertEqual(context.evaluateScript("new Uint8Array(frame.data)[0]")!.toInt32(), 17,
                       "The returned ArrayBuffer must survive seek, stop, and removal")
    }

    func testHTTPVideoDecodesSeeksAndReleasesDownloadedSources() throws {
        let owner = "video-decoder-http-\(UUID().uuidString)"
        let directory = URL(fileURLWithPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { VideoDecoderStore.dispose(owner: owner); try? FileManager.default.removeItem(at: directory) }
        let fixture = directory.appendingPathComponent("colors.mp4")
        try writeVideo(fixture)
        let data = try Data(contentsOf: fixture)
        let server = try VideoDecoderHTTPServer(body: data)
        defer { server.stop() }
        let api = VideoDecoderAPI()
        let env = DMPBridgeEnv(appIndex: 0, appId: owner, webViewId: 0)
        let id = "remote"
        func control(_ handler: DMPBridgeMethodHandler, _ params: [String: Any] = [:]) {
            let done = expectation(description: "remote control")
            _ = handler(DMPBridgeParam(value: params.merging(["decoderId": id]) { _, id in id }), env) { value, kind in
                if kind != .complete {
                    XCTAssertEqual(kind, .success, value.getString(key: "errMsg") ?? "missing result")
                    done.fulfill()
                }
            }
            wait(for: [done], timeout: 5)
        }
        func frame() -> [String: Any] {
            (api.getFrameData(DMPBridgeParam(value: ["decoderId": id]), env, nil) as? DMPSyncResult)?.value as? [String: Any] ?? [:]
        }
        func nextFrame() throws -> [String: Any] {
            let deadline = Date().addingTimeInterval(5)
            while Date() < deadline {
                let value = frame()
                if let error = value["error"] as? String { throw NSError(domain: error, code: 1) }
                if value["data"] != nil { return value }
                Thread.sleep(forTimeInterval: 0.005)
            }
            throw NSError(domain: "No remote decoded frame", code: 1)
        }
        func downloadedDirectories() throws -> [URL] {
            try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                .filter { $0.lastPathComponent.hasPrefix("video-decoder-") }
        }
        control(api.start, ["source": server.url.absoluteString, "mode": 1])
        let first = try nextFrame()
        let pixels = try XCTUnwrap(first["data"] as? Data)
        XCTAssertEqual(pixels.count, 16 * 16 * 4)
        XCTAssertGreaterThan(pixels[0], 200)
        XCTAssertLessThan(pixels[1], 40)
        let downloaded = try XCTUnwrap(downloadedDirectories().first)
        XCTAssertEqual(try Data(contentsOf: downloaded.appendingPathComponent("source.mp4")), data)
        control(api.seek, ["position": 500])
        XCTAssertGreaterThanOrEqual(try nextFrame()["pts"] as? Double ?? -1, 500_000)
        XCTAssertTrue(FileManager.default.fileExists(atPath: downloaded.path))
        control(api.start, ["source": server.url.absoluteString])
        XCTAssertLessThan(try nextFrame()["pts"] as? Double ?? -1, 500_000)
        XCTAssertEqual(try downloadedDirectories().count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: downloaded.path))
        control(api.stop)
        XCTAssertTrue(try downloadedDirectories().isEmpty)
        control(api.start, ["source": server.url.absoluteString])
        XCTAssertNotNil(try nextFrame()["data"])
        control(api.remove)
        XCTAssertTrue(try downloadedDirectories().isEmpty)
        XCTAssertTrue(frame().isEmpty)
    }

    func testStopRemoveAndAppDisposeCancelUnfinishedHTTPDownloads() throws {
        for command in ["stop", "remove", "dispose"] {
            let owner = "video-decoder-cancel-\(UUID().uuidString)"
            let directory = DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner)
            defer { VideoDecoderStore.dispose(owner: owner); try? FileManager.default.removeItem(atPath: directory) }
            let requested = expectation(description: "download request received")
            let server = try VideoDecoderHTTPServer(body: Data(), holdResponse: true) { requested.fulfill() }
            defer { server.stop() }
            let api = VideoDecoderAPI()
            let env = DMPBridgeEnv(appIndex: 0, appId: owner, webViewId: 0)
            let started = expectation(description: "cancelled start settles")
            _ = api.start(DMPBridgeParam(value: ["decoderId": "pending", "source": server.url.absoluteString]), env) { value, kind in
                if kind != .complete {
                    XCTAssertEqual(kind, .fail, value.getString(key: "errMsg") ?? "missing result")
                    started.fulfill()
                }
            }
            wait(for: [requested], timeout: 5)
            var pendingStarts = [started]
            if command == "stop" {
                // The first download occupies the decoder queue. This second
                // start must be invalidated before it can create another task.
                let queuedStart = expectation(description: "queued start cancelled")
                _ = api.start(DMPBridgeParam(value: ["decoderId": "pending", "source": server.url.absoluteString]), env) { value, kind in
                    if kind != .complete {
                        XCTAssertEqual(kind, .fail, value.getString(key: "errMsg") ?? "missing result")
                        queuedStart.fulfill()
                    }
                }
                pendingStarts.append(queuedStart)
            }
            let removed = expectation(description: "remove settles")
            if command == "dispose" {
                VideoDecoderStore.dispose(owner: owner)
                removed.fulfill()
            } else {
                let control = command == "stop" ? api.stop : api.remove
                _ = control(DMPBridgeParam(value: ["decoderId": "pending"]), env) { _, kind in
                    if kind == .success { removed.fulfill() }
                }
            }
            wait(for: pendingStarts + [removed], timeout: 5)
            let remaining = try FileManager.default.contentsOfDirectory(atPath: directory)
            XCTAssertTrue(remaining.isEmpty)
            XCTAssertEqual(server.requestCount, 1)
            if command == "stop" {
                let fixture = URL(fileURLWithPath: directory).appendingPathComponent("restart.mp4")
                try writeVideo(fixture)
                let restartedServer = try VideoDecoderHTTPServer(body: Data(contentsOf: fixture))
                defer { restartedServer.stop() }
                let restarted = expectation(description: "start after stop")
                _ = api.start(DMPBridgeParam(value: ["decoderId": "pending", "source": restartedServer.url.absoluteString]), env) { value, kind in
                    if kind != .complete {
                        XCTAssertEqual(kind, .success, value.getString(key: "errMsg") ?? "missing result")
                        restarted.fulfill()
                    }
                }
                wait(for: [restarted], timeout: 5)
                let deadline = Date().addingTimeInterval(5)
                var decoded = false
                while Date() < deadline && !decoded {
                    let result = api.getFrameData(DMPBridgeParam(value: ["decoderId": "pending"]), env, nil) as? DMPSyncResult
                    decoded = (result?.value as? [String: Any])?["data"] != nil
                    if !decoded { Thread.sleep(forTimeInterval: 0.005) }
                }
                XCTAssertTrue(decoded)
            }
        }
    }

    func testHTTPFailureRemovesItsDownloadDirectory() throws {
        let owner = "video-decoder-http-error-\(UUID().uuidString)"
        let directory = DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner)
        defer { VideoDecoderStore.dispose(owner: owner); try? FileManager.default.removeItem(atPath: directory) }
        let server = try VideoDecoderHTTPServer(body: Data(), status: 404)
        defer { server.stop() }
        let api = VideoDecoderAPI()
        let done = expectation(description: "HTTP failure")
        _ = api.start(DMPBridgeParam(value: ["decoderId": "bad", "source": server.url.absoluteString]),
                      DMPBridgeEnv(appIndex: 0, appId: owner, webViewId: 0)) { value, kind in
            if kind != .complete {
                XCTAssertEqual(kind, .fail)
                XCTAssertTrue(value.getString(key: "errMsg")?.contains("404") == true)
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 5)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: directory).isEmpty)
    }

    @MainActor
    func testBundledSDKPortraitVideoThroughput() async throws {
        let idleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = idleTimerDisabled }
        let owner = "video-throughput-\(UUID().uuidString)"
        let directory = DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner)
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let url = URL(fileURLWithPath: directory).appendingPathComponent("portrait.mp4")
        try writeVideo(url, width: 720, height: 1080, frames: 120, fps: 25)
        let app = DMPApp(appConfig: DMPAppConfig(appName: "video throughput", appId: owner), appIndex: 0)
        app.container = DMPContainer(app: app)
        _ = VideoDecoderAPI(app: app)
        let service = DMPService(app: app)
        app.service = service
        defer {
            service.destroy()
            VideoDecoderStore.dispose(owner: owner)
            try? FileManager.default.removeItem(atPath: DMPSandboxManager.appStoreResourceDirectoryPath(appId: owner))
        }
        DMPResourceManager.prepareSdk()
        await service.loadFile(path: DMPSandboxManager.sdkServicePath())
        let finished = expectation(description: "bundled SDK video throughput")
        let reports = ThreadSafeEventLog()
        let engine = service.getEngine()
        engine.registerMethod(name: "__videoBenchmarkComplete") { value in
            reports.record(value.toString() ?? "")
            finished.fulfill()
            return nil
        }
        let source = DMPFileUtil.vPathFromSandboxPath(sandboxPath: url.path, appId: owner)
        engine.enqueueScript("""
            (async function() {
                const report = {samples: [], checks: {}};
                const decoder = wx.createVideoDecoder();
                try {
                    await decoder.start({source: '\(source)', mode: 1});
                    let retained;
                    for (let round = 0; round < 2; round++) {
                        if (round) await decoder.seek(0);
                        let count = 0, start = 0, lastPTS = -1;
                        const deadline = Date.now() + 60000;
                        while (count < 120 && Date.now() < deadline) {
                            const frame = decoder.getFrameData();
                            if (!frame) { await new Promise(resolve => setTimeout(resolve, 2)); continue; }
                            if (!(frame.data instanceof ArrayBuffer) || frame.data.byteLength !== 3110400 ||
                                frame.width !== 720 || frame.height !== 1080 || frame.pts <= lastPTS)
                                throw Error('invalid frame bytes or PTS');
                            lastPTS = frame.pts;
                            if (!retained) { retained = frame.data; new Uint8Array(retained)[0] = 17; }
                            if (count === 8) start = Date.now();
                            count++;
                            // Let the engine process another task between frames,
                            // as it does during actual player callbacks.
                            await new Promise(resolve => setTimeout(resolve, 2));
                        }
                        if (count !== 120) throw Error('decoded frame count: ' + count);
                        const elapsedMs = Date.now() - start;
                        report.samples.push({frames: count, warmup: 8, elapsedMs, fps: 112000 / elapsedMs});
                    }
                    await decoder.stop();
                    report.checks.stopped = decoder.getFrameData() === null;
                    await decoder.remove();
                    report.checks.removed = decoder.getFrameData() === null;
                    report.checks.retained = new Uint8Array(retained)[0] === 17;
                } catch (error) { report.error = String(error && (error.stack || error)); }
                finally { await decoder.remove(); __videoBenchmarkComplete(JSON.stringify(report)); }
            })();
        """)
        await fulfillment(of: [finished], timeout: 150)
        let report = try XCTUnwrap(reports.events.first)
        print("VIDEO_FRAME_REPORT \(report)")
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(report.utf8)) as? [String: Any])
        XCTAssertNil(result["error"], report)
        XCTAssertEqual((result["samples"] as? [[String: Any]])?.count, 2, report)
        XCTAssertTrue((result["checks"] as? [String: Bool])?.values.allSatisfy { $0 } == true, report)
    }

    private func writeVideo(_ url: URL, width: Int = 16, height: Int = 16, frames: Int = 3, fps: Int32 = 2) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for index in 0..<frames {
            var buffer: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
            let image = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(image, [])
            let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddress(image)).assumingMemoryBound(to: UInt8.self)
            let stride = CVPixelBufferGetBytesPerRow(image)
            let color: [UInt8] = [index % 3 == 2 ? 255 : 0, index % 3 == 1 ? 255 : 0, index % 3 == 0 ? 255 : 0, 255]
            color.withUnsafeBytes { memset_pattern4(bytes, $0.baseAddress!, stride * height) }
            CVPixelBufferUnlockBaseAddress(image, [])
            let deadline = Date().addingTimeInterval(5)
            while !input.isReadyForMoreMediaData && Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
            XCTAssertTrue(adaptor.append(image, withPresentationTime: CMTime(value: Int64(index), timescale: fps)))
        }
        input.markAsFinished()
        let finished = expectation(description: "fixture video encoded")
        writer.finishWriting { finished.fulfill() }
        wait(for: [finished], timeout: 5)
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "encoding failed")
    }
}

struct VideoFramePixelsTests {
    @Test(arguments: [1, 3, 17, 256])
    func preservesChannelsAlphaPaddedRowsAndOwnership(width: Int) throws {
        let height = 5
        var buffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferBytesPerRowAlignmentKey: 64] as CFDictionary
        let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes, &buffer)
        #expect(status == kCVReturnSuccess)
        let image = try #require(buffer)
        func fill() throws -> [UInt8] {
            CVPixelBufferLockBaseAddress(image, [])
            defer { CVPixelBufferUnlockBaseAddress(image, []) }
            let stride = CVPixelBufferGetBytesPerRow(image)
            let bytes = try #require(CVPixelBufferGetBaseAddress(image)).assumingMemoryBound(to: UInt8.self)
            for index in 0..<stride * height { bytes[index] = UInt8(truncatingIfNeeded: index * 37 + 19) }
            var expected: [UInt8] = []
            for y in 0..<height { for x in 0..<width {
                let offset = y * stride + x * 4
                expected.append(contentsOf: [bytes[offset + 2], bytes[offset + 1], bytes[offset], bytes[offset + 3]])
            } }
            return expected
        }
        let expected = try fill()
        let rgba = try VideoFramePixels.rgba(from: image)
        #expect(Array(rgba) == expected)
        CVPixelBufferLockBaseAddress(image, [])
        memset(CVPixelBufferGetBaseAddress(image)!, 0, CVPixelBufferGetBytesPerRow(image) * height)
        CVPixelBufferUnlockBaseAddress(image, [])
        #expect(Array(rgba) == expected, "returned pixels must not alias the decoder's reusable pixel buffer")
    }
}

private final class VideoDecoderHTTPServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "VideoDecoderTests.HTTP")
    private var connections: [NWConnection] = []
    private var receivedRequests = 0
    var url: URL { URL(string: "http://127.0.0.1:\(listener.port!.rawValue)/colors.mp4")! }
    var requestCount: Int { queue.sync { receivedRequests } }

    init(body: Data, status: Int = 200, holdResponse: Bool = false, onRequest: (() -> Void)? = nil) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                self.receivedRequests += 1
                onRequest?()
                guard !holdResponse else { return }
                var response = Data("HTTP/1.1 \(status) OK\r\nContent-Type: video/mp4\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
                response.append(body)
                connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, listener.port != nil else {
            listener.cancel()
            throw NSError(domain: "HTTP test listener failed", code: 1)
        }
    }

    func stop() {
        queue.sync { connections.forEach { $0.cancel() }; connections.removeAll(); listener.cancel() }
    }
}
