//
//  DMPEngineCanvas.swift
//  dimina
//
//  Canvas 2D bindings for JavaScriptCore — iOS equivalent of Android's canvas_bindings.cpp.
//  Registers __GLCanvas native functions on JSContext and manages per-canvas state
//  (op buffering, deferred rendering, image uploads, op history for replay).
//

import Foundation
import JavaScriptCore

class DMPEngineCanvas {

    // MARK: - Per-canvas State

    class CanvasState {
        let nodeId: String
        var opQueue: [String] = []          // JSON ops for current frame
        var glCanvas: OpaquePointer? = nil  // DMCanvasRef
        var glInitialized = false
        var pendingOpsJson: [String] = []   // buffered before GL ready
        var swapScheduled = false
        var opHistory: [String] = []
        var opHistoryComplete = true
        static let opHistoryMax = 10000
        // Pending image uploads
        var pendingImageUploads: [(imageId: String, rgba: Data, width: Int, height: Int, callbackId: String)] = []

        init(nodeId: String) {
            self.nodeId = nodeId
        }
    }

    private var canvasStates: [String: CanvasState] = [:]
    private weak var engine: DMPEngine?

    // MARK: - Registration

    func register(to context: JSContext, engine: DMPEngine) {
        self.engine = engine

        // Set __GLCanvas.available = true
        context.evaluateScript("globalThis.__GLCanvas = { available: true };")

        // _createCanvas(nodeId, width, height)
        let createCanvas: @convention(block) (String, Int, Int) -> Void = { [weak self] nodeId, width, height in
            guard let self = self else { return }
            if let existing = self.canvasStates[nodeId] {
                existing.opQueue.removeAll()
                DMPLogger.debug("DMPEngineCanvas: _createCanvas reusing nodeId=\(nodeId)")
            } else {
                let state = CanvasState(nodeId: nodeId)
                self.canvasStates[nodeId] = state
                DMPLogger.debug("DMPEngineCanvas: _createCanvas nodeId=\(nodeId) \(width)x\(height)")
            }
        }

        // _destroyCanvas(nodeId)
        let destroyCanvas: @convention(block) (String) -> Void = { [weak self] nodeId in
            guard let self = self else { return }
            if let state = self.canvasStates.removeValue(forKey: nodeId) {
                if let canvas = state.glCanvas {
                    dm_canvas_destroy(canvas)
                }
                DMPLogger.debug("DMPEngineCanvas: _destroyCanvas nodeId=\(nodeId)")
            }
        }

        // _bufferOp(nodeId, opJSON)
        let bufferOp: @convention(block) (String, JSValue) -> Void = { [weak self] nodeId, opObj in
            guard let self = self, let state = self.canvasStates[nodeId] else { return }

            // Intercept imageSetSrc for GL path
            if self.handleImageSetSrcGL(state: state, opObj: opObj) {
                return
            }

            // Serialize op to JSON: {"nodeId":"...","operations":[<op>]}
            guard let opJson = self.serializeOp(nodeId: nodeId, opObj: opObj, context: context) else {
                return
            }

            if state.glCanvas != nil {
                state.opQueue.append(opJson)
                self.scheduleDeferredSwap(state: state)
            } else {
                state.pendingOpsJson.append(opJson)
            }
        }

        // _flush(nodeId) — no-op for compatibility
        let flush: @convention(block) (String) -> Void = { _ in }

        // _syncOp(nodeId, paramsObj) — synchronous canvas operation
        let syncOp: @convention(block) (String, JSValue) -> JSValue = { [weak self] nodeId, params in
            guard let self = self,
                  let state = self.canvasStates[nodeId],
                  let canvas = state.glCanvas,
                  state.glInitialized else {
                return JSValue(undefinedIn: context)
            }

            // Determine sync type
            let name = params.objectForKeyedSubscript("name")?.toString() ?? ""

            // Flush queued ops first so FBO reflects all prior draws
            if !state.opQueue.isEmpty {
                dm_canvas_begin_frame(canvas)
                for op in state.opQueue {
                    op.withCString { cStr in
                        dm_canvas_execute_ops(canvas, cStr, Int32(op.utf8.count))
                    }
                }
                state.opQueue.removeAll()
                dm_canvas_end_frame(canvas)
            }

            var resultCStr: UnsafeMutablePointer<CChar>? = nil

            if name == "canvasGetImageDataSync" || name == "canvasGetImageData" {
                let x = params.objectForKeyedSubscript("x")?.toInt32() ?? 0
                let y = params.objectForKeyedSubscript("y")?.toInt32() ?? 0
                let w = params.objectForKeyedSubscript("width")?.toInt32() ?? 0
                let h = params.objectForKeyedSubscript("height")?.toInt32() ?? 0
                resultCStr = dm_canvas_get_image_data(canvas, x, y, w, h)
            } else if name == "canvasToDataURLSync" {
                let mime = params.objectForKeyedSubscript("type")?.toString() ?? "image/png"
                let quality = params.objectForKeyedSubscript("quality")?.toDouble() ?? 0.92
                resultCStr = dm_canvas_to_data_url(canvas, mime, quality)

                // toDataURL returns raw string — wrap as {dataUrl: "..."}
                if let cStr = resultCStr {
                    let dataUrl = String(cString: cStr)
                    dm_canvas_free_string(cStr)
                    let result = JSValue(newObjectIn: context)
                    result?.setObject(dataUrl, forKeyedSubscript: "dataUrl" as NSString)
                    return result ?? JSValue(undefinedIn: context)
                }
                return JSValue(undefinedIn: context)
            } else if name == "canvasMeasureText" {
                let text = params.objectForKeyedSubscript("text")?.toString() ?? ""
                let font = params.objectForKeyedSubscript("font")?.toString() ?? "10px sans-serif"
                resultCStr = dm_canvas_measure_text(canvas, text, font)
            }

            if let cStr = resultCStr {
                let jsonStr = String(cString: cStr)
                dm_canvas_free_string(cStr)
                // Parse JSON result
                if let data = jsonStr.data(using: .utf8),
                   let jsonObj = try? JSONSerialization.jsonObject(with: data) {
                    return JSValue(object: jsonObj, in: context)
                }
            }

            return JSValue(undefinedIn: context)
        }

        // _render(nodeId) — deferred callback: execute all queued ops in one frame, then swap
        let render: @convention(block) (String) -> Void = { [weak self] nodeId in
            guard let self = self, let state = self.canvasStates[nodeId] else { return }
            state.swapScheduled = false

            guard let canvas = state.glCanvas, state.glInitialized else {
                if !state.opQueue.isEmpty || !state.pendingOpsJson.isEmpty {
                    self.scheduleDeferredSwap(state: state)
                }
                return
            }

            if !state.opQueue.isEmpty {
                dm_canvas_begin_frame(canvas)
                for op in state.opQueue {
                    op.withCString { cStr in
                        dm_canvas_execute_ops(canvas, cStr, Int32(op.utf8.count))
                    }

                    // Record in history for replay on surface rebind
                    if state.opHistoryComplete {
                        if state.opHistory.count < CanvasState.opHistoryMax {
                            state.opHistory.append(op)
                        } else {
                            state.opHistoryComplete = false
                        }
                    }
                }
                state.opQueue.removeAll()
                dm_canvas_end_frame(canvas)
                dm_canvas_swap_buffers(canvas)
            }
        }

        // _replayPendingOps(nodeId) — called after GL surface binds
        let replayPendingOps: @convention(block) (String) -> Void = { [weak self] nodeId in
            guard let self = self, let state = self.canvasStates[nodeId] else { return }

            guard let canvas = state.glCanvas else { return }

            // Replay op history to restore previous content on a new surface
            if state.glInitialized && !state.opHistory.isEmpty && state.opHistoryComplete {
                dm_canvas_reset_for_replay(canvas)
                dm_canvas_begin_frame(canvas)
                for op in state.opHistory {
                    op.withCString { cStr in
                        dm_canvas_execute_ops(canvas, cStr, Int32(op.utf8.count))
                    }
                }
                dm_canvas_end_frame(canvas)
                dm_canvas_swap_buffers(canvas)
            }

            // Move pending ops to the front of opQueue
            if state.glInitialized && !state.pendingOpsJson.isEmpty {
                state.opQueue.insert(contentsOf: state.pendingOpsJson, at: 0)
                state.pendingOpsJson.removeAll()
                self.scheduleDeferredSwap(state: state)
            }

            // Process pending image uploads
            if state.glInitialized && !state.pendingImageUploads.isEmpty {
                self.engine?.enqueueScript(
                    "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._uploadPendingImages)" +
                    "__GLCanvas._uploadPendingImages('\(nodeId)')")
            }
        }

        // _uploadPendingImages(nodeId)
        let uploadPendingImages: @convention(block) (String) -> Void = { [weak self] nodeId in
            guard let self = self, let state = self.canvasStates[nodeId] else { return }

            let uploads = state.pendingImageUploads
            state.pendingImageUploads.removeAll()

            guard let canvas = state.glCanvas, state.glInitialized, !uploads.isEmpty else {
                if !uploads.isEmpty {
                    state.pendingImageUploads.insert(contentsOf: uploads, at: 0)
                }
                return
            }

            for img in uploads {
                img.rgba.withUnsafeBytes { rawBuf in
                    guard let ptr = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                    let rc = dm_canvas_load_image_rgba(canvas, img.imageId, Int32(img.width), Int32(img.height), ptr)
                    if rc == 0 && !img.callbackId.isEmpty {
                        let argsJson = "{\"width\":\(img.width),\"height\":\(img.height)}"
                        self.invokeCallback(callbackId: img.callbackId, argsJson: argsJson)
                    }
                }
            }
        }

        // _putImageData(nodeId, dataBase64, dataW, dataH, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)
        let putImageData: @convention(block) (String, JSValue, Int, Int, Int, Int, Int, Int, Int, Int) -> Void =
        { [weak self] nodeId, dataVal, dataW, dataH, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH in
            guard let self = self, let state = self.canvasStates[nodeId],
                  let canvas = state.glCanvas, state.glInitialized else { return }

            // Flush queued ops first
            if !state.opQueue.isEmpty {
                dm_canvas_begin_frame(canvas)
                for op in state.opQueue {
                    op.withCString { cStr in
                        dm_canvas_execute_ops(canvas, cStr, Int32(op.utf8.count))
                    }
                }
                state.opQueue.removeAll()
                dm_canvas_end_frame(canvas)
            }

            // Extract pixel data — expect an array of numbers from JS
            guard let dataArray = dataVal.toArray() as? [NSNumber] else { return }
            var pixels = [UInt8](repeating: 0, count: dataArray.count)
            for i in 0..<dataArray.count {
                pixels[i] = dataArray[i].uint8Value
            }

            pixels.withUnsafeBufferPointer { buf in
                dm_canvas_put_image_data(canvas, buf.baseAddress, Int32(dataW), Int32(dataH),
                                          Int32(dx), Int32(dy),
                                          Int32(dirtyX), Int32(dirtyY), Int32(dirtyW), Int32(dirtyH))
            }
        }

        // Register all functions on __GLCanvas
        let glCanvas = context.objectForKeyedSubscript("__GLCanvas")
        glCanvas?.setObject(createCanvas, forKeyedSubscript: "_createCanvas" as NSString)
        glCanvas?.setObject(destroyCanvas, forKeyedSubscript: "_destroyCanvas" as NSString)
        glCanvas?.setObject(bufferOp, forKeyedSubscript: "_bufferOp" as NSString)
        glCanvas?.setObject(flush, forKeyedSubscript: "_flush" as NSString)
        glCanvas?.setObject(syncOp, forKeyedSubscript: "_syncOp" as NSString)
        glCanvas?.setObject(render, forKeyedSubscript: "_render" as NSString)
        glCanvas?.setObject(replayPendingOps, forKeyedSubscript: "_replayPendingOps" as NSString)
        glCanvas?.setObject(uploadPendingImages, forKeyedSubscript: "_uploadPendingImages" as NSString)
        glCanvas?.setObject(putImageData, forKeyedSubscript: "_putImageData" as NSString)

        DMPLogger.debug("DMPEngineCanvas: registered __GLCanvas available=true")
    }

