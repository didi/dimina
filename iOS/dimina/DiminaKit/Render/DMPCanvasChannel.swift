import Foundation
import WebKit

final class DMPCanvasResources {
    private struct Entry { let owner: ObjectIdentifier; let data: Data; let deadline: Date }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]

    func store(_ data: Data, for view: WKWebView) throws -> String {
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { $0.value.deadline > Date() }
        guard entries.count < 64, entries.values.reduce(data.count, { $0 + $1.data.count }) <= 64 * 1024 * 1024 else {
            throw NSError(domain: "Canvas resource budget exceeded", code: 1)
        }
        let token = UUID().uuidString
        entries[token] = Entry(owner: ObjectIdentifier(view), data: data, deadline: Date().addingTimeInterval(5))
        return "dimina:///__canvas_packet/\(token)"
    }

    func take(_ url: URL, for view: WKWebView) -> Data? {
        lock.lock(); defer { lock.unlock() }
        let token = url.lastPathComponent
        guard let entry = entries[token], entry.owner == ObjectIdentifier(view) else { return nil }
        entries.removeValue(forKey: token)
        return entry.deadline > Date() ? entry.data : nil
    }

    func clear(for view: WKWebView) {
        lock.lock(); defer { lock.unlock() }
        entries = entries.filter { $0.value.owner != ObjectIdentifier(view) }
    }
}

// Main-thread FIFO shared by scripts and binary packets. Awaiting resource I/O
// must never let a following query overtake an earlier texture publication.
final class DMPCanvasChannel {
    private struct Job {
        let id = UUID()
        let bytes: Int
        var timeout = false
        var terminal = false
        let run: (@escaping (Any?, Error?) -> Void) -> Void
        let complete: (Any?, Error?) -> Void
    }
    private weak var view: WKWebView?
    private var jobs: [Job] = []
    private var active = false
    private var queuedBytes = 0
    private var generation = UUID()
    private let lock = NSLock()
    private var ready = false
    private var failure: Error?
    private var probing = false
    var isReady: Bool { lock.lock(); defer { lock.unlock() }; return ready }
    var error: Error? { lock.lock(); defer { lock.unlock() }; return failure }

    init(view: WKWebView) { self.view = view }

    private func setReady(_ value: Bool) { lock.lock(); ready = value; lock.unlock() }
    private var resources: DMPCanvasResources? {
        (view?.configuration.urlSchemeHandler(forURLScheme: "dimina") as? DiminaURLSchemeHandler)?.canvasResources
    }

    func execute(_ script: String, completion: ((Any?, Error?) -> Void)?) {
        submit(Job(bytes: script.utf8.count, run: { [weak self] done in
            guard let view = self?.view else { done(nil, Self.closed); return }
            view.evaluateJavaScript(script, completionHandler: done)
        }, complete: completion ?? { _, _ in }))
    }

    func packet(_ data: Data, admitted: ((Error?) -> Void)? = nil, completion: @escaping (Any?, Error?) -> Void) {
        var notified = false
        let accept: (Error?) -> Void = { error in
            guard !notified else { return }
            notified = true; admitted?(error)
        }
        guard isReady else { accept(Self.closed); completion(nil, Self.closed); return }
        submit(Job(bytes: data.count, timeout: true, terminal: true, run: { [weak self] done in
            guard let self, let view = self.view, let resources = self.resources else { done(nil, Self.closed); return }
            do {
                let url = try resources.store(data, for: view)
                view.callAsyncJavaScript("return await globalThis.__diminaCanvasResource(url)", arguments: ["url": url], in: nil, in: .page) {
                    switch $0 { case .success(let value): done(value, nil); case .failure(let error): done(nil, error) }
                }
            } catch { done(nil, error) }
        }, complete: { value, error in accept(error); completion(value, error) }))
        // Keep small uploads pipelined. When the window fills, only the
        // Service thread waits for execution; WebKit's main thread stays free.
        if jobs.count < 32 && queuedBytes < 8 * 1024 * 1024 { accept(nil) }
    }

    func probe() {
        guard !isReady, !probing, resources != nil else { return }
        probing = true
        let expected = generation
        submit(Job(bytes: 4, timeout: true, run: { [weak self] done in
            guard let self, let view = self.view, let resources = self.resources else { done(nil, Self.closed); return }
            do {
                let url = try resources.store(Data([1, 2, 3, 4]), for: view)
                view.callAsyncJavaScript("if(typeof globalThis.__diminaCanvasResource!=='function')return false; const b=new Uint8Array(await (await fetch(url)).arrayBuffer());return b.length===4&&b[0]===1&&b[3]===4", arguments: ["url": url], in: nil, in: .page) {
                    switch $0 { case .success(let value): done(value, nil); case .failure(let error): done(nil, error) }
                }
            } catch { done(nil, error) }
        }, complete: { [weak self] value, error in
            guard let self, self.generation == expected else { return }
            self.setReady(error == nil && value as? Bool == true)
        }))
    }

    private func submit(_ job: Job) {
        if let error { job.complete(nil, error); return }
        guard jobs.count < 256, queuedBytes + job.bytes <= 64 * 1024 * 1024 else {
            job.complete(nil, Self.closed); invalidate(Self.closed); return
        }
        jobs.append(job); queuedBytes += job.bytes
        drain()
    }

    private func drain() {
        guard !active, let job = jobs.first else { return }
        active = true
        let expected = generation
        job.run { [weak self] value, error in
            guard let self, self.generation == expected else { return }
            if job.terminal, let error { self.invalidate(error); return }
            self.jobs.removeFirst(); self.queuedBytes -= job.bytes; self.active = false
            job.complete(value, error)
            self.drain()
        }
        guard job.timeout else { return }
        let jobID = job.id
        let terminal = job.terminal
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.generation == expected, self.active,
                  self.jobs.first?.id == jobID else { return }
            self.invalidate(terminal ? Self.closed : nil)
        }
    }

    func close() { invalidate(nil) }

    private func invalidate(_ error: Error?) {
        lock.lock(); failure = error; lock.unlock()
        generation = UUID(); setReady(false); probing = false
        let pending = jobs; jobs.removeAll(); queuedBytes = 0; active = false
        if let view { resources?.clear(for: view) }
        view?.evaluateJavaScript("globalThis.__diminaCanvasResource?.cancel?.()", completionHandler: nil)
        for job in pending { job.complete(nil, Self.closed) }
    }
    private static let closed = NSError(domain: "Canvas channel unavailable or timed out", code: 1)
}
