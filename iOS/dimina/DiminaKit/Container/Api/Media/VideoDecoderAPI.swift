import AVFoundation
import Foundation

final class VideoDecoderAPI: DMPContainerApi {
    @BridgeMethod("VideoDecoder.start")
    var start: DMPBridgeMethodHandler = { param, env, callback in
        let values = param.getMap()
        guard let id = values.getString(key: "decoderId"),
              let source = values.getString(key: "source"), !source.isEmpty else {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "VideoDecoder.start:fail missing source or decoderId")
            return DMPNoneResult()
        }
        do {
            let session = try VideoDecoderStore.session(owner: env.appId, id: id, create: true)
            session.control("start", callback: callback) {
                try session.start(url: VideoDecoderStore.resolve(source, owner: env.appId),
                                  mode: values.getInt(key: "mode") ?? 1)
            }
        } catch {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "VideoDecoder.start:fail \(error.localizedDescription)")
        }
        return DMPNoneResult()
    }

    @BridgeMethod("VideoDecoder.seek")
    var seek: DMPBridgeMethodHandler = { param, env, callback in
        VideoDecoderAPI.control("seek", param, env, callback) { session, values in
            guard let position = values.get("position") as? NSNumber else { throw VideoDecoderError("invalid position") }
            return try session.seek(position.doubleValue)
        }
    }

    @BridgeMethod("VideoDecoder.stop")
    var stop: DMPBridgeMethodHandler = { param, env, callback in
        VideoDecoderAPI.control("stop", param, env, callback) { session, _ in session.stop(); return [:] }
    }

    @BridgeMethod("VideoDecoder.remove")
    var remove: DMPBridgeMethodHandler = { param, env, callback in
        VideoDecoderStore.remove(owner: env.appId, id: param.getMap().getString(key: "decoderId") ?? "") {
            DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(["errMsg": "VideoDecoder.remove:ok"]))
        }
        return DMPNoneResult()
    }

    @BridgeMethod("VideoDecoder.getFrameData")
    var getFrameData: DMPBridgeMethodHandler = { param, env, _ in
        guard let id = param.getMap().getString(key: "decoderId"),
              let session = try? VideoDecoderStore.session(owner: env.appId, id: id) else { return DMPSyncResult([:]) }
        return DMPSyncResult(session.frame())
    }

    private static func control(_ command: String, _ param: DMPBridgeParam, _ env: DMPBridgeEnv,
                                _ callback: DMPBridgeCallback?,
                                action: @escaping (VideoDecoderSession, DMPMap) throws -> [String: Any]) -> DMPAPIResult {
        do {
            guard let id = param.getMap().getString(key: "decoderId") else { throw VideoDecoderError("missing decoderId") }
            let session = try VideoDecoderStore.session(owner: env.appId, id: id)
            session.control(command, callback: callback) { try action(session, param.getMap()) }
        } catch {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "VideoDecoder.\(command):fail \(error.localizedDescription)")
        }
        return DMPNoneResult()
    }
}

private struct VideoDecoderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

enum VideoDecoderStore {
    private static let lock = NSLock()
    private static var sessions: [String: [String: VideoDecoderSession]] = [:]

    fileprivate static func session(owner: String, id: String, create: Bool = false) throws -> VideoDecoderSession {
        lock.lock(); defer { lock.unlock() }
        if let session = sessions[owner]?[id] { return session }
        guard create else { throw VideoDecoderError("decoder is not started") }
        guard (sessions[owner]?.count ?? 0) < 4 else { throw VideoDecoderError("too many VideoDecoders") }
        let session = VideoDecoderSession(owner: owner)
        sessions[owner, default: [:]][id] = session
        return session
    }

    static func remove(owner: String, id: String, complete: @escaping () -> Void) {
        lock.lock(); let session = sessions[owner]?.removeValue(forKey: id); lock.unlock()
        if let session { session.remove(complete: complete) } else { complete() }
    }

    static func dispose(owner: String) {
        lock.lock(); let owned = sessions.removeValue(forKey: owner); lock.unlock()
        owned?.values.forEach { $0.remove() }
    }

    fileprivate static func resolve(_ source: String, owner: String) throws -> URL {
        if let path = DMPFileUtil.sandboxPathFromVPath(from: source, appId: owner) { return URL(fileURLWithPath: path) }
        if let url = URL(string: source), let scheme = url.scheme {
            guard ["http", "https"].contains(scheme.lowercased()), url.host != nil else { throw VideoDecoderError("invalid source") }
            return url
        }
        let root = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(owner), isDirectory: true).resolvingSymlinksInPath()
        let relative = source.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        for candidate in [relative, "main/\(relative)"] {
            let url = root.appendingPathComponent(candidate).resolvingSymlinksInPath()
            if url.path.hasPrefix(root.path + "/"), FileManager.default.fileExists(atPath: url.path) { return url }
        }
        throw VideoDecoderError("file does not exist")
    }
}

