import Foundation
import UIKit
import UniformTypeIdentifiers

private enum DMPMessageFileError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        }
    }
}

private final class DMPMessageFilePickerCoordinator: NSObject, UIDocumentPickerDelegate {
    private static var active: DMPMessageFilePickerCoordinator?

    private let completion: (Result<[URL], Error>) -> Void

    init(completion: @escaping (Result<[URL], Error>) -> Void) {
        self.completion = completion
    }

    static func present(
        picker: UIDocumentPickerViewController,
        from viewController: UIViewController,
        completion: @escaping (Result<[URL], Error>) -> Void
    ) -> Bool {
        guard active == nil else { return false }
        let coordinator = DMPMessageFilePickerCoordinator(completion: completion)
        active = coordinator
        picker.delegate = coordinator
        viewController.present(picker, animated: true)
        return true
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(.success(urls))
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(.failure(DMPMessageFileError.message("cancel")))
    }

    private func finish(_ result: Result<[URL], Error>) {
        guard Self.active === self else { return }
        Self.active = nil
        completion(result)
    }
}

public final class MessageFileAPI: DMPContainerApi {
    private static let chooseMessageFileName = "chooseMessageFile"
    private static let supportedTypes = Set(["all", "image", "video", "file"])
    private static let imageExtensions = Set([
        "apng", "avif", "bmp", "gif", "heic", "heif", "ico", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp",
    ])
    private static let videoExtensions = Set([
        "3g2", "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "ogv", "ts", "webm", "wmv",
    ])

    @BridgeMethod(chooseMessageFileName)
    var chooseMessageFile: DMPBridgeMethodHandler = { param, env, callback in
        let values = param.getMap()
        guard let countNumber = values["count"] as? NSNumber,
              CFGetTypeID(countNumber) != CFBooleanGetTypeID(),
              countNumber.doubleValue.rounded(.towardZero) == countNumber.doubleValue,
              (0...100).contains(countNumber.intValue) else {
            MessageFileAPI.fail(callback: callback, message: "invalid count")
            return DMPAsyncResult()
        }
        let count = countNumber.intValue

        let requestedType = values["type"] as? String ?? "all"
        guard supportedTypes.contains(requestedType) else {
            MessageFileAPI.fail(callback: callback, message: "invalid type")
            return DMPAsyncResult()
        }

        if requestedType == "file", values["extension"] != nil, !(values["extension"] is [String]) {
            MessageFileAPI.fail(callback: callback, message: "invalid extension")
            return DMPAsyncResult()
        }
        let rawExtensions = requestedType == "file" ? (values["extension"] as? [String] ?? []) : []
        let extensions = rawExtensions.map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
                .lowercased()
        }
        guard !extensions.contains(where: { $0.isEmpty }) else {
            MessageFileAPI.fail(callback: callback, message: "invalid extension")
            return DMPAsyncResult()
        }

        if count == 0 {
            MessageFileAPI.succeed(callback: callback, tempFiles: [])
            return DMPAsyncResult()
        }

        DispatchQueue.main.async {
            guard let presenter = DMPUIManager.getCurrentWindow()?.rootViewController?.topMostViewController() else {
                MessageFileAPI.fail(callback: callback, message: "cannot find view controller")
                return
            }

            let picker = UIDocumentPickerViewController(
                forOpeningContentTypes: MessageFileAPI.pickerTypes(requestedType: requestedType, extensions: extensions),
                asCopy: false
            )
            picker.allowsMultipleSelection = count > 1

            let presented = DMPMessageFilePickerCoordinator.present(picker: picker, from: presenter) { result in
                switch result {
                case .failure(let error):
                    MessageFileAPI.fail(callback: callback, message: error.localizedDescription)
                case .success(let urls):
                    DispatchQueue.global(qos: .userInitiated).async {
                        let processed = MessageFileAPI.copySelectedFiles(
                            Array(urls.prefix(count)),
                            appId: env.appId,
                            requestedType: requestedType,
                            extensions: Set(extensions)
                        )
                        DispatchQueue.main.async {
                            switch processed {
                            case .success(let tempFiles): MessageFileAPI.succeed(callback: callback, tempFiles: tempFiles)
                            case .failure(let error): MessageFileAPI.fail(callback: callback, message: error.localizedDescription)
                            }
                        }
                    }
                }
            }
            if !presented {
                MessageFileAPI.fail(callback: callback, message: "picker is busy")
            }
        }

