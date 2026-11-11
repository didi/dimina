import Foundation
import Network
import Testing
@testable import dimina

@Suite("HTTP request binary bridge")
@MainActor
struct DMPNetworkBinaryTests {
    private let bytes = Data([0, 255, 128, 195, 40, 13, 10])

    @Test
    func rawBytesAndHttpErrorStatusReachSuccessAndComplete() async throws {
        let server = try BinaryHTTPServer(status: 503, response: bytes)
        defer { server.stop() }
        let url = try await server.start()
        let result = await invoke([
            "url": url.absoluteString, "method": "POST", "responseType": "arraybuffer",
            "data": ["__diminaArrayBufferBase64": bytes.base64EncodedString()],
        ])
        #expect(server.requestBody == bytes)
        #expect(result.values.map(\.1) == [.success, .complete])
        for (value, _) in result.values {
            #expect(value.getInt(key: "statusCode") == 503)
            #expect(value.getString(key: "errMsg") == "request:ok")
            let payload = try #require(value.get("data") as? [String: String])
            #expect(Data(base64Encoded: try #require(payload["__diminaArrayBufferBase64"])) == bytes)
            #expect(JSONSerialization.isValidJSONObject(value.toDictionary()))
        }
    }

    @Test
    func emptyBodyIsStillAnArrayBuffer() async throws {
        let server = try BinaryHTTPServer(status: 204, response: Data())
        defer { server.stop() }
        let result = await invoke(["url": try await server.start().absoluteString, "responseType": "arraybuffer"])
        #expect(result.values.map(\.1) == [.success, .complete])
        let payload = try #require(result.values.first?.0.get("data") as? [String: String])
        #expect(payload["__diminaArrayBufferBase64"] == "")
    }

    @Test(arguments: ["false", "[1,2]", "not-json"])
    func jsonPrimitivesAndInvalidJsonPreserveTheResponse(_ text: String) async throws {
        let server = try BinaryHTTPServer(status: 200, response: Data(text.utf8))
        defer { server.stop() }
        let result = await invoke(["url": try await server.start().absoluteString, "dataType": "json"])
        #expect(result.values.map(\.1) == [.success, .complete])
        let data = try #require(result.values.first?.0.get("data"))
        if text == "false" { #expect((data as? NSNumber)?.boolValue == false) }
        else if text == "[1,2]" { #expect(data as? [Int] == [1, 2]) }
        else { #expect(data as? String == text) }
    }

    @Test
    func invalidUrlCompletesOnceWithTheFailure() async throws {
        let result = await invoke(["url": "http://["])
        #expect(result.values.map(\.1) == [.fail, .complete])
        #expect(result.values.first?.0.getString(key: "errMsg") == "request:fail invalid url")
        #expect(result.values.first?.0 === result.values.last?.0)
    }

    private final class Results {
        var values: [(DMPMap, DMPBridgeCallbackType)] = []
        var completed = false
    }

    private func invoke(_ options: [String: Any]) async -> Results {
        _ = NetworkAPI()
        return await withCheckedContinuation { continuation in
            let result = Results()
            guard let handler = DMPContainerApi.getHandler(for: "request") else {
                Issue.record("request bridge is not registered")
                continuation.resume(returning: result)
                return
            }
            _ = handler(DMPBridgeParam(value: options),
                        DMPBridgeEnv(appIndex: -1, appId: "http-binary-regression", webViewId: 0)) { data, type in
                result.values.append((data, type))
                if type == .complete && !result.completed {
                    result.completed = true
                    continuation.resume(returning: result)
                }
            }
        }
    }
}

/// A real loopback HTTP peer. Mutable state is protected by the lock; Network callbacks use one queue.
private final class BinaryHTTPServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dimina.tests.binary-http")
    private let lock = NSLock()
    private let status: Int
    private let response: Data
    private var startup: CheckedContinuation<URL, Error>?
    private var received = Data()

    var requestBody: Data {
        lock.lock()
        defer { lock.unlock() }
        return received
    }

    init(status: Int, response: Data) throws {
        self.status = status
        self.response = response
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        listener = try NWListener(using: parameters, on: .any)
    }

    func start() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            startup = continuation
            lock.unlock()
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                if case .ready = state, let port = listener.port {
                    finishStartup(.success(URL(string: "http://127.0.0.1:\(port.rawValue)/bytes")!))
                } else if case .failed(let error) = state {
                    finishStartup(.failure(error))
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                connection.start(queue: queue)
                receive(connection, bytes: Data())
            }
            listener.start(queue: queue)
        }
    }

    func stop() { listener.cancel() }

    private func finishStartup(_ result: Result<URL, Error>) {
        lock.lock()
        let continuation = startup
        startup = nil
        lock.unlock()
        continuation?.resume(with: result)
    }

    private func receive(_ connection: NWConnection, bytes: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, ended, error in
            guard let self else { connection.cancel(); return }
            var request = bytes
            if let data { request.append(data) }
            if let end = request.range(of: Data("\r\n\r\n".utf8)) {
                let headers = String(decoding: request[..<end.lowerBound], as: UTF8.self)
                let length = headers.components(separatedBy: "\r\n").first {
                    $0.lowercased().hasPrefix("content-length:")
                }.flatMap { Int($0.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                if request.count - end.upperBound >= length {
                    lock.lock()
                    received = Data(request[end.upperBound..<end.upperBound + length])
                    lock.unlock()
                    var packet = Data("HTTP/1.1 \(status) Result\r\nContent-Length: \(response.count)\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n".utf8)
                    packet.append(response)
                    connection.send(content: packet, completion: .contentProcessed { _ in connection.cancel() })
                    return
                }
            }
            if ended || error != nil { connection.cancel(); return }
            receive(connection, bytes: request)
        }
    }
}