fileprivate final class VideoDecoderSession {
    private let owner: String
    private let queue = DispatchQueue(label: "Dimina.VideoDecoder", qos: .userInitiated)
    private let lock = NSLock()
    private var frames: [[String: Any]] = []
    private var removed = false
    private var ended = false
    private var failure: String?
    private var clock: TimeInterval?
    private var clockPts: Double = 0
    private var mode = 1
    // remove() cancels an in-flight download directly, while reader/file teardown
    // stays on queue. A downloaded source remains owned until stop or remove.
    private var downloadTask: URLSessionDownloadTask?
    private var downloadDirectory: URL?
    private var startCancellationGeneration: UInt64 = 0
    private var activeStartGeneration: UInt64 = 0 // confined to queue
    // Reader, output, track and asset are confined to queue.
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var asset: AVURLAsset?
    private var track: AVAssetTrack?

    init(owner: String) { self.owner = owner }

    func control(_ command: String, callback: DMPBridgeCallback?, action: @escaping () throws -> [String: Any]) {
        lock.lock()
        if command == "stop" { startCancellationGeneration &+= 1 }
        let generation = startCancellationGeneration
        let cancelledDownload = command == "stop" ? downloadTask : nil
        queue.async {
            do {
                self.lock.lock()
                let removed = self.removed
                let cancelled = command == "start" && generation != self.startCancellationGeneration
                self.lock.unlock()
                guard !removed else { throw VideoDecoderError("decoder removed") }
                guard !cancelled else { throw VideoDecoderError("start cancelled by stop") }
                if command == "start" { self.activeStartGeneration = generation }
                let result = try action()
                self.lock.lock()
                let invalidated = self.removed || (command == "start" && generation != self.startCancellationGeneration)
                self.lock.unlock()
                guard !invalidated else { throw VideoDecoderError("decoder removed or start cancelled by stop") }
                DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(result.merging(["errMsg": "VideoDecoder.\(command):ok"]) { _, new in new }))
            } catch {
                DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "VideoDecoder.\(command):fail \(error.localizedDescription)")
            }
        }
        lock.unlock()
        cancelledDownload?.cancel()
    }

    func start(url: URL, mode: Int) throws -> [String: Any] {
        guard mode == 0 || mode == 1 else { throw VideoDecoderError("invalid mode") }
        stop()
        do {
            // AVAssetReader needs a local source; an HTTP AVURLAsset can expose
            // tracks yet fail when reading its samples.
            let source = url.isFileURL ? url : try download(url)
            lock.lock(); let cancelled = removed || activeStartGeneration != startCancellationGeneration; lock.unlock()
            guard !cancelled else { throw VideoDecoderError("decoder removed or start cancelled by stop") }
            let asset = AVURLAsset(url: source)
            guard let track = asset.tracks(withMediaType: .video).first else { throw VideoDecoderError("no video track") }
            let width = Int(track.naturalSize.width), height = Int(track.naturalSize.height)
            guard width > 0, height > 0, width <= 4096, height <= 4096, width * height <= 2_097_152 else { throw VideoDecoderError("video frame exceeds pixel budget") }
            self.asset = asset; self.track = track
            lock.lock(); self.mode = mode; lock.unlock()
            try configure(position: 0)
            return ["width": width, "height": height]
        } catch { stop(); throw error }
    }

    private func download(_ url: URL) throws -> URL {
        let directory = URL(fileURLWithPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: owner), isDirectory: true)
            .appendingPathComponent("video-decoder-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        downloadDirectory = directory
        let fileExtension = url.pathExtension.range(of: "^[A-Za-z0-9]{1,16}$", options: .regularExpression) != nil ? ".\(url.pathExtension)" : ""
        let destination = directory.appendingPathComponent("source\(fileExtension)")
        let completion = VideoDecoderDownloadResult()
        let task = URLSession.shared.downloadTask(with: URLRequest(url: url, timeoutInterval: 60)) { temporary, response, error in
            let result: Result<URL, Error>
            if let error {
                result = .failure(error)
            } else if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                result = .failure(VideoDecoderError("http status \(response.statusCode)"))
            } else if let temporary {
                do {
                    // The URLSession temporary file is deleted when this callback returns.
                    try FileManager.default.moveItem(at: temporary, to: destination)
                    result = .success(destination)
                } catch { result = .failure(error) }
            } else {
                result = .failure(VideoDecoderError("empty video response"))
            }
            completion.finish(result)
        }
        lock.lock()
        guard !removed, activeStartGeneration == startCancellationGeneration else {
            lock.unlock(); task.cancel(); throw VideoDecoderError("decoder removed or start cancelled by stop")
        }
        downloadTask = task
        lock.unlock()
        task.resume()
        defer { lock.lock(); downloadTask = nil; lock.unlock() }
        return try completion.wait().get()
    }

    func seek(_ position: Double) throws -> [String: Any] {
        guard position.isFinite, position >= 0, position < Double(Int64.max) / 1000, asset != nil else { throw VideoDecoderError("invalid position or stopped decoder") }
        try configure(position: position)
        return [:]
    }

    private func configure(position: Double) throws {
        reader?.cancelReading()
        reader = nil; output = nil
        lock.lock(); frames.removeAll(); ended = false; failure = nil; clock = nil; lock.unlock()
        guard let asset, let track else { throw VideoDecoderError("decoder is stopped") }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw VideoDecoderError("unsupported video") }
        reader.add(output)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: position / 1000, preferredTimescale: 1_000_000), end: .positiveInfinity)
        guard reader.startReading() else { throw reader.error ?? VideoDecoderError("cannot start decoder") }
        self.reader = reader; self.output = output
        queue.async { self.fill() }
    }

    private func fill() {
        lock.lock(); let canRead = !removed && frames.count < 2; lock.unlock()
        guard canRead, let reader, let output else { return }
        guard let sample = output.copyNextSampleBuffer() else {
            lock.lock()
            ended = reader.status == .completed
            if reader.status == .failed { failure = reader.error?.localizedDescription ?? "decode failed" }
            lock.unlock()
            return
        }
        do {
            guard let image = CMSampleBufferGetImageBuffer(sample) else { throw VideoDecoderError("missing decoded frame") }
            let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
            guard width > 0, height > 0, width <= 4096, height <= 4096, width * height <= 2_097_152 else { throw VideoDecoderError("video frame exceeds pixel budget") }
            guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { throw VideoDecoderError("cannot read decoded frame") }
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(image) else { throw VideoDecoderError("missing decoded pixels") }
            let stride = CVPixelBufferGetBytesPerRow(image)
            var rgba = Data(count: width * height * 4)
            rgba.withUnsafeMutableBytes { raw in
                let destination = raw.bindMemory(to: UInt8.self)
                let source = base.assumingMemoryBound(to: UInt8.self)
                for y in 0..<height { for x in 0..<width {
                    let s = y * stride + x * 4, d = (y * width + x) * 4
                    destination[d] = source[s + 2]; destination[d + 1] = source[s + 1]
                    destination[d + 2] = source[s]; destination[d + 3] = source[s + 3]
                } }
            }
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1_000_000
            let decodeTime = CMSampleBufferGetDecodeTimeStamp(sample)
            var frame: [String: Any] = ["width": width, "height": height, "pts": pts, "pkPts": pts,
                "data": ["__diminaArrayBufferBase64": rgba.base64EncodedString()]]
            if decodeTime.isNumeric {
                let dts = CMTimeGetSeconds(decodeTime) * 1_000_000
                frame["dts"] = dts; frame["pkDts"] = dts
            }
            lock.lock(); if !removed { frames.append(frame) }; lock.unlock()
            queue.async { self.fill() }
        } catch {
            lock.lock(); failure = error.localizedDescription; lock.unlock()
        }
    }

    func frame() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        if removed { return [:] }
        if let failure { return ["error": failure] }
        guard let first = frames.first else { return ["ended": ended] }
        let pts = first["pts"] as? Double ?? 0
        if clock == nil { clock = ProcessInfo.processInfo.systemUptime; clockPts = pts }
        if mode == 0, pts - clockPts > (ProcessInfo.processInfo.systemUptime - clock!) * 1_000_000 { return [:] }
        frames.removeFirst()
        queue.async { self.fill() }
        return first
    }

    func stop() {
        reader?.cancelReading(); reader = nil; output = nil; asset = nil; track = nil
        if let directory = downloadDirectory {
            try? FileManager.default.removeItem(at: directory)
            downloadDirectory = nil
        }
        lock.lock(); frames.removeAll(); ended = false; failure = nil; lock.unlock()
    }

    func remove(complete: @escaping () -> Void = {}) {
        lock.lock(); removed = true; frames.removeAll(); let task = downloadTask; lock.unlock()
        task?.cancel()
        queue.async { self.stop(); complete() }
    }
}

private final class VideoDecoderDownloadResult: @unchecked Sendable {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var result: Result<URL, Error>?

    func finish(_ result: Result<URL, Error>) {
        lock.lock(); self.result = result; lock.unlock()
        completed.signal()
    }

    func wait() -> Result<URL, Error> {
        completed.wait()
        lock.lock(); defer { lock.unlock() }
        return result ?? .failure(VideoDecoderError("missing download result"))
    }
}