    // MARK: - GL Handle Binding

    /// Called from NativeComponentAPI when the GL surface is ready.
    /// Associates the native DMCanvasRef with a nodeId.
    func setCanvasGLHandle(nodeId: String, glCanvas: OpaquePointer) {
        if let state = canvasStates[nodeId] {
            state.glCanvas = glCanvas
            state.glInitialized = true
        } else {
            let state = CanvasState(nodeId: nodeId)
            state.glCanvas = glCanvas
            state.glInitialized = true
            canvasStates[nodeId] = state
        }
        DMPLogger.debug("DMPEngineCanvas: setCanvasGLHandle nodeId=\(nodeId)")

        // Schedule replay on JS thread
        engine?.enqueueScript(
            "if(typeof __GLCanvas!=='undefined'&&__GLCanvas._replayPendingOps)" +
            "__GLCanvas._replayPendingOps('\(nodeId)')")
    }

    /// Remove canvas state for a nodeId (called on unmount)
    func removeCanvasState(nodeId: String) {
        if let state = canvasStates.removeValue(forKey: nodeId) {
            if let canvas = state.glCanvas {
                dm_canvas_destroy(canvas)
            }
        }
    }

    /// Clean up all canvas states (called on engine destroy)
    func cleanup() {
        for (_, state) in canvasStates {
            if let canvas = state.glCanvas {
                dm_canvas_destroy(canvas)
                state.glCanvas = nil
            }
        }
        canvasStates.removeAll()
    }

