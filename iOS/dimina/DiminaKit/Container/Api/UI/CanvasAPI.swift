//
//  CanvasAPI.swift
//  dimina
//

import Foundation

/**
 * UI - Canvas API
 *
 * Canvas drawing runs in the render WebView. The container persists the
 * exported data URL and returns a Dimina virtual path to the mini program.
 */
public final class CanvasAPI: DMPContainerApi {
    private static let SAVE_CANVAS_TEMP_FILE = "saveCanvasTempFile"

    @BridgeMethod(SAVE_CANVAS_TEMP_FILE)
    var saveCanvasTempFile: DMPBridgeMethodHandler = { param, env, callback in
        let map = param.getMap()
        guard let dataURL = map.getString(key: "dataURL"), !dataURL.isEmpty else {
            return CanvasAPI.failure(callback, message: "dataURL is empty")
        }

        guard let imageData = CanvasAPI.decodeImageDataURL(dataURL) else {
            return CanvasAPI.failure(callback, message: "dataURL is invalid")
        }

        let fileExtension = CanvasAPI.normalizedFileExtension(map.getString(key: "fileType"))
        let directoryPath = DMPSandboxManager.appTmpResourceDirectoryPath(appId: env.appId)
        let fileName = "canvas_\(UUID().uuidString.lowercased()).\(fileExtension)"
        let filePath = (directoryPath as NSString).appendingPathComponent(fileName)

        do {
            try FileManager.default.createDirectory(
                atPath: directoryPath,
                withIntermediateDirectories: true,
                attributes: nil
            )
            try imageData.write(to: URL(fileURLWithPath: filePath), options: .atomic)
        } catch {
            try? FileManager.default.removeItem(atPath: filePath)
            return CanvasAPI.failure(callback, message: error.localizedDescription)
        }

        let result = DMPMap()
        result.set(
            "tempFilePath",
            DMPFileUtil.vPathFromSandboxPath(sandboxPath: filePath, appId: env.appId)
        )
        result.set("errMsg", "canvasToTempFilePath:ok")
        DMPContainerApi.invokeSuccess(callback: callback, param: result)
        return DMPAsyncResult()
    }

    private static func decodeImageDataURL(_ dataURL: String) -> Data? {
        guard let separatorIndex = dataURL.firstIndex(of: ",") else {
            return nil
        }

        let header = dataURL[..<separatorIndex].lowercased()
        guard header.hasPrefix("data:image/"), header.hasSuffix(";base64") else {
            return nil
        }

        let encodedData = String(dataURL[dataURL.index(after: separatorIndex)...])
        guard !encodedData.isEmpty else {
            return nil
        }
        return Data(base64Encoded: encodedData)
    }

    private static func normalizedFileExtension(_ fileType: String?) -> String {
        switch fileType?.lowercased() {
        case "jpg", "jpeg":
            return "jpg"
        default:
            return "png"
        }
    }

    private static func failure(
        _ callback: DMPBridgeCallback?,
        message: String
    ) -> DMPAPIResult {
        DMPContainerApi.invokeFailure(
            callback: callback,
            param: nil,
            errMsg: "canvasToTempFilePath:fail \(message)"
        )
        return DMPAsyncResult()
    }
}
