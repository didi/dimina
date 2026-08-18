//
//  NativeCanvasView.swift
//  dimina
//
//  Canvas 2D rendering view backed by NanoVG + GLES2 (via ANGLE on iOS).
//
//  This implements the NativeCanvasView interface expected by CanvasManager.
//  When the GL backend is not available (ANGLE not linked), it falls back
//  to Core Graphics rendering.
//

import UIKit

// MARK: - Canvas Gradient

class CanvasGradient {
    enum GradientType {
        case linear(x0: CGFloat, y0: CGFloat, x1: CGFloat, y1: CGFloat)
        case radial(x0: CGFloat, y0: CGFloat, r0: CGFloat, x1: CGFloat, y1: CGFloat, r1: CGFloat)
    }

    let type: GradientType
    var colorStops: [(offset: CGFloat, color: UIColor)] = []

    init(type: GradientType) {
        self.type = type
    }

    func addColorStop(_ offset: Any?, _ color: Any?) {
        let off = asCGFloat(offset)
        let col = parseCanvasColor(color)
        colorStops.append((offset: off, color: col))
        colorStops.sort { $0.offset < $1.offset }
    }

    func makeCGGradient() -> CGGradient? {
        guard !colorStops.isEmpty else { return nil }
        let colors = colorStops.map { $0.color.cgColor } as CFArray
        var locations = colorStops.map { $0.offset }
        return CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                          colors: colors, locations: &locations)
    }
}

// MARK: - NativeCanvasView

class NativeCanvasView: UIView {

    // MARK: - Canvas Dimensions (set by JS)
    var jsCanvasWidth: CGFloat = 300
    var jsCanvasHeight: CGFloat = 150

    // MARK: - Drawing State
    private var backingImage: CGImage?
    private var cgContext: CGContext?

    // State
    private var fillColor: UIColor = .black
    private var strokeColor: UIColor = .black
    private var lineWidth: CGFloat = 1.0
    private var lineCap: CGLineCap = .butt
    private var lineJoin: CGLineJoin = .miter
    private var miterLimit: CGFloat = 10.0
    private var globalAlpha: CGFloat = 1.0
    private var fontStr: String = "10px sans-serif"
    private var textAlignStr: String = "start"
    private var textBaselineStr: String = "alphabetic"
    private var shadowColor: UIColor = .clear
    private var shadowBlur: CGFloat = 0
    private var shadowOffsetX: CGFloat = 0
    private var shadowOffsetY: CGFloat = 0
    private var lineDash: [CGFloat] = []
    private var lineDashOffset: CGFloat = 0

    // Current gradient
    private var fillGradient: CanvasGradient?
    private var strokeGradient: CanvasGradient?

