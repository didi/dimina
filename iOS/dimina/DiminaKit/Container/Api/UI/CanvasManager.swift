//
//  CanvasManager.swift
//  dimina
//

import Foundation
import UIKit

class CanvasManager {
    static let shared = CanvasManager()

    // componentId → NativeCanvasView
    private var canvasViews: [String: NativeCanvasView] = [:]
    // contextId → componentId
    private var contextIdMap: [String: String] = [:]
    // resourceId → gradient/pattern etc.
    private var resources: [String: Any] = [:]
    // imageId → UIImage
    private var images: [String: UIImage] = [:]

    private init() {}

    // MARK: - Registration

    func register(_ componentId: String, _ view: NativeCanvasView) {
        canvasViews[componentId] = view
    }

    func unregister(_ componentId: String) {
        canvasViews.removeValue(forKey: componentId)
        contextIdMap = contextIdMap.filter { $0.value != componentId }
    }

    // MARK: - Message Interception

    static func shouldIntercept(_ msg: String) -> Bool {
        return msg.contains("\"canvasNodeFlush\"") ||
            msg.contains("\"canvasNodeRequestAnimationFrame\"") ||
            msg.contains("\"canvasNodeToDataURL\"") ||
            msg.contains("\"canvasNodeToTempFilePath\"")
    }

    // MARK: - Message Handling

    func handleMessage(_ msg: String, app: DMPApp?) {
        guard let data = msg.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let body = json["body"] as? [String: Any],
              let name = body["name"] as? String,
              let params = body["params"] as? [String: Any] else {
            return
        }

        let bridgeId = body["bridgeId"]

        switch name {
        case "canvasNodeFlush":
            handleFlush(params: params, app: app, bridgeId: bridgeId)
        case "canvasNodeRequestAnimationFrame":
            handleRequestAnimationFrame(params: params, app: app, bridgeId: bridgeId)
        case "canvasNodeToDataURL":
            handleToDataURL(params: params, app: app, bridgeId: bridgeId)
        case "canvasNodeToTempFilePath":
            handleToTempFilePath(params: params, app: app, bridgeId: bridgeId)
        default:
            break
        }
    }

    // MARK: - Flush

    private func handleFlush(params: [String: Any], app: DMPApp?, bridgeId: Any?) {
        guard let nodeId = params["nodeId"] as? String, !nodeId.isEmpty,
              let operations = params["operations"] as? [[String: Any]] else {
            return
        }

        guard let view = canvasViews[nodeId] else {
            return
        }

        for operation in operations {
            executeOperation(view: view, operation: operation, app: app, bridgeId: bridgeId, nodeId: nodeId)
        }

        DispatchQueue.main.async {
            view.flush()
        }
    }

    // MARK: - RequestAnimationFrame

