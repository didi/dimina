import Foundation
import CommonCrypto
import Compression
import ZIPFoundation

public class FileAPI: DMPContainerApi {
    private static let SAVE_FILE_TO_DISK = "saveFileToDisk"
    private static let PREFIX = "FileSystemManager."
    private static let VIRTUAL_PREFIX = "difile://"
    private static let USER_PREFIX = "usr"
    private static let TEMP_PREFIX = "tmp"
    private static let ARRAY_BUFFER_BASE64_KEY = "__diminaArrayBufferBase64"
    private static let FILE_DATA_BASE64_KEY = "__diminaFileDataBase64"
    private static let FILE_DATA_TYPE_KEY = "__diminaFileDataType"

    private struct OpenFile {
        let handle: FileHandle
        let path: String
    }

    private struct ZipEntryRequest {
        let path: String
        let encoding: String
        let position: Int
        let length: Int?
    }

    private static var openFiles: [String: OpenFile] = [:]

    @BridgeMethod(SAVE_FILE_TO_DISK)
    var saveFileToDisk: DMPBridgeMethodHandler = { param, env, callback in
        FileAPI.fail(name: SAVE_FILE_TO_DISK, message: "not supported on this platform", callback: callback)
    }

    @BridgeMethod(PREFIX + "access")
    var access: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "access", param: param, env: env, callback: callback) {
        _ = try FileAPI.resolve(env: env, path: FileAPI.pathParam(param.getMap()))
        return [:]
    }}

    @BridgeMethod(PREFIX + "accessSync")
    var accessSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        let file = try FileAPI.resolve(env: env, path: FileAPI.stringParam(param, key: "path"))
        guard FileManager.default.fileExists(atPath: file.path) else { throw FileError.message("no such file or directory") }
        return nil
    }}

    @BridgeMethod(PREFIX + "appendFile")
    var appendFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "appendFile", param: param, env: env, callback: callback) {
        try FileAPI.appendFileSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "appendFileSync")
    var appendFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.appendFileSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "close")
    var close: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "close", param: param, env: env, callback: callback) {
        try FileAPI.closeSync(param: param)
        return [:]
    }}

    @BridgeMethod(PREFIX + "closeSync")
    var closeSync: DMPBridgeMethodHandler = { param, _, _ in FileAPI.sync {
        try FileAPI.closeSync(param: param)
        return nil
    }}

    @BridgeMethod(PREFIX + "copyFile")
    var copyFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "copyFile", param: param, env: env, callback: callback) {
        try FileAPI.copyFileSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "copyFileSync")
    var copyFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.copyFileSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "fstat")
    var fstat: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "fstat", param: param, env: env, callback: callback) {
        ["stats": try FileAPI.fstatSync(param: param)]
    }}

    @BridgeMethod(PREFIX + "fstatSync")
    var fstatSync: DMPBridgeMethodHandler = { param, _, _ in FileAPI.sync { try FileAPI.fstatSync(param: param) }}

    @BridgeMethod(PREFIX + "ftruncate")
    var ftruncate: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "ftruncate", param: param, env: env, callback: callback) {
        try FileAPI.ftruncateSync(param: param)
        return [:]
    }}

    @BridgeMethod(PREFIX + "ftruncateSync")
    var ftruncateSync: DMPBridgeMethodHandler = { param, _, _ in FileAPI.sync {
        try FileAPI.ftruncateSync(param: param)
        return nil
    }}

    @BridgeMethod(PREFIX + "getFileInfo")
    var getFileInfo: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "getFileInfo", param: param, env: env, callback: callback) {
        try FileAPI.getFileInfo(param: param, env: env)
    }}

    @BridgeMethod(PREFIX + "getSavedFileList")
    var getSavedFileList: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "getSavedFileList", param: param, env: env, callback: callback) {
        ["fileList": FileAPI.savedFiles(env: env)]
    }}

    @BridgeMethod(PREFIX + "mkdir")
    var mkdir: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "mkdir", param: param, env: env, callback: callback) {
        try FileAPI.mkdirSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "mkdirSync")
    var mkdirSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.mkdirSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "open")
    var open: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "open", param: param, env: env, callback: callback) {
        ["fd": try FileAPI.openSync(param: param, env: env)]
    }}

    @BridgeMethod(PREFIX + "openSync")
    var openSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync { try FileAPI.openSync(param: param, env: env) }}

    @BridgeMethod(PREFIX + "read")
    var read: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "read", param: param, env: env, callback: callback) {
        try FileAPI.readSync(param: param)
    }}

    @BridgeMethod(PREFIX + "readSync")
    var readSync: DMPBridgeMethodHandler = { param, _, _ in FileAPI.sync { try FileAPI.readSync(param: param) }}

    @BridgeMethod(PREFIX + "readCompressedFile")
    var readCompressedFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "readCompressedFile", param: param, env: env, callback: callback) {
        ["data": try FileAPI.readCompressedFileSync(param: param, env: env)]
    }}

    @BridgeMethod(PREFIX + "readCompressedFileSync")
    var readCompressedFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync { try FileAPI.readCompressedFileSync(param: param, env: env) }}

    @BridgeMethod(PREFIX + "readdir")
    var readdir: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "readdir", param: param, env: env, callback: callback) {
        ["files": try FileAPI.readdirSync(path: FileAPI.pathParam(param.getMap()), env: env)]
    }}

    @BridgeMethod(PREFIX + "readdirSync")
    var readdirSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.readdirSync(path: FileAPI.stringParam(param, key: "dirPath"), env: env)
    }}

    @BridgeMethod(PREFIX + "readFile")
    var readFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "readFile", param: param, env: env, callback: callback) {
        ["data": try FileAPI.readFileSync(param: param, env: env)]
    }}

    @BridgeMethod(PREFIX + "readFileSync")
    var readFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync { try FileAPI.readFileSync(param: param, env: env) }}

    @BridgeMethod(PREFIX + "readZipEntry")
    var readZipEntry: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "readZipEntry", param: param, env: env, callback: callback) {
        try FileAPI.readZipEntry(param: param, env: env)
    }}

    @BridgeMethod(PREFIX + "removeSavedFile")
    var removeSavedFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "removeSavedFile", param: param, env: env, callback: callback) {
        try FileAPI.unlink(path: FileAPI.pathParam(param.getMap()), env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "rename")
    var rename: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "rename", param: param, env: env, callback: callback) {
        try FileAPI.renameSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "renameSync")
    var renameSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.renameSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "rmdir")
    var rmdir: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "rmdir", param: param, env: env, callback: callback) {
        try FileAPI.rmdirSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "rmdirSync")
    var rmdirSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.rmdirSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "saveFile")
    var saveFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "saveFile", param: param, env: env, callback: callback) {
        ["savedFilePath": try FileAPI.saveFileSync(param: param, env: env)]
    }}

    @BridgeMethod(PREFIX + "saveFileSync")
    var saveFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync { try FileAPI.saveFileSync(param: param, env: env) }}

    @BridgeMethod(PREFIX + "stat")
    var stat: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "stat", param: param, env: env, callback: callback) {
        ["stats": try FileAPI.statSync(param: param, env: env)]
    }}

    @BridgeMethod(PREFIX + "statSync")
    var statSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync { try FileAPI.statSync(param: param, env: env) }}

    @BridgeMethod(PREFIX + "truncate")
    var truncate: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "truncate", param: param, env: env, callback: callback) {
        try FileAPI.truncateSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "truncateSync")
    var truncateSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.truncateSync(param: param, env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "unlink")
    var unlink: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "unlink", param: param, env: env, callback: callback) {
        try FileAPI.unlink(path: FileAPI.pathParam(param.getMap()), env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "unlinkSync")
    var unlinkSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.unlink(path: FileAPI.stringParam(param, key: "filePath"), env: env)
        return nil
    }}

    @BridgeMethod(PREFIX + "unzip")
    var unzip: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "unzip", param: param, env: env, callback: callback) {
        try FileAPI.unzip(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "write")
    var write: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "write", param: param, env: env, callback: callback) {
        try FileAPI.writeSync(param: param)
    }}

    @BridgeMethod(PREFIX + "writeSync")
    var writeSync: DMPBridgeMethodHandler = { param, _, _ in FileAPI.sync { try FileAPI.writeSync(param: param) }}

    @BridgeMethod(PREFIX + "writeFile")
    var writeFile: DMPBridgeMethodHandler = { param, env, callback in FileAPI.async(name: PREFIX + "writeFile", param: param, env: env, callback: callback) {
        try FileAPI.writeFileSync(param: param, env: env)
        return [:]
    }}

    @BridgeMethod(PREFIX + "writeFileSync")
    var writeFileSync: DMPBridgeMethodHandler = { param, env, _ in FileAPI.sync {
        try FileAPI.writeFileSync(param: param, env: env)
        return nil
    }}

    private enum FileError: Error {
        case message(String)
    }

    private static func async(name: String, param: DMPBridgeParam, env: DMPBridgeEnv, callback: DMPBridgeCallback?, block: () throws -> [String: Any]) -> DMPAPIResult {
        do {
            var result = try block()
            result["errMsg"] = "\(name):ok"
            DMPContainerApi.invokeSuccess(callback: callback, param: DMPMap(result))
        } catch {
            DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(name):fail \(message(error))")
        }
        return DMPAsyncResult()
    }

    private static func fail(name: String, message: String, callback: DMPBridgeCallback?) -> DMPAPIResult {
        DMPContainerApi.invokeFailure(callback: callback, param: nil, errMsg: "\(name):fail \(message)")
        return DMPAsyncResult()
    }

    private static func sync(block: () throws -> Any?) -> DMPAPIResult {
        do {
            return DMPSyncResult(try block())
        } catch {
            return DMPSyncResult(["errMsg": "fail \(message(error))"])
        }
    }

    private static func message(_ error: Error) -> String {
        if case let FileError.message(text) = error {
            return text
        }
        return error.localizedDescription
    }

    private static func root(env: DMPBridgeEnv, user: Bool) -> String {
        let path = user ? DMPSandboxManager.appStoreResourceDirectoryPath(appId: env.appId) : DMPSandboxManager.appTmpResourceDirectoryPath(appId: env.appId)
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: nil)
        return path
    }

    private static func resolve(env: DMPBridgeEnv, path rawPath: String) throws -> URL {
        guard !rawPath.isEmpty else { throw FileError.message("missing file path") }
        let url: URL
        if rawPath.hasPrefix(VIRTUAL_PREFIX) {
            let relative = rawPath.replacingOccurrences(of: VIRTUAL_PREFIX, with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if relative == USER_PREFIX || relative.hasPrefix(USER_PREFIX + "/") {
                url = URL(fileURLWithPath: root(env: env, user: true)).appendingPathComponent(String(relative.dropFirst(USER_PREFIX.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            } else if relative == TEMP_PREFIX || relative.hasPrefix(TEMP_PREFIX + "/") {
                url = URL(fileURLWithPath: root(env: env, user: false)).appendingPathComponent(String(relative.dropFirst(TEMP_PREFIX.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            } else {
                url = URL(fileURLWithPath: root(env: env, user: false)).appendingPathComponent(relative)
            }
        } else {
            url = URL(fileURLWithPath: rawPath)
        }

        let standardized = url.standardizedFileURL
        let allowed = [root(env: env, user: true), root(env: env, user: false)].map { URL(fileURLWithPath: $0).standardizedFileURL.path }
        guard allowed.contains(where: { standardized.path == $0 || standardized.path.hasPrefix($0 + "/") }) else {
            throw FileError.message("permission denied, open \(rawPath)")
        }
        return standardized
    }

    private static func pathParam(_ map: DMPMap) -> String {
        return map.getString(key: "path") ?? map.getString(key: "filePath") ?? map.getString(key: "dirPath") ?? map.getString(key: "args") ?? ""
    }

    private static func stringParam(_ param: DMPBridgeParam, key: String) -> String {
        if let value = param.getValue() as? String { return value }
        let map = param.getMap()
        return map.getString(key: key) ?? pathParam(map)
    }

    private static func bytes(param: DMPBridgeParam, key: String = "data") -> Data {
        let map = param.getMap()
        if let encoded = map.get(key) as? [String: Any],
           encoded[FILE_DATA_TYPE_KEY] as? String == "base64",
           let base64 = encoded[FILE_DATA_BASE64_KEY] as? String,
           let data = Data(base64Encoded: base64) {
            return data
        }
        if let string = map.get(key) as? String {
            if (map.getString(key: "encoding") ?? "").lowercased() == "base64", let data = Data(base64Encoded: string) {
                return data
            }
            return Data(string.utf8)
        }
        return Data()
    }

    private static func bufferPayload(_ data: Data) -> [String: Any] {
        [ARRAY_BUFFER_BASE64_KEY: data.base64EncodedString()]
    }

    private static func userPath(env: DMPBridgeEnv, url: URL) -> String {
        let rootPath = URL(fileURLWithPath: root(env: env, user: true)).standardizedFileURL.path
        let relative = url.standardizedFileURL.path.replacingOccurrences(of: rootPath, with: "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return "\(VIRTUAL_PREFIX)\(USER_PREFIX)/\(relative)"
    }

    private static func appendFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let map = param.getMap()
        let url = try resolve(env: env, path: map.getString(key: "filePath") ?? "")
        guard FileManager.default.fileExists(atPath: url.path) else { throw FileError.message("no such file or directory, open \(url.path)") }
        let handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
        handle.write(bytes(param: param))
        try handle.close()
    }

    private static func copyFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let map = param.getMap()
        let src = try resolve(env: env, path: map.getString(key: "srcPath") ?? "")
        let dest = try resolve(env: env, path: map.getString(key: "destPath") ?? "")
        if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
        try FileManager.default.copyItem(at: src, to: dest)
    }

    private static func mkdirSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let map = param.getMap()
        try FileManager.default.createDirectory(at: try resolve(env: env, path: map.getString(key: "dirPath") ?? ""), withIntermediateDirectories: map.getBool(key: "recursive") ?? false, attributes: nil)
    }

    private static func writeFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let url = try resolve(env: env, path: param.getMap().getString(key: "filePath") ?? "")
        try bytes(param: param).write(to: url)
    }

    private static func readFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> Any {
        let map = param.getMap()
        let data = try Data(contentsOf: try resolve(env: env, path: map.getString(key: "filePath") ?? ""))
        let position = map.getInt(key: "position") ?? 0
        let length = map.getInt(key: "length") ?? (data.count - position)
        let slice = slice(data, position: position, length: length)
        if let encoding = map.getString(key: "encoding"), !encoding.isEmpty {
            return decode(data: slice, encoding: encoding)
        }
        return bufferPayload(slice)
    }

    private static func readdirSync(path: String, env: DMPBridgeEnv) throws -> [String] {
        try FileManager.default.contentsOfDirectory(atPath: resolve(env: env, path: path).path)
    }

    private static func unlink(path: String, env: DMPBridgeEnv) throws {
        try FileManager.default.removeItem(at: try resolve(env: env, path: path))
    }

    private static func renameSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let map = param.getMap()
        try FileManager.default.moveItem(at: try resolve(env: env, path: map.getString(key: "oldPath") ?? ""), to: try resolve(env: env, path: map.getString(key: "newPath") ?? ""))
    }

    private static func rmdirSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        try FileManager.default.removeItem(at: try resolve(env: env, path: param.getMap().getString(key: "dirPath") ?? ""))
    }

    private static func truncateSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let handle = try FileHandle(forUpdating: resolve(env: env, path: param.getMap().getString(key: "filePath") ?? ""))
        try handle.truncate(atOffset: UInt64(param.getMap().getInt(key: "length") ?? 0))
        try handle.close()
    }

    private static func openSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> String {
        let map = param.getMap()
        let url = try resolve(env: env, path: map.getString(key: "filePath") ?? "")
        let flag = map.getString(key: "flag") ?? "r"
        if flag.contains("w") || flag.contains("a") {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        let handle = try FileHandle(forUpdating: url)
        if flag == "w" || flag == "w+" { try handle.truncate(atOffset: 0) }
        if flag.hasPrefix("a") { try handle.seekToEnd() }
        let fd = UUID().uuidString
        openFiles[fd] = OpenFile(handle: handle, path: url.path)
        return fd
    }

    private static func opened(_ param: DMPBridgeParam) throws -> OpenFile {
        let fd = param.getMap().getString(key: "fd") ?? stringParam(param, key: "fd")
        guard let file = openFiles[fd] else { throw FileError.message("bad file descriptor") }
        return file
    }

    private static func closeSync(param: DMPBridgeParam) throws {
        let fd = param.getMap().getString(key: "fd") ?? stringParam(param, key: "fd")
        guard let file = openFiles.removeValue(forKey: fd) else { throw FileError.message("bad file descriptor") }
        try file.handle.close()
    }

    private static func readSync(param: DMPBridgeParam) throws -> [String: Any] {
        let file = try opened(param)
        let map = param.getMap()
        if let position = map.getInt(key: "position") { try file.handle.seek(toOffset: UInt64(position)) }
        let length = map.getInt(key: "length") ?? map.getInt(key: "arrayBufferLength") ?? Int.max
        let data = try file.handle.read(upToCount: length) ?? Data()
        return ["bytesRead": data.count, ARRAY_BUFFER_BASE64_KEY: data.base64EncodedString()]
    }

    private static func writeSync(param: DMPBridgeParam) throws -> [String: Any] {
        let file = try opened(param)
        let map = param.getMap()
        if let position = map.getInt(key: "position") { try file.handle.seek(toOffset: UInt64(position)) }
        let key = map.get("arrayBuffer") != nil ? "arrayBuffer" : "data"
        let data = bytes(param: param, key: key)
        file.handle.write(data)
        return ["bytesWritten": data.count]
    }

    private static func fstatSync(param: DMPBridgeParam) throws -> [String: Any] {
        try stat(path: opened(param).path)
    }

    private static func ftruncateSync(param: DMPBridgeParam) throws {
        try opened(param).handle.truncate(atOffset: UInt64(param.getMap().getInt(key: "length") ?? 0))
    }

    private static func saveFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> String {
        let map = param.getMap()
        let temp = try resolve(env: env, path: map.getString(key: "tempFilePath") ?? "")
        let dest = try resolve(env: env, path: map.getString(key: "filePath") ?? "\(VIRTUAL_PREFIX)\(USER_PREFIX)/saved/\(Int(Date().timeIntervalSince1970))_\(temp.lastPathComponent)")
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: nil)
        if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
        try FileManager.default.moveItem(at: temp, to: dest)
        return userPath(env: env, url: dest)
    }

    private static func savedFiles(env: DMPBridgeEnv) -> [[String: Any]] {
        let saved = URL(fileURLWithPath: root(env: env, user: true)).appendingPathComponent("saved")
        guard let enumerator = FileManager.default.enumerator(at: saved, includingPropertiesForKeys: nil) else { return [] }
        return enumerator.compactMap { item in
            guard let url = item as? URL, let attrs = try? FileManager.default.attributesOfItem(atPath: url.path), attrs[.type] as? FileAttributeType == .typeRegular else { return nil }
            return ["filePath": userPath(env: env, url: url), "size": attrs[.size] as? Int ?? 0, "createTime": Int((attrs[.modificationDate] as? Date ?? Date()).timeIntervalSince1970)]
        }
    }

    private static func getFileInfo(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> [String: Any] {
        let map = param.getMap()
        let data = try Data(contentsOf: resolve(env: env, path: map.getString(key: "filePath") ?? ""))
        let algorithm = (map.getString(key: "digestAlgorithm") ?? "md5").lowercased()
        let digest = algorithm == "sha1" ? InsecureDigest.sha1(data) : InsecureDigest.md5(data)
        return ["size": data.count, "digest": digest]
    }

    private static func statSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> Any {
        let map = param.getMap()
        let path = map.getString(key: "path") ?? map.getString(key: "args") ?? ""
        let url = try resolve(env: env, path: path)
        if !(map.getBool(key: "recursive") ?? false) {
            return try stat(path: url.path)
        }
        guard let enumerator = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { return try stat(path: url.path) }
        var result: [String: Any] = [".": try stat(path: url.path)]
        for item in enumerator {
            guard let child = item as? URL else { continue }
            result[child.path.replacingOccurrences(of: url.path + "/", with: "")] = try stat(path: child.path)
        }
        return result
    }

    private static func stat(path: String) throws -> [String: Any] {
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        let type = attrs[.type] as? FileAttributeType
        let isDir = type == .typeDirectory
        let modified = Int((attrs[.modificationDate] as? Date ?? Date()).timeIntervalSince1970)
        return ["mode": isDir ? "directory" : "file", "size": attrs[.size] as? Int ?? 0, "lastAccessedTime": modified, "lastModifiedTime": modified, "isDirectory": isDir, "isFile": type == .typeRegular]
    }

    private static func unzip(param: DMPBridgeParam, env: DMPBridgeEnv) throws {
        let map = param.getMap()
        try FileManager.default.unzipItem(at: resolve(env: env, path: map.getString(key: "zipFilePath") ?? ""), to: resolve(env: env, path: map.getString(key: "targetPath") ?? ""))
    }

    private static func readZipEntry(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> [String: Any] {
        let map = param.getMap()
        let archive = try Archive(url: resolve(env: env, path: map.getString(key: "filePath") ?? ""), accessMode: .read)
        var entries: [String: Any] = [:]
        let requests = zipEntryRequests(param: param, archive: archive)
        for request in requests {
            guard let entry = archive[request.path], entry.type == .file else {
                entries[request.path] = ["errMsg": "\(PREFIX)readZipEntry:fail no such entry \(request.path)"]
                continue
            }
            var data = Data()
            _ = try archive.extract(entry) { data.append($0) }
            let sliced = slice(data, position: request.position, length: request.length)
            let entryData: Any = request.encoding.isEmpty ? bufferPayload(sliced) : decode(data: sliced, encoding: request.encoding)
            entries[request.path] = [
                "data": entryData,
                "errMsg": "\(PREFIX)readZipEntry:ok"
            ]
        }
        return ["entries": entries]
    }

    private static func readCompressedFileSync(param: DMPBridgeParam, env: DMPBridgeEnv) throws -> [String: Any] {
        let map = param.getMap()
        let algorithm = (map.getString(key: "compressionAlgorithm") ?? "").lowercased()
        if algorithm != "br" {
            throw FileError.message("unsupported compressionAlgorithm \(algorithm)")
        }
        let data = try Data(contentsOf: resolve(env: env, path: map.getString(key: "filePath") ?? ""))
        return bufferPayload(try decompressBrotli(data))
    }

    private static func decompressBrotli(_ data: Data) throws -> Data {
        guard !data.isEmpty else {
            throw FileError.message("brotli decompress fail")
        }

        let scratch = UnsafeMutablePointer<UInt8>.allocate(capacity: 1)
        defer { scratch.deallocate() }
        var stream = compression_stream(
            dst_ptr: scratch,
            dst_size: 0,
            src_ptr: UnsafePointer(scratch),
            src_size: 0,
            state: nil
        )
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_BROTLI) != COMPRESSION_STATUS_ERROR else {
            throw FileError.message("brotli decompress fail")
        }
        defer { compression_stream_destroy(&stream) }

        let chunkSize = 64 * 1024
        var output = Data()
        let status = data.withUnsafeBytes { rawBuffer -> compression_status in
            guard let input = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
                return COMPRESSION_STATUS_ERROR
            }

            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkSize)
            defer { buffer.deallocate() }

            stream.src_ptr = input
            stream.src_size = data.count

            while true {
                stream.dst_ptr = buffer
                stream.dst_size = chunkSize

                let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let written = chunkSize - stream.dst_size
                if written > 0 {
                    output.append(buffer, count: written)
                }

                switch status {
                case COMPRESSION_STATUS_OK:
                    continue
                case COMPRESSION_STATUS_END:
                    return status
                default:
                    return COMPRESSION_STATUS_ERROR
                }
            }
        }

        guard status == COMPRESSION_STATUS_END else {
            throw FileError.message("brotli decompress fail")
        }
        return output
    }

    private static func zipEntryRequests(param: DMPBridgeParam, archive: Archive) -> [ZipEntryRequest] {
        let map = param.getMap()
        if let rawEntries = map.get("entries") as? [[String: Any]] {
            return rawEntries.compactMap { item in
                guard let path = item["path"] as? String, !path.isEmpty else { return nil }
                return ZipEntryRequest(
                    path: path,
                    encoding: item["encoding"] as? String ?? "",
                    position: intValue(item["position"]) ?? 0,
                    length: intValue(item["length"])
                )
            }
        }
        if let rawEntries = map.get("entries") as? [String] {
            return rawEntries.map { ZipEntryRequest(path: $0, encoding: "", position: 0, length: nil) }
        }
        let encoding = map.getString(key: "encoding") ?? ""
        return archive.filter { $0.type == .file }.map { ZipEntryRequest(path: $0.path, encoding: encoding, position: 0, length: nil) }
    }

    private static func slice(_ data: Data, position: Int, length: Int?) -> Data {
        let start = min(max(position, 0), data.count)
        let end = min(start + max(length ?? data.count - start, 0), data.count)
        return data.subdata(in: start..<end)
    }

    private static func decode(data: Data, encoding: String) -> String {
        switch encoding.lowercased() {
        case "base64":
            return data.base64EncodedString()
        case "hex":
            return data.map { String(format: "%02x", $0) }.joined()
        default:
            return String(data: data, encoding: .utf8) ?? ""
        }
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value) }
        return nil
    }
}

private enum InsecureDigest {
    static func md5(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_MD5_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_MD5(buffer.baseAddress, CC_LONG(data.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func sha1(_ data: Data) -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_SHA1_DIGEST_LENGTH))
        data.withUnsafeBytes { buffer in
            _ = CC_SHA1(buffer.baseAddress, CC_LONG(data.count), &digest)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