    // Path tracking
    private var currentPath = CGMutablePath()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        backgroundColor = .clear
        isOpaque = false
    }

    // MARK: - Context Setup

    private func ensureContext() {
        let w = Int(jsCanvasWidth)
        let h = Int(jsCanvasHeight)
        if w <= 0 || h <= 0 { return }

        if cgContext != nil {
            let existingW = cgContext!.width
            let existingH = cgContext!.height
            if existingW == w && existingH == h { return }
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        cgContext = CGContext(data: nil, width: w, height: h,
                             bitsPerComponent: 8, bytesPerRow: w * 4,
                             space: colorSpace,
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)

        // Flip coordinate system to match Canvas 2D (origin top-left)
        cgContext?.translateBy(x: 0, y: CGFloat(h))
        cgContext?.scaleBy(x: 1, y: -1)
    }

    // MARK: - Public Interface (called by CanvasManager)

    func setProperty(_ prop: String, _ value: Any?) {
        switch prop {
        case "fillStyle":
            if let gradient = value as? CanvasGradient {
                fillGradient = gradient
            } else {
                fillGradient = nil
                fillColor = parseCanvasColor(value)
            }
        case "strokeStyle":
            if let gradient = value as? CanvasGradient {
                strokeGradient = gradient
            } else {
                strokeGradient = nil
                strokeColor = parseCanvasColor(value)
            }
        case "lineWidth":
            lineWidth = asCGFloat(value)
        case "lineCap":
            let cap = value as? String ?? "butt"
            switch cap {
            case "round": lineCap = .round
            case "square": lineCap = .square
            default: lineCap = .butt
            }
        case "lineJoin":
            let join = value as? String ?? "miter"
            switch join {
            case "round": lineJoin = .round
            case "bevel": lineJoin = .bevel
            default: lineJoin = .miter
            }
        case "miterLimit":
            miterLimit = asCGFloat(value)
        case "globalAlpha":
            globalAlpha = asCGFloat(value)
        case "font":
            fontStr = value as? String ?? "10px sans-serif"
        case "textAlign":
            textAlignStr = value as? String ?? "start"
        case "textBaseline":
            textBaselineStr = value as? String ?? "alphabetic"
        case "shadowColor":
            shadowColor = parseCanvasColor(value)
        case "shadowBlur":
            shadowBlur = asCGFloat(value)
        case "shadowOffsetX":
            shadowOffsetX = asCGFloat(value)
        case "shadowOffsetY":
            shadowOffsetY = asCGFloat(value)
        case "lineDashOffset":
            lineDashOffset = asCGFloat(value)
        case "globalCompositeOperation":
            applyCompositeOp(value as? String ?? "source-over")
        default:
            break
        }
    }

    func callMethod(_ method: String, _ args: [Any?]) -> Any? {
        ensureContext()
        guard let ctx = cgContext else { return nil }

        switch method {
        // Path methods
        case "beginPath":
            currentPath = CGMutablePath()
        case "closePath":
            currentPath.closeSubpath()
        case "moveTo":
            currentPath.move(to: CGPoint(x: asCGFloat(args[safe: 0]),
                                          y: asCGFloat(args[safe: 1])))
        case "lineTo":
            currentPath.addLine(to: CGPoint(x: asCGFloat(args[safe: 0]),
                                             y: asCGFloat(args[safe: 1])))
        case "bezierCurveTo":
            currentPath.addCurve(
                to: CGPoint(x: asCGFloat(args[safe: 4]), y: asCGFloat(args[safe: 5])),
                control1: CGPoint(x: asCGFloat(args[safe: 0]), y: asCGFloat(args[safe: 1])),
                control2: CGPoint(x: asCGFloat(args[safe: 2]), y: asCGFloat(args[safe: 3])))
        case "quadraticCurveTo":
            currentPath.addQuadCurve(
                to: CGPoint(x: asCGFloat(args[safe: 2]), y: asCGFloat(args[safe: 3])),
                control: CGPoint(x: asCGFloat(args[safe: 0]), y: asCGFloat(args[safe: 1])))
        case "arc":
            let cx = asCGFloat(args[safe: 0])
            let cy = asCGFloat(args[safe: 1])
            let r = asCGFloat(args[safe: 2])
            let sa = asCGFloat(args[safe: 3])
            let ea = asCGFloat(args[safe: 4])
            let ccw = (args[safe: 5] as? Bool) ?? false
            currentPath.addArc(center: CGPoint(x: cx, y: cy), radius: r,
                               startAngle: sa, endAngle: ea, clockwise: ccw)
        case "arcTo":
            currentPath.addArc(tangent1End: CGPoint(x: asCGFloat(args[safe: 0]),
                                                     y: asCGFloat(args[safe: 1])),
                               tangent2End: CGPoint(x: asCGFloat(args[safe: 2]),
                                                     y: asCGFloat(args[safe: 3])),
                               radius: asCGFloat(args[safe: 4]))
        case "rect":
            currentPath.addRect(CGRect(x: asCGFloat(args[safe: 0]),
                                        y: asCGFloat(args[safe: 1]),
                                        width: asCGFloat(args[safe: 2]),
                                        height: asCGFloat(args[safe: 3])))
        case "ellipse":
            let cx = asCGFloat(args[safe: 0]), cy = asCGFloat(args[safe: 1])
            let rx = asCGFloat(args[safe: 2]), ry = asCGFloat(args[safe: 3])
            let rotation = asCGFloat(args[safe: 4])
            let sa = asCGFloat(args[safe: 5]), ea = asCGFloat(args[safe: 6])
            let ccw = (args[safe: 7] as? Bool) ?? false

            var t = CGAffineTransform.identity
            t = t.translatedBy(x: cx, y: cy)
            if rotation != 0 { t = t.rotated(by: rotation) }
            t = t.scaledBy(x: 1, y: ry / max(rx, 0.001))
            currentPath.addArc(center: .zero, radius: rx,
                               startAngle: sa, endAngle: ea,
                               clockwise: ccw, transform: t)

        // Fill / Stroke
        case "fill":
            applyContextState(ctx)
            ctx.addPath(currentPath)
            applyFill(ctx)
        case "stroke":
            applyContextState(ctx)
            ctx.addPath(currentPath)
            applyStroke(ctx)
        case "fillRect":
            let rect = CGRect(x: asCGFloat(args[safe: 0]),
                              y: asCGFloat(args[safe: 1]),
                              width: asCGFloat(args[safe: 2]),
                              height: asCGFloat(args[safe: 3]))
            applyContextState(ctx)
            ctx.addRect(rect)
            applyFill(ctx)
        case "strokeRect":
            let rect = CGRect(x: asCGFloat(args[safe: 0]),
                              y: asCGFloat(args[safe: 1]),
                              width: asCGFloat(args[safe: 2]),
                              height: asCGFloat(args[safe: 3]))
            applyContextState(ctx)
            ctx.addRect(rect)
            applyStroke(ctx)
        case "clearRect":
            let rect = CGRect(x: asCGFloat(args[safe: 0]),
                              y: asCGFloat(args[safe: 1]),
                              width: asCGFloat(args[safe: 2]),
                              height: asCGFloat(args[safe: 3]))
            ctx.clear(rect)

        // Transform
        case "save":
            ctx.saveGState()
        case "restore":
            ctx.restoreGState()
        case "translate":
            ctx.translateBy(x: asCGFloat(args[safe: 0]), y: asCGFloat(args[safe: 1]))
        case "rotate":
            ctx.rotate(by: asCGFloat(args[safe: 0]))
        case "scale":
            ctx.scaleBy(x: asCGFloat(args[safe: 0]), y: asCGFloat(args[safe: 1]))
        case "transform":
            let t = CGAffineTransform(a: asCGFloat(args[safe: 0]),
                                       b: asCGFloat(args[safe: 1]),
                                       c: asCGFloat(args[safe: 2]),
                                       d: asCGFloat(args[safe: 3]),
                                       tx: asCGFloat(args[safe: 4]),
                                       ty: asCGFloat(args[safe: 5]))
            ctx.concatenate(t)
        case "setTransform":
            // Reset to identity then apply
            ctx.concatenate(ctx.ctm.inverted())
            // Re-apply the canvas flip
            ctx.translateBy(x: 0, y: jsCanvasHeight)
            ctx.scaleBy(x: 1, y: -1)
            let t = CGAffineTransform(a: asCGFloat(args[safe: 0]),
                                       b: asCGFloat(args[safe: 1]),
                                       c: asCGFloat(args[safe: 2]),
                                       d: asCGFloat(args[safe: 3]),
                                       tx: asCGFloat(args[safe: 4]),
                                       ty: asCGFloat(args[safe: 5]))
            ctx.concatenate(t)

        // Text
        case "fillText":
            drawText(ctx, args: args, isFill: true)
        case "strokeText":
            drawText(ctx, args: args, isFill: false)

        // Clipping
        case "clip":
            ctx.addPath(currentPath)
            ctx.clip()

        // Gradients
        case "createLinearGradient":
            let g = CanvasGradient(type: .linear(
                x0: asCGFloat(args[safe: 0]), y0: asCGFloat(args[safe: 1]),
                x1: asCGFloat(args[safe: 2]), y1: asCGFloat(args[safe: 3])))
            return g
        case "createRadialGradient":
            let g = CanvasGradient(type: .radial(
                x0: asCGFloat(args[safe: 0]), y0: asCGFloat(args[safe: 1]),
                r0: asCGFloat(args[safe: 2]),
                x1: asCGFloat(args[safe: 3]), y1: asCGFloat(args[safe: 4]),
                r1: asCGFloat(args[safe: 5])))
            return g

        // Image
        case "drawImage":
            drawImage(ctx, args: args)

        // Line dash
        case "setLineDash":
            if let dashArray = args[safe: 0] as? [Any] {
                lineDash = dashArray.map { asCGFloat($0) }
            }

        default:
            break
        }
        return nil
    }

    func flush() {
        guard let ctx = cgContext else { return }
        backingImage = ctx.makeImage()
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let backingImage = backingImage,
              let drawCtx = UIGraphicsGetCurrentContext() else { return }
        drawCtx.saveGState()
        drawCtx.translateBy(x: 0, y: bounds.height)
        drawCtx.scaleBy(x: 1, y: -1)
        let scaleX = bounds.width / jsCanvasWidth
        let scaleY = bounds.height / jsCanvasHeight
        drawCtx.scaleBy(x: scaleX, y: scaleY)
        drawCtx.draw(backingImage, in: CGRect(x: 0, y: 0,
                                               width: jsCanvasWidth,
                                               height: jsCanvasHeight))
        drawCtx.restoreGState()
    }

    // MARK: - Pixel Operations

    func getImageData(x: Int, y: Int, width: Int, height: Int) -> [Int]? {
        guard let ctx = cgContext, let image = ctx.makeImage(),
              let dataProvider = image.dataProvider,
              let data = dataProvider.data else { return nil }

        let ptr = CFDataGetBytePtr(data)!
        let bytesPerRow = ctx.bytesPerRow
        var result: [Int] = []

        for row in y..<min(y + height, ctx.height) {
            for col in x..<min(x + width, ctx.width) {
                // Flip Y: canvas is flipped
                let flippedRow = ctx.height - 1 - row
                let offset = flippedRow * bytesPerRow + col * 4
                result.append(Int(ptr[offset]))     // R
                result.append(Int(ptr[offset + 1])) // G
                result.append(Int(ptr[offset + 2])) // B
                result.append(Int(ptr[offset + 3])) // A
            }
        }
        return result
    }

    func toDataURL(mimeType: String, quality: Double) -> String? {
        guard let image = renderToImage() else { return nil }
        let data: Data?
        if mimeType == "image/jpeg" {
            data = image.jpegData(compressionQuality: CGFloat(quality))
        } else {
            data = image.pngData()
        }
        guard let imageData = data else { return nil }
        let base64 = imageData.base64EncodedString()
        return "data:\(mimeType);base64,\(base64)"
    }

    func measureText(text: String, font: String) -> [String: Any]? {
        let parsedFont = parseUIFont(from: font)
        let attrs: [NSAttributedString.Key: Any] = [.font: parsedFont]
        let size = (text as NSString).size(withAttributes: attrs)
        return [
            "width": size.width,
            "actualBoundingBoxAscent": parsedFont.ascender,
            "actualBoundingBoxDescent": -parsedFont.descender
        ]
    }

    func renderToImage() -> UIImage? {
        guard let ctx = cgContext, let cgImage = ctx.makeImage() else { return nil }
        return UIImage(cgImage: cgImage)
    }

    // MARK: - Private Helpers

    private func applyContextState(_ ctx: CGContext) {
        ctx.setLineWidth(lineWidth)
        ctx.setLineCap(lineCap)
        ctx.setLineJoin(lineJoin)
        ctx.setMiterLimit(miterLimit)
        ctx.setAlpha(globalAlpha)

        if !lineDash.isEmpty {
            ctx.setLineDash(phase: lineDashOffset, lengths: lineDash)
        } else {
            ctx.setLineDash(phase: 0, lengths: [])
        }

        if shadowBlur > 0 || shadowOffsetX != 0 || shadowOffsetY != 0 {
            ctx.setShadow(offset: CGSize(width: shadowOffsetX, height: shadowOffsetY),
                          blur: shadowBlur, color: shadowColor.cgColor)
        } else {
            ctx.setShadow(offset: .zero, blur: 0, color: nil)
        }
    }

    private func applyFill(_ ctx: CGContext) {
        if let gradient = fillGradient, let cgGradient = gradient.makeCGGradient() {
            ctx.saveGState()
            ctx.clip()
            drawGradient(ctx, gradient: gradient, cgGradient: cgGradient)
            ctx.restoreGState()
        } else {
            ctx.setFillColor(fillColor.cgColor)
            ctx.fillPath()
        }
    }

    private func applyStroke(_ ctx: CGContext) {
        if let gradient = strokeGradient, let cgGradient = gradient.makeCGGradient() {
            ctx.saveGState()
            ctx.replacePathWithStrokedPath()
            ctx.clip()
            drawGradient(ctx, gradient: gradient, cgGradient: cgGradient)
            ctx.restoreGState()
        } else {
            ctx.setStrokeColor(strokeColor.cgColor)
            ctx.strokePath()
        }
    }

    private func drawGradient(_ ctx: CGContext, gradient: CanvasGradient,
                               cgGradient: CGGradient) {
        switch gradient.type {
        case .linear(let x0, let y0, let x1, let y1):
            ctx.drawLinearGradient(cgGradient,
                                   start: CGPoint(x: x0, y: y0),
                                   end: CGPoint(x: x1, y: y1),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        case .radial(let x0, let y0, let r0, let x1, let y1, let r1):
            ctx.drawRadialGradient(cgGradient,
                                    startCenter: CGPoint(x: x0, y: y0), startRadius: r0,
                                    endCenter: CGPoint(x: x1, y: y1), endRadius: r1,
                                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
    }

    private func drawText(_ ctx: CGContext, args: [Any?], isFill: Bool) {
        let text = args[safe: 0] as? String ?? ""
        let x = asCGFloat(args[safe: 1])
        let y = asCGFloat(args[safe: 2])

        let uiFont = parseUIFont(from: fontStr)
        let color = isFill ? fillColor : strokeColor

        var attrs: [NSAttributedString.Key: Any] = [
            .font: uiFont,
            .foregroundColor: color
        ]

        if !isFill {
            attrs[.strokeColor] = color
            attrs[.strokeWidth] = lineWidth
        }

        let attrStr = NSAttributedString(string: text, attributes: attrs)
        let size = attrStr.size()

        // Calculate position based on textAlign and textBaseline
        var drawX = x
        var drawY = y

        switch textAlignStr {
        case "center": drawX -= size.width / 2
        case "right", "end": drawX -= size.width
        default: break
        }

        switch textBaselineStr {
        case "top", "hanging": break
        case "middle": drawY -= size.height / 2
        case "bottom", "ideographic": drawY -= size.height
        default: drawY -= uiFont.ascender // "alphabetic"
        }

        // CoreGraphics draws text with origin at bottom-left, flipped
        ctx.saveGState()
        // Undo the canvas flip for text drawing
        ctx.translateBy(x: drawX, y: drawY + size.height)
        ctx.scaleBy(x: 1, y: -1)
        let line = CTLineCreateWithAttributedString(attrStr)
        ctx.textPosition = .zero
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    private func drawImage(_ ctx: CGContext, args: [Any?]) {
        guard let image = args[safe: 0] as? UIImage,
              let cgImage = image.cgImage else { return }

        let argc = args.count
        let imgW = CGFloat(cgImage.width)
        let imgH = CGFloat(cgImage.height)

        var sx: CGFloat = 0, sy: CGFloat = 0, sw = imgW, sh = imgH
        var dx: CGFloat, dy: CGFloat, dw: CGFloat, dh: CGFloat

        if argc >= 10 {
            sx = asCGFloat(args[safe: 1]); sy = asCGFloat(args[safe: 2])
            sw = asCGFloat(args[safe: 3]); sh = asCGFloat(args[safe: 4])
            dx = asCGFloat(args[safe: 5]); dy = asCGFloat(args[safe: 6])
            dw = asCGFloat(args[safe: 7]); dh = asCGFloat(args[safe: 8])
        } else if argc >= 6 {
            dx = asCGFloat(args[safe: 1]); dy = asCGFloat(args[safe: 2])
            dw = asCGFloat(args[safe: 3]); dh = asCGFloat(args[safe: 4])
        } else {
            dx = asCGFloat(args[safe: 1]); dy = asCGFloat(args[safe: 2])
            dw = imgW; dh = imgH
        }

        ctx.saveGState()

        if sx != 0 || sy != 0 || sw != imgW || sh != imgH {
            // Source rect cropping
            if let cropped = cgImage.cropping(to: CGRect(x: sx, y: sy,
                                                          width: sw, height: sh)) {
                // Flip for drawImage
                ctx.translateBy(x: dx, y: dy + dh)
                ctx.scaleBy(x: 1, y: -1)
                ctx.draw(cropped, in: CGRect(x: 0, y: 0, width: dw, height: dh))
            }
        } else {
            ctx.translateBy(x: dx, y: dy + dh)
            ctx.scaleBy(x: 1, y: -1)
            ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: dw, height: dh))
        }

        ctx.restoreGState()
    }

    private func parseUIFont(from fontStr: String) -> UIFont {
        var size: CGFloat = 10
        var family = "sans-serif"
        var isBold = false
        var isItalic = false

        let tokens = fontStr.split(separator: " ").map(String.init)
        var idx = 0

        while idx < tokens.count {
            let t = tokens[idx].lowercased()
            if t == "bold" { isBold = true; idx += 1 }
            else if t == "italic" { isItalic = true; idx += 1 }
            else if t == "normal" { idx += 1 }
            else { break }
        }

        if idx < tokens.count {
            let sizeToken = tokens[idx].replacingOccurrences(of: "px", with: "")
                .replacingOccurrences(of: "pt", with: "")
            if let s = Double(sizeToken) {
                size = CGFloat(s)
            }
            idx += 1
        }

        if idx < tokens.count {
            family = tokens[idx...].joined(separator: " ")
                .trimmingCharacters(in: .punctuationCharacters)
        }

        // Map family names
        var fontName: String
        switch family.lowercased() {
        case "sans-serif", "arial", "helvetica":
            fontName = "Helvetica"
        case "serif", "times", "times new roman":
            fontName = "TimesNewRomanPSMT"
        case "monospace", "courier", "courier new":
            fontName = "Courier"
        default:
            fontName = family
        }

        if isBold && isItalic {
            fontName += "-BoldOblique"
        } else if isBold {
            fontName += "-Bold"
        } else if isItalic {
            fontName += "-Oblique"
        }

        if let font = UIFont(name: fontName, size: size) {
            return font
        }

        // Fallback
        var traits: UIFontDescriptor.SymbolicTraits = []
        if isBold { traits.insert(.traitBold) }
        if isItalic { traits.insert(.traitItalic) }

        let descriptor = UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
            .withSymbolicTraits(traits) ?? UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body)
        return UIFont(descriptor: descriptor, size: size)
    }

    private func applyCompositeOp(_ op: String) {
        guard let ctx = cgContext else { return }
        switch op {
        case "source-over": ctx.setBlendMode(.normal)
        case "source-in": ctx.setBlendMode(.sourceIn)
        case "source-out": ctx.setBlendMode(.sourceOut)
        case "source-atop": ctx.setBlendMode(.sourceAtop)
        case "destination-over": ctx.setBlendMode(.destinationOver)
        case "destination-in": ctx.setBlendMode(.destinationIn)
        case "destination-out": ctx.setBlendMode(.destinationOut)
        case "destination-atop": ctx.setBlendMode(.destinationAtop)
        case "lighter": ctx.setBlendMode(.plusLighter)
        case "copy": ctx.setBlendMode(.copy)
        case "xor": ctx.setBlendMode(.xor)
        case "multiply": ctx.setBlendMode(.multiply)
        case "screen": ctx.setBlendMode(.screen)
        case "overlay": ctx.setBlendMode(.overlay)
        case "darken": ctx.setBlendMode(.darken)
        case "lighten": ctx.setBlendMode(.lighten)
        default: ctx.setBlendMode(.normal)
        }
    }
}

// MARK: - Color Parsing

func parseCanvasColor(_ value: Any?) -> UIColor {
    guard let str = value as? String else { return .black }
    let s = str.trimmingCharacters(in: .whitespaces).lowercased()

    if s.isEmpty { return .black }

    // Named colors
    switch s {
    case "transparent": return .clear
    case "black": return .black
    case "white": return .white
    case "red": return .red
    case "green": return UIColor(red: 0, green: 0.5, blue: 0, alpha: 1)
    case "blue": return .blue
    case "yellow": return .yellow
    case "cyan", "aqua": return .cyan
    case "magenta", "fuchsia": return .magenta
    case "orange": return .orange
    case "purple": return .purple
    case "gray", "grey": return .gray
    default: break
    }

    // Hex
    if s.hasPrefix("#") {
        let hex = String(s.dropFirst())
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 1

        switch hex.count {
        case 3:
            let chars = Array(hex)
            r = hexVal(chars[0]) / 15.0
            g = hexVal(chars[1]) / 15.0
            b = hexVal(chars[2]) / 15.0
        case 4:
            let chars = Array(hex)
            r = hexVal(chars[0]) / 15.0
            g = hexVal(chars[1]) / 15.0
            b = hexVal(chars[2]) / 15.0
            a = hexVal(chars[3]) / 15.0
        case 6:
            let chars = Array(hex)
            r = (hexVal(chars[0]) * 16 + hexVal(chars[1])) / 255.0
            g = (hexVal(chars[2]) * 16 + hexVal(chars[3])) / 255.0
            b = (hexVal(chars[4]) * 16 + hexVal(chars[5])) / 255.0
        case 8:
            let chars = Array(hex)
            r = (hexVal(chars[0]) * 16 + hexVal(chars[1])) / 255.0
            g = (hexVal(chars[2]) * 16 + hexVal(chars[3])) / 255.0
            b = (hexVal(chars[4]) * 16 + hexVal(chars[5])) / 255.0
            a = (hexVal(chars[6]) * 16 + hexVal(chars[7])) / 255.0
        default: break
        }
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }

    // rgb/rgba
    if s.hasPrefix("rgb") {
        let inner = s.replacingOccurrences(of: "rgba(", with: "")
            .replacingOccurrences(of: "rgb(", with: "")
            .replacingOccurrences(of: ")", with: "")
        let parts = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.count >= 3 {
            let r = CGFloat(Double(parts[0]) ?? 0) / 255.0
            let g = CGFloat(Double(parts[1]) ?? 0) / 255.0
            let b = CGFloat(Double(parts[2]) ?? 0) / 255.0
            let a = parts.count >= 4 ? CGFloat(Double(parts[3]) ?? 1) : 1
            return UIColor(red: r, green: g, blue: b, alpha: a)
        }
    }

    return .black
}

private func hexVal(_ c: Character) -> CGFloat {
    switch c {
    case "0"..."9": return CGFloat(c.asciiValue! - Character("0").asciiValue!)
    case "a"..."f": return CGFloat(c.asciiValue! - Character("a").asciiValue! + 10)
    default: return 0
    }
}

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