    private func handleRequestAnimationFrame(params: [String: Any], app: DMPApp?, bridgeId: Any?) {
        guard let callbackId = params["callback"] as? String, !callbackId.isEmpty else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self] in
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            self?.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId, args: timestamp)
        }
    }

    // MARK: - ToDataURL

    private func handleToDataURL(params: [String: Any], app: DMPApp?, bridgeId: Any?) {
        let nodeId = params["nodeId"] as? String ?? ""
        let callbackId = params["callback"] as? String ?? ""

        guard !callbackId.isEmpty else { return }

        guard let view = canvasViews[nodeId] else {
            triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                            args: ["errMsg": "toDataURL:fail canvas not found"])
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            let mimeType = params["type"] as? String ?? "image/png"
            guard let image = view.renderToImage() else {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["errMsg": "toDataURL:fail render failed"])
                return
            }

            let data: Data?
            if mimeType == "image/jpeg" {
                let quality = params["quality"] as? Double ?? 0.92
                data = image.jpegData(compressionQuality: CGFloat(quality))
            } else {
                data = image.pngData()
            }

            guard let imageData = data else {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["errMsg": "toDataURL:fail encode failed"])
                return
            }

            let base64 = imageData.base64EncodedString()
            let dataUrl = "data:\(mimeType);base64,\(base64)"
            self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                 args: ["dataUrl": dataUrl])
        }
    }

    // MARK: - ToTempFilePath

    private func handleToTempFilePath(params: [String: Any], app: DMPApp?, bridgeId: Any?) {
        let nodeId = params["nodeId"] as? String ?? ""
        let callbackId = params["callback"] as? String ?? ""

        guard !callbackId.isEmpty else { return }

        guard let view = canvasViews[nodeId] else {
            triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                            args: ["errMsg": "canvasToTempFilePath:fail canvas not found"])
            return
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let image = view.renderToImage() else {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["errMsg": "canvasToTempFilePath:fail render failed"])
                return
            }

            let fileType = params["fileType"] as? String ?? "png"
            let quality = params["quality"] as? Double ?? 1.0
            let data: Data?
            let ext: String
            if fileType == "jpg" {
                data = image.jpegData(compressionQuality: CGFloat(quality))
                ext = "jpg"
            } else {
                data = image.pngData()
                ext = "png"
            }

            guard let imageData = data else {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["errMsg": "canvasToTempFilePath:fail encode failed"])
                return
            }

            let fileName = "canvas_\(Int(Date().timeIntervalSince1970 * 1000)).\(ext)"
            let filePath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)

            do {
                try imageData.write(to: URL(fileURLWithPath: filePath))
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["tempFilePath": filePath])
            } catch {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: callbackId,
                                     args: ["errMsg": "canvasToTempFilePath:fail \(error.localizedDescription)"])
            }
        }
    }

    // MARK: - Operation Execution

    private func executeOperation(view: NativeCanvasView, operation: [String: Any],
                                  app: DMPApp?, bridgeId: Any?, nodeId: String) {
        guard let op = operation["op"] as? String else { return }

        switch op {
        case "getContext":
            if let contextId = operation["contextId"] as? String, !contextId.isEmpty {
                contextIdMap[contextId] = nodeId
            }

        case "contextSetProperty":
            let prop = operation["prop"] as? String ?? ""
            let value = resolveArg(operation["value"])
            DispatchQueue.main.async {
                view.setProperty(prop, value)
            }

        case "contextCall":
            let method = operation["method"] as? String ?? ""
            let rawArgs = operation["args"] as? [Any] ?? []
            let args = rawArgs.map { resolveArg($0) }
            let resultId = operation["resultId"] as? String
            DispatchQueue.main.async { [weak self] in
                let result = view.callMethod(method, args)
                if let resultId = resultId, !resultId.isEmpty, result != nil {
                    self?.resources[resultId] = result
                }
            }

        case "resourceCall":
            let resourceId = operation["resourceId"] as? String ?? ""
            guard let resource = resources[resourceId] else { return }
            let method = operation["method"] as? String ?? ""
            let rawArgs = operation["args"] as? [Any] ?? []
            let args = rawArgs.map { resolveArg($0) }

            if let gradient = resource as? CanvasGradient, method == "addColorStop" {
                let offset = asCGFloat(args[safe: 0])
                let color = parseCanvasColor(args[safe: 1])
                gradient.addColorStop(offset, color)
            }

        case "setCanvasProperty":
            let prop = operation["prop"] as? String ?? ""
            let value = asCGFloat(operation["value"])
            DispatchQueue.main.async {
                if prop == "width" {
                    view.jsCanvasWidth = value
                } else if prop == "height" {
                    view.jsCanvasHeight = value
                }
            }

        case "createImage":
            // Will be handled when imageSetSrc is called
            break

        case "imageSetSrc":
            let imageId = operation["imageId"] as? String ?? ""
            let src = operation["src"] as? String ?? ""
            let onload = operation["onload"] as? String
            let onerror = operation["onerror"] as? String
            handleImageSetSrc(imageId: imageId, src: src, onload: onload, onerror: onerror,
                              app: app, bridgeId: bridgeId)

        default:
            break
        }
    }

    // MARK: - Argument Resolution

    private func resolveArg(_ value: Any?) -> Any? {
        guard let value = value else { return nil }

        if let array = value as? [Any] {
            return array.map { resolveArg($0) }
        }

        if let dict = value as? [String: Any] {
            // Resource reference
            if let resourceId = dict["__canvasResourceId"] as? String {
                if let resource = resources[resourceId] { return resource }
                if let image = images[resourceId] { return image }
                return value
            }

            // Image reference
            if let imageId = dict["__canvasImageId"] as? String {
                if let image = images[imageId] { return image }
                return value
            }

            // Typed array reconstruction — not needed for CGContext, pass as-is
            if dict["__canvasTypedArray"] != nil {
                if let data = dict["data"] as? [Any] {
                    return data.compactMap { ($0 as? NSNumber)?.doubleValue }
                }
                return value
            }

            return value
        }

        return value
    }

    // MARK: - Image Loading

    private func handleImageSetSrc(imageId: String, src: String, onload: String?, onerror: String?,
                                   app: DMPApp?, bridgeId: Any?) {
        if src.hasPrefix("http://") || src.hasPrefix("https://") {
            loadNetworkImage(imageId: imageId, src: src, onload: onload, onerror: onerror,
                             app: app, bridgeId: bridgeId)
        } else {
            loadLocalImage(imageId: imageId, src: src, onload: onload, onerror: onerror,
                           app: app, bridgeId: bridgeId)
        }
    }

    private func loadLocalImage(imageId: String, src: String, onload: String?, onerror: String?,
                                app: DMPApp?, bridgeId: Any?) {
        guard let image = UIImage(contentsOfFile: src) else {
            if let onerror = onerror {
                triggerCallback(app: app, bridgeId: bridgeId, callbackId: onerror,
                                args: ["errMsg": "createImage:fail \(src)"])
            }
            return
        }
        images[imageId] = image
        if let onload = onload {
            triggerCallback(app: app, bridgeId: bridgeId, callbackId: onload,
                            args: ["width": Int(image.size.width), "height": Int(image.size.height)])
        }
    }

    private func loadNetworkImage(imageId: String, src: String, onload: String?, onerror: String?,
                                  app: DMPApp?, bridgeId: Any?) {
        guard let url = URL(string: src) else {
            if let onerror = onerror {
                triggerCallback(app: app, bridgeId: bridgeId, callbackId: onerror,
                                args: ["errMsg": "createImage:fail invalid url \(src)"])
            }
            return
        }

        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                if let onerror = onerror {
                    self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: onerror,
                                         args: ["errMsg": "createImage:fail \(error.localizedDescription)"])
                }
                return
            }

            guard let data = data, let image = UIImage(data: data) else {
                if let onerror = onerror {
                    self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: onerror,
                                         args: ["errMsg": "createImage:fail decode error \(src)"])
                }
                return
            }

            self.images[imageId] = image
            if let onload = onload {
                self.triggerCallback(app: app, bridgeId: bridgeId, callbackId: onload,
                                     args: ["width": Int(image.size.width), "height": Int(image.size.height)])
            }
        }.resume()
    }

    // MARK: - Callback

    private func triggerCallback(app: DMPApp?, bridgeId: Any?, callbackId: String, args: Any) {
        var bodyDict: [String: Any] = [
            "id": callbackId,
            "args": args,
        ]
        if let bridgeId = bridgeId {
            bodyDict["bridgeId"] = bridgeId
        }
        let msg = DMPMap([
            "type": "triggerCallback",
            "body": bodyDict,
        ])
        DMPChannelProxy.containerToService(msg: msg, app: app)
    }
}

// MARK: - Private Utility

private func asCGFloat(_ value: Any?) -> CGFloat {
    switch value {
    case let n as NSNumber: return CGFloat(n.doubleValue)
    case let d as Double: return CGFloat(d)
    case let f as Float: return CGFloat(f)
    case let i as Int: return CGFloat(i)
    case let s as String: return CGFloat(Double(s) ?? 0)
    default: return 0
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        return indices.contains(index) ? self[index] : nil
    }
}
