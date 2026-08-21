//
//  NativeCanvasGLView.swift
//  dimina
//
//  UIView subclass backed by CAEAGLLayer for native canvas rendering
//  via ANGLE (GLES2 → Metal). Equivalent of Android's NativeCanvasGLView.kt.
//

import UIKit

class NativeCanvasGLView: UIView {

    /// Native canvas handle (pointer to DMCanvas)
    private var glCanvas: OpaquePointer? = nil

    /// The nodeId this view is associated with
    var nodeId: String = ""

    /// Whether the GL surface has been initialized
    private(set) var surfaceInitialized = false

    // MARK: - Layer

    override class var layerClass: AnyClass {
        // ANGLE renders to CAEAGLLayer (it bridges to Metal internally)
        return CAEAGLLayer.self
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        backgroundColor = .clear
        isOpaque = false

        if let eaglLayer = self.layer as? CAEAGLLayer {
            eaglLayer.isOpaque = false
            eaglLayer.drawableProperties = [
                kEAGLDrawablePropertyRetainedBacking: false,
                kEAGLDrawablePropertyColorFormat: kEAGLColorFormatRGBA8
            ]
        }
    }

    // MARK: - Canvas Lifecycle

    /// Create the native canvas with the given drawing buffer dimensions.
    /// The GL surface is initialized immediately using this view's CAEAGLLayer.
    func initCanvas(nodeId: String, width: Int, height: Int) {
        self.nodeId = nodeId

        if glCanvas == nil {
            glCanvas = dm_canvas_create(Int32(width), Int32(height))
            DMPLogger.debug("NativeCanvasGLView: created canvas nodeId=\(nodeId) \(width)x\(height)")
        }

        // Initialize the EGL surface from our CAEAGLLayer
        if !surfaceInitialized {
            initSurface()
        }
    }

    /// Get the native canvas handle for use with DMPEngineCanvas
    func getCanvasHandle() -> OpaquePointer? {
        return glCanvas
    }

    /// Initialize the EGL surface from the view's CAEAGLLayer.
    /// ANGLE accepts a CAEAGLLayer as the native window for eglCreateWindowSurface.
    private func initSurface() {
        guard let canvas = glCanvas else { return }

        let layer = self.layer
        let layerPtr = Unmanaged.passUnretained(layer).toOpaque()
        let result = dm_canvas_init_surface(canvas, layerPtr)

        if result == 0 {
            surfaceInitialized = true
            DMPLogger.debug("NativeCanvasGLView: surface initialized nodeId=\(nodeId)")
        } else {
            DMPLogger.debug("NativeCanvasGLView: surface init FAILED nodeId=\(nodeId) result=\(result)")
        }
    }

    // MARK: - Image Upload

    /// Store a pending image upload for processing on the JS/GL thread
    func uploadImage(imageId: String, rgba: Data, width: Int, height: Int, callbackId: String) {
        guard let canvas = glCanvas else { return }

        rgba.withUnsafeBytes { rawBuf in
            guard let ptr = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
            let rc = dm_canvas_load_image_rgba(canvas, imageId, Int32(width), Int32(height), ptr)
            if rc == 0 {
                DMPLogger.debug("NativeCanvasGLView: uploaded image \(imageId) \(width)x\(height)")
            } else {
                DMPLogger.debug("NativeCanvasGLView: image upload FAILED \(imageId)")
            }
        }
    }

    // MARK: - Layout

    override func layoutSubviews() {
        super.layoutSubviews()

        // Update surface size when the view's bounds change
        if let canvas = glCanvas, surfaceInitialized {
            let scale = UIScreen.main.scale
            let sw = Int(bounds.width * scale)
            let sh = Int(bounds.height * scale)
            if sw > 0 && sh > 0 {
                dm_canvas_set_surface_size(canvas, Int32(sw), Int32(sh))
            }
        }
    }

    // MARK: - Cleanup

    func destroy() {
        if let canvas = glCanvas {
            dm_canvas_destroy_surface(canvas)
            dm_canvas_destroy(canvas)
            glCanvas = nil
            surfaceInitialized = false
            DMPLogger.debug("NativeCanvasGLView: destroyed nodeId=\(nodeId)")
        }
    }

    deinit {
        destroy()
    }
}