        return DMPAsyncResult()
    }

    private static func pickerTypes(requestedType: String, extensions: [String]) -> [UTType] {
        switch requestedType {
        case "image": return [.image]
        case "video": return [.movie]
        case "file" where !extensions.isEmpty:
            let types = extensions.compactMap { UTType(filenameExtension: $0) }
            return types.isEmpty ? [.item] : types
        default: return [.item]
        }
    }

    private static func copySelectedFiles(
        _ urls: [URL],
        appId: String,
        requestedType: String,
        extensions: Set<String>
    ) -> Result<[[String: Any]], Error> {
        var copiedURLs: [URL] = []
        do {
            let directory = URL(fileURLWithPath: DMPSandboxManager.appTmpResourceDirectoryPath(appId: appId), isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

            var tempFiles: [[String: Any]] = []
            for url in urls {
                let accessed = url.startAccessingSecurityScopedResource()
                defer {
                    if accessed { url.stopAccessingSecurityScopedResource() }
                }

                let resourceValues = try? url.resourceValues(forKeys: [.contentTypeKey, .contentModificationDateKey])
                let name = url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent
                let actualType = fileType(contentType: resourceValues?.contentType, name: name)
                let extensionValue = url.pathExtension.lowercased()
                let accepted = requestedType == "all"
                    || (requestedType == actualType
                        && (requestedType != "file" || extensions.isEmpty || extensions.contains(extensionValue)))
                if !accepted { continue }

                var destination = directory.appendingPathComponent(UUID().uuidString)
                let suffix = String(url.pathExtension.prefix(20))
                if !suffix.isEmpty {
                    destination.appendPathExtension(suffix)
                }
                try FileManager.default.copyItem(at: url, to: destination)
                copiedURLs.append(destination)

                let attributes = try FileManager.default.attributesOfItem(atPath: destination.path)
                let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
                let time = Int((resourceValues?.contentModificationDate ?? Date()).timeIntervalSince1970)
                tempFiles.append([
                    "name": name,
                    "path": DMPFileUtil.vPathFromSandboxPath(sandboxPath: destination.path, appId: appId),
                    "size": size,
                    "time": time,
                    "type": actualType,
                ])
            }

            guard !tempFiles.isEmpty else {
                throw DMPMessageFileError.message("no supported file selected")
            }
            return .success(tempFiles)
        } catch {
            copiedURLs.forEach { try? FileManager.default.removeItem(at: $0) }
            return .failure(error)
        }
    }

    private static func fileType(contentType: UTType?, name: String) -> String {
        if contentType?.conforms(to: .image) == true { return "image" }
        if contentType?.conforms(to: .video) == true || contentType?.conforms(to: .movie) == true { return "video" }
        let extensionValue = (name as NSString).pathExtension.lowercased()
        if imageExtensions.contains(extensionValue) { return "image" }
        if videoExtensions.contains(extensionValue) { return "video" }
        return "file"
    }

    private static func succeed(callback: DMPBridgeCallback?, tempFiles: [[String: Any]]) {
        let result = DMPMap([
            "tempFiles": tempFiles,
            "errMsg": "\(chooseMessageFileName):ok",
        ])
        DMPContainerApi.invokeSuccess(callback: callback, param: result, completeCarriesResult: true)
    }

    private static func fail(callback: DMPBridgeCallback?, message: String) {
        let errMsg = "\(chooseMessageFileName):fail \(message)"
        DMPContainerApi.invokeFailure(
            callback: callback,
            param: DMPMap(["errMsg": errMsg]),
            errMsg: errMsg,
            completeCarriesResult: true
        )
    }
}
