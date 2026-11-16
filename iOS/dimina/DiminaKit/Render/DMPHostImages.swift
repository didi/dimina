import Foundation
import UIKit

/// Host-owned images shared by mini programs through the explicit dimina-image registry.
public enum DMPHostImages {
    private enum Entry {
        case file(URL)
        case directory(URL)
        case image(UIImage)
    }

    private static let lock = NSLock()
    private static var entries: [String: Entry] = [:]
    static let resourcePath = "/__dimina_host_images/"
    private static let extensions = ["png", "jpg", "jpeg", "webp", "svg", "gif", "bmp", "ico", "avif"]

    public static func register(_ id: String, fileURL: URL) throws {
        try validateID(id)
        try validateFile(fileURL)
        set(.file(fileURL), for: id)
    }

    /// Pass a Bundle resource directory URL to expose its image files recursively.
    public static func registerDirectory(_ id: String, directoryURL: URL) throws {
        try validateID(id)
        guard directoryURL.isFileURL,
              try directoryURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw failure("Image directory is not readable")
        }
        set(.directory(directoryURL.resolvingSymlinksInPath().standardizedFileURL), for: id)
    }

    /// For compiled asset catalogs; encodes PNG in memory when requested, without writing a file.
    public static func registerImage(_ id: String, image: UIImage) throws {
        try validateID(id)
        set(.image(image), for: id)
    }

    public static func unregister(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        entries.removeValue(forKey: id)
    }

    private static func set(_ entry: Entry, for id: String) {
        lock.lock()
        defer { lock.unlock() }
        entries[id] = entry
    }

    static func load(_ key: String) throws -> DMPWebResourcePayload {
        let parts = key.components(separatedBy: "/")
        try validateID(parts[0])
        guard validRelativePath(key) else { throw failure("Invalid host image path") }
        lock.lock()
        let entry = entries[parts[0]]
        lock.unlock()
        guard let entry else { throw failure("Host image is not registered", code: 404) }
        switch entry {
        case let .file(url):
            guard parts.count == 1 else { throw failure("Image is not a directory") }
            try validateFile(url)
            return try DMPWebResourceLoader.load(path: url.path)
        case let .directory(root):
            guard parts.count > 1 else { throw failure("Missing image path") }
            let relative = parts.dropFirst().joined(separator: "/")
            let url = root.appendingPathComponent(relative).resolvingSymlinksInPath().standardizedFileURL
            let prefix = root.path == "/" ? "/" : root.path + "/"
            guard url.path.hasPrefix(prefix) else { throw failure("Image is outside registered directory") }
            try validateFile(url)
            return try DMPWebResourceLoader.load(path: url.path)
        case let .image(image):
            guard parts.count == 1, let data = image.pngData() else { throw failure("Unable to encode host image") }
            return DMPWebResourcePayload(data: data, mimeType: "image/png")
        }
    }

    private static func validateID(_ id: String) throws {
        guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else {
            throw failure("Invalid host image ID")
        }
    }

    private static func validRelativePath(_ path: String) -> Bool {
        path.components(separatedBy: "/").allSatisfy { part in
            !part.isEmpty && part != "." && part != ".." && !part.contains { "\\%?#".contains($0) }
                && !part.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
        }
    }

    private static func validateFile(_ url: URL) throws {
        guard url.isFileURL, extensions.contains(url.pathExtension.lowercased()),
              try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              FileManager.default.isReadableFile(atPath: url.path) else {
            throw failure("Unsupported or unreadable image file")
        }
    }

    private static func failure(_ message: String, code: Int = 400) -> NSError {
        NSError(domain: "DiminaHostImages", code: code, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
