import Foundation

/// Host-owned resources, activated per mini program only by wx.loadFontFace.
public enum DMPHostFonts {
    private static let lock = NSLock()
    private static var files: [String: URL] = [:]
    static let resourcePath = "/__dimina_host_fonts/"

    public static func register(_ id: String, fileURL: URL) throws {
        guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil,
              fileURL.isFileURL,
              ["ttf", "otf", "woff", "woff2"].contains(fileURL.pathExtension.lowercased()),
              try fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              FileManager.default.isReadableFile(atPath: fileURL.path) else {
            throw NSError(domain: "DiminaHostFonts", code: 400,
                          userInfo: [NSLocalizedDescriptionKey: "Invalid font ID or unreadable font file"])
        }
        lock.lock()
        defer { lock.unlock() }
        files[id] = fileURL
    }

    /// Does not remove fonts already loaded into an existing document.
    public static func unregister(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        files.removeValue(forKey: id)
    }

    static func load(_ id: String) throws -> DMPWebResourcePayload {
        lock.lock()
        let url = files[id]
        lock.unlock()
        guard let url else {
            throw NSError(domain: "DiminaHostFonts", code: 404,
                          userInfo: [NSLocalizedDescriptionKey: "Host font is not registered"])
        }
        return try DMPWebResourceLoader.load(path: url.path)
    }
}