    // MARK: - Private Helpers

    /// Serialize a single JS op object to JSON string: {"nodeId":"...","operations":[<op>]}
    private func serializeOp(nodeId: String, opObj: JSValue, context: JSContext) -> String? {
        // Build wrapper: {nodeId: nodeId, operations: [opObj]}
        let wrapper = JSValue(newObjectIn: context)
        wrapper?.setObject(nodeId, forKeyedSubscript: "nodeId" as NSString)
        let opsArr = JSValue(newArrayIn: context)
        opsArr?.setObject(opObj, atIndexedSubscript: 0)
        wrapper?.setObject(opsArr, forKeyedSubscript: "operations" as NSString)

        // Use JSON.stringify
        let jsonGlobal = context.objectForKeyedSubscript("JSON")
        let result = jsonGlobal?.invokeMethod("stringify", withArguments: [wrapper as Any])
        return result?.toString()
    }

    /// Intercept imageSetSrc ops and forward to CanvasImageLoader
    private func handleImageSetSrcGL(state: CanvasState, opObj: JSValue) -> Bool {
        let op = opObj.objectForKeyedSubscript("op")?.toString() ?? ""
        guard op == "imageSetSrc", state.glCanvas != nil else { return false }

        let imageId = opObj.objectForKeyedSubscript("imageId")?.toString() ?? ""
        let src = opObj.objectForKeyedSubscript("src")?.toString() ?? ""
        let onload = opObj.objectForKeyedSubscript("onload")?.toString() ?? ""
        let onerror = opObj.objectForKeyedSubscript("onerror")?.toString() ?? ""

        guard !src.isEmpty, !imageId.isEmpty, let engine = engine else { return false }

        CanvasImageLoader.shared.handleImageSetSrc(
            engine: engine, nodeId: state.nodeId,
            imageId: imageId, src: src, onload: onload, onerror: onerror)

        return true
    }

    /// Schedule a deferred swap via setTimeout(fn, 16) for ~60fps
    private func scheduleDeferredSwap(state: CanvasState) {
        guard !state.swapScheduled else { return }
        state.swapScheduled = true

        engine?.enqueueScript(
            "setTimeout(function(){if(typeof __GLCanvas!=='undefined'&&__GLCanvas._render)" +
            "__GLCanvas._render('\(state.nodeId)')},16)")
    }

    /// Invoke a JS callback via the dimina callback registry
    private func invokeCallback(callbackId: String, argsJson: String) {
        engine?.enqueueScript("""
            (function(){
                var cb=globalThis.__dimina_callback_registry;
                if(cb&&cb.invoke)cb.invoke('\(callbackId)',\(argsJson));
            })()
            """)
    }
}
