//
//  CanvasImageLoader.swift
//  dimina
//
//  Image download + decode helper for native GL canvas.
//  Handles imageSetSrc ops: downloads images via URL, decodes to RGBA pixels,
//  and uploads to the native GL canvas. Equivalent of Android's CanvasImageLoader.kt.
//

import Foundation
import UIKit

class CanvasImageLoader {
    static let shared = CanvasImageLoader()

    /// Registry of active NativeCanvasGLView instances by nodeId
    private var glViews: [String: NativeCanvasGLView] = [:]

    /// Weak reference to engine for scheduling JS callbacks
    private weak var engine: DMPEngine?

    private init() {}

    func setEngine(_ engine: DMPEngine) {
        self.engine = engine
    }

    func registerView(nodeId: String, view: NativeCanvasGLView) {
        glViews[nodeId] = view
    }

    func unregisterView(nodeId: String) {
        glViews.removeValue(forKey: nodeId)
    }

    /// Handle an imageSetSrc request from DMPEngineCanvas.
    /// Downloads the image on a background queue, decodes to RGBA pixels,
    /// and uploads to the GL canvas via dm_canvas_load_image_rgba.
    func handleImageSetSrc(engine: DMPEngine, nodeId: String, imageId: String,
                           src: String, onload: String, onerror: String) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            self.downloadAndDecode(src: src) { result in
                switch result {
                case .success(let (rgba, width, height)):
                    // Upload on the JS thread (which owns the EGL context)
                    engine.performOnJSThreadInternal { [weak self] in
                        guard let self = self, let view = self.glViews[nodeId] else {
                            DMPLogger.debug("CanvasImageLoader: no GLView for nodeId=\(nodeId)")
                            return
                        }

                        // Direct upload via C API on JS/GL thread
                        if let canvas = view.getCanvasHandle() {
                            rgba.withUnsafeBytes { rawBuf in
                                guard let ptr = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                                let rc = dm_canvas_load_image_rgba(canvas, imageId, Int32(width), Int32(height), ptr)
                                if rc == 0 && !onload.isEmpty {
                                    let argsJson = "{\"width\":\(width),\"height\":\(height)}"
                                    self.invokeCallback(engine: engine, callbackId: onload, argsJson: argsJson)
                                    DMPLogger.debug("CanvasImageLoader: uploaded \(imageId) \(width)x\(height)")
                                } else if rc != 0 {
                                    DMPLogger.debug("CanvasImageLoader: upload failed \(imageId)")
                                    if !onerror.isEmpty {
                                        self.invokeCallback(engine: engine, callbackId: onerror,
                                                          argsJson: "{\"errMsg\":\"createImage:fail upload error\"}")
                                    }
                                }
                            }
                        }
                    }

                case .failure(let error):
                    DMPLogger.debug("CanvasImageLoader: decode failed src=\(src) error=\(error)")
                    if !onerror.isEmpty {
                        engine.enqueueScript("""
                            (function(){
                                var cb=globalThis.__dimina_callback_registry;
                                if(cb&&cb.invoke)cb.invoke('\(onerror)',{"errMsg":"createImage:fail \(error.localizedDescription)"});
                            })()
                            """)
                    }
                }
            }
        }
    }

    // MARK: - Private

    private func downloadAndDecode(src: String, completion: @escaping (Result<(Data, Int, Int), Error>) -> Void) {
        if src.hasPrefix("http://") || src.hasPrefix("https://") {
            guard let url = URL(string: src) else {
                completion(.failure(NSError(domain: "CanvasImageLoader", code: -1,
                                           userInfo: [NSLocalizedDescriptionKey: "Invalid URL"])))
                return
            }

            URLSession.shared.dataTask(with: url) { data, _, error in
                if let error = error {
                    completion(.failure(error))
                    return
                }
                guard let data = data, let image = UIImage(data: data) else {
                    completion(.failure(NSError(domain: "CanvasImageLoader", code: -2,
                                               userInfo: [NSLocalizedDescriptionKey: "Decode failed"])))
                    return
                }
                if let rgba = self.imageToRGBA(image) {
                    completion(.success(rgba))
                } else {
                    completion(.failure(NSError(domain: "CanvasImageLoader", code: -3,
                                               userInfo: [NSLocalizedDescriptionKey: "RGBA conversion failed"])))
                }
            }.resume()
        } else {
            // Local file
            guard let image = UIImage(contentsOfFile: src) else {
                completion(.failure(NSError(domain: "CanvasImageLoader", code: -4,
                                           userInfo: [NSLocalizedDescriptionKey: "File not found: \(src)"])))
                return
            }
            if let rgba = imageToRGBA(image) {
                completion(.success(rgba))
            } else {
                completion(.failure(NSError(domain: "CanvasImageLoader", code: -5,
                                           userInfo: [NSLocalizedDescriptionKey: "RGBA conversion failed"])))
            }
        }
    }

    /// Convert UIImage to raw RGBA pixel data.
    private func imageToRGBA(_ image: UIImage) -> (Data, Int, Int)? {
        guard let cgImage = image.cgImage else { return nil }

        let width = cgImage.width
        let height = cgImage.height
        let bytesPerRow = width * 4

        var rgbaData = Data(count: height * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        guard let context = rgbaData.withUnsafeMutableBytes({ rawBuf -> CGContext? in
            CGContext(data: rawBuf.baseAddress, width: width, height: height,
                      bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                      space: colorSpace,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        }) else { return nil }

        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

        return (rgbaData, width, height)
    }

    /// Invoke a JS callback via the dimina callback registry
    private func invokeCallback(engine: DMPEngine, callbackId: String, argsJson: String) {
        let script = """
            (function(){
                var cb=globalThis.__dimina_callback_registry;
                if(cb&&cb.invoke)cb.invoke('\(callbackId)',\(argsJson));
            })()
            """
        engine.enqueueScript(script)
    }
}
