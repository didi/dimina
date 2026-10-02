import AVFoundation
import Network
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
        let encoded = try XCTUnwrap((first["data"] as? [String: String])?["__diminaArrayBufferBase64"])
        let pixels = try XCTUnwrap(Data(base64Encoded: encoded))
        XCTAssertEqual(pixels.count, 16 * 16 * 4)
        XCTAssertGreaterThan(pixels[0], 200) // The first encoded frame is red; verify BGRA -> RGBA.
        XCTAssertLessThan(pixels[1], 40)
        XCTAssertLessThan(pixels[2], 40)
        XCTAssertEqual(pixels[3], 255)

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
        let encoded = try XCTUnwrap((first["data"] as? [String: String])?["__diminaArrayBufferBase64"])
        let pixels = try XCTUnwrap(Data(base64Encoded: encoded))
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

    private func writeVideo(_ url: URL) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 16, AVVideoHeightKey: 16,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 16, kCVPixelBufferHeightKey as String: 16,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for index in 0..<3 {
            var buffer: CVPixelBuffer?
            XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 16, 16, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
            let image = try XCTUnwrap(buffer)
            CVPixelBufferLockBaseAddress(image, [])
            let bytes = try XCTUnwrap(CVPixelBufferGetBaseAddress(image)).assumingMemoryBound(to: UInt8.self)
            let stride = CVPixelBufferGetBytesPerRow(image)
            for y in 0..<16 { for x in 0..<16 {
                let offset = y * stride + x * 4
                bytes[offset] = index == 2 ? 255 : 0
                bytes[offset + 1] = index == 1 ? 255 : 0
                bytes[offset + 2] = index == 0 ? 255 : 0
                bytes[offset + 3] = 255
            } }
            CVPixelBufferUnlockBaseAddress(image, [])
            let deadline = Date().addingTimeInterval(5)
            while !input.isReadyForMoreMediaData && Date() < deadline { Thread.sleep(forTimeInterval: 0.005) }
            XCTAssertTrue(adaptor.append(image, withPresentationTime: CMTime(value: Int64(index), timescale: 2)))
        }
        input.markAsFinished()
        let finished = expectation(description: "fixture video encoded")
        writer.finishWriting { finished.fulfill() }
        wait(for: [finished], timeout: 5)
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "encoding failed")
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
