//
//  NativeCanvasView.swift
//  dimina
//

import UIKit

class NativeCanvasView: UIView {

    private var currentPath = CGMutablePath()
    private var stateStack: [CanvasDrawState] = []

    // JS canvas buffer size (set via canvas.width / canvas.height)
    var jsCanvasWidth: CGFloat = 0 {
        didSet {
            if jsCanvasWidth != oldValue { rebuildBitmap() }
        }
    }
    var jsCanvasHeight: CGFloat = 0 {
        didSet {
            if jsCanvasHeight != oldValue { rebuildBitmap() }
        }
    }

    // CGBitmapContext — all 2D ops execute immediately here
    private var bitmapContext: CGContext?
    private var bitmapData: UnsafeMutableRawPointer?
    private var bitmapWidth: Int = 0
    private var bitmapHeight: Int = 0
    /// The base CTM after Y-flip; used by setTransform/resetTransform
    private var baseCTM: CGAffineTransform = .identity

    // Current paint state
    private var fillColor: UIColor = .black
    private var strokeColor: UIColor = .black
    private var fillGradient: CanvasGradient?
    private var strokeGradient: CanvasGradient?
    private var lineWidth: CGFloat = 1
    private var lineCap: CGLineCap = .butt
    private var lineJoin: CGLineJoin = .miter
    private var miterLimit: CGFloat = 10
    private var globalAlpha: CGFloat = 1
    private var fontSize: CGFloat = 10
    private var fontFamily: String = "sans-serif"
    private var fontWeight: String = "normal"
    private var fontStyle: String = "normal"
    private var textAlign: String = "start"
    private var textBaseline: String = "alphabetic"
    private var shadowBlur: CGFloat = 0
    private var shadowColor: UIColor = .clear
    private var shadowOffsetX: CGFloat = 0
    private var shadowOffsetY: CGFloat = 0
    private var lineDashPattern: [CGFloat]?
    private var lineDashOffset: CGFloat = 0
    private var globalCompositeOperation: CGBlendMode = .normal

    // MARK: - Init

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func commonInit() {
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = false
        layer.contentsGravity = .resize
    }

    // MARK: - Bitmap Context Management

    private func rebuildBitmap() {
        let w = Int(jsCanvasWidth)
        let h = Int(jsCanvasHeight)
        guard w > 0, h > 0 else {
            bitmapContext = nil
            if let oldData = bitmapData {
                oldData.deallocate()
            }
            bitmapData = nil
            bitmapWidth = 0
            bitmapHeight = 0
            return
        }

        // Reuse if same size
        if w == bitmapWidth && h == bitmapHeight && bitmapContext != nil { return }

        let bytesPerRow = w * 4
        let dataSize = bytesPerRow * h
        let data = UnsafeMutableRawPointer.allocate(byteCount: dataSize, alignment: 16)
        data.initializeMemory(as: UInt8.self, repeating: 0, count: dataSize)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        // BGRA layout: iOS native format, most efficient for Core Animation compositing
        let bitmapInfo = CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue)
        guard let ctx = CGContext(data: data, width: w, height: h,
                                  bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                                  space: colorSpace, bitmapInfo: bitmapInfo.rawValue) else {
            data.deallocate()
            return
        }

        // Free old data after successful context creation
        bitmapContext = nil
        if let oldData = bitmapData {
            oldData.deallocate()
        }

        bitmapWidth = w
        bitmapHeight = h
        bitmapData = data

        // Y-flip so (0,0) is top-left (HTML Canvas convention)
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        baseCTM = ctx.ctm

        bitmapContext = ctx
    }

    // MARK: - Flush (bitmap → CGImage → layer.contents)

    func flush() {
        guard let cgImage = bitmapContext?.makeImage() else { return }
        layer.contents = cgImage
    }

    func clearAll() {
        currentPath = CGMutablePath()
        stateStack.removeAll()
        fillColor = .black
        strokeColor = .black
        fillGradient = nil
        strokeGradient = nil
        lineWidth = 1
        lineCap = .butt
        lineJoin = .miter
        miterLimit = 10
        globalAlpha = 1
        fontSize = 10
        fontFamily = "sans-serif"
        fontWeight = "normal"
        fontStyle = "normal"
        textAlign = "start"
        textBaseline = "alphabetic"
        shadowBlur = 0
        shadowColor = .clear
        shadowOffsetX = 0
        shadowOffsetY = 0
        lineDashPattern = nil
        lineDashOffset = 0
        globalCompositeOperation = .normal

        // Clear bitmap and reset context transform to baseCTM
        if let ctx = bitmapContext {
            let current = ctx.ctm
            ctx.concatenate(current.inverted())
            ctx.clear(CGRect(x: 0, y: 0, width: bitmapWidth, height: bitmapHeight))
            ctx.concatenate(baseCTM)
        }

        layer.contents = nil
    }

    // MARK: - Property Setting

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
            switch value as? String {
            case "round": lineCap = .round
            case "square": lineCap = .square
            default: lineCap = .butt
            }
        case "lineJoin":
            switch value as? String {
            case "round": lineJoin = .round
            case "bevel": lineJoin = .bevel
            default: lineJoin = .miter
            }
        case "miterLimit":
            miterLimit = asCGFloat(value)
        case "font":
            parseFont(value as? String ?? "10px sans-serif")
        case "textAlign":
            textAlign = value as? String ?? "start"
        case "textBaseline":
            textBaseline = value as? String ?? "alphabetic"
        case "globalAlpha":
            globalAlpha = min(max(asCGFloat(value), 0), 1)
        case "shadowBlur":
            shadowBlur = asCGFloat(value)
        case "shadowColor":
            shadowColor = parseCanvasColor(value)
        case "shadowOffsetX":
            shadowOffsetX = asCGFloat(value)
        case "shadowOffsetY":
            shadowOffsetY = asCGFloat(value)
        case "lineDashOffset":
            lineDashOffset = asCGFloat(value)
        case "globalCompositeOperation":
            globalCompositeOperation = parseBlendMode(value as? String)
        default:
            break
        }
    }

    // MARK: - Method Calling

    func callMethod(_ method: String, _ args: [Any?]) -> Any? {
        switch method {
        // Path
        case "beginPath":
            currentPath = CGMutablePath()
            return nil
        case "moveTo":
            currentPath.move(to: CGPoint(x: asCGFloat(args[0]), y: asCGFloat(args[1])))
            return nil
        case "lineTo":
            currentPath.addLine(to: CGPoint(x: asCGFloat(args[0]), y: asCGFloat(args[1])))
            return nil
        case "closePath":
            currentPath.closeSubpath()
            return nil
        case "arc":
            let cx = asCGFloat(args[0]), cy = asCGFloat(args[1])
            let r = asCGFloat(args[2])
            let startAngle = asCGFloat(args[3])
            let endAngle = asCGFloat(args[4])
            let ccw = args.count > 5 ? (args[5] as? Bool ?? false) : false
            currentPath.addArc(center: CGPoint(x: cx, y: cy), radius: r,
                               startAngle: startAngle, endAngle: endAngle,
                               clockwise: ccw)
            return nil
        case "arcTo":
            let x1 = asCGFloat(args[0]), y1 = asCGFloat(args[1])
            let x2 = asCGFloat(args[2]), y2 = asCGFloat(args[3])
            let radius = asCGFloat(args[4])
            currentPath.addArc(tangent1End: CGPoint(x: x1, y: y1),
                               tangent2End: CGPoint(x: x2, y: y2),
                               radius: radius)
            return nil
        case "quadraticCurveTo":
            currentPath.addQuadCurve(to: CGPoint(x: asCGFloat(args[2]), y: asCGFloat(args[3])),
                                     control: CGPoint(x: asCGFloat(args[0]), y: asCGFloat(args[1])))
            return nil
        case "bezierCurveTo":
            currentPath.addCurve(to: CGPoint(x: asCGFloat(args[4]), y: asCGFloat(args[5])),
                                 control1: CGPoint(x: asCGFloat(args[0]), y: asCGFloat(args[1])),
                                 control2: CGPoint(x: asCGFloat(args[2]), y: asCGFloat(args[3])))
            return nil
        case "rect":
            let x = asCGFloat(args[0]), y = asCGFloat(args[1])
            let w = asCGFloat(args[2]), h = asCGFloat(args[3])
            currentPath.addRect(CGRect(x: x, y: y, width: w, height: h))
            return nil
        case "ellipse":
            let cx = asCGFloat(args[0]), cy = asCGFloat(args[1])
            let rx = asCGFloat(args[2]), ry = asCGFloat(args[3])
            let rotation = asCGFloat(args[4])
            let startAngle = asCGFloat(args[5]), endAngle = asCGFloat(args[6])
            let ccw = args.count > 7 ? (args[7] as? Bool ?? false) : false
            addEllipse(cx: cx, cy: cy, rx: rx, ry: ry, rotation: rotation,
                       startAngle: startAngle, endAngle: endAngle, ccw: ccw)
            return nil

        // Drawing — immediate on bitmapContext
        case "fill":
            guard let ctx = bitmapContext else { return nil }
            applyCurrentPaintState(fill: true, to: ctx)
            if let gradient = fillGradient {
                ctx.saveGState()
                ctx.addPath(currentPath)
                ctx.clip()
                gradient.draw(in: ctx)
                ctx.restoreGState()
            } else {
                ctx.addPath(currentPath)
                ctx.fillPath()
            }
            return nil
        case "stroke":
            guard let ctx = bitmapContext else { return nil }
            applyCurrentPaintState(fill: false, to: ctx)
            if let gradient = strokeGradient {
                ctx.saveGState()
                ctx.addPath(currentPath)
                ctx.replacePathWithStrokedPath()
                ctx.clip()
                gradient.draw(in: ctx)
                ctx.restoreGState()
            } else {
                ctx.addPath(currentPath)
                ctx.strokePath()
            }
            return nil
        case "clip":
            guard let ctx = bitmapContext else { return nil }
            ctx.addPath(currentPath)
            ctx.clip()
            return nil
        case "fillRect":
            guard let ctx = bitmapContext else { return nil }
            let rect = CGRect(x: asCGFloat(args[0]), y: asCGFloat(args[1]),
                              width: asCGFloat(args[2]), height: asCGFloat(args[3]))
            applyCurrentPaintState(fill: true, to: ctx)
            if let gradient = fillGradient {
                ctx.saveGState()
                ctx.clip(to: rect)
                gradient.draw(in: ctx)
                ctx.restoreGState()
            } else {
                ctx.fill(rect)
            }
            return nil
        case "strokeRect":
            guard let ctx = bitmapContext else { return nil }
            let rect = CGRect(x: asCGFloat(args[0]), y: asCGFloat(args[1]),
                              width: asCGFloat(args[2]), height: asCGFloat(args[3]))
            applyCurrentPaintState(fill: false, to: ctx)
            ctx.stroke(rect)
            return nil
        case "clearRect":
            guard let ctx = bitmapContext else { return nil }
            let rect = CGRect(x: asCGFloat(args[0]), y: asCGFloat(args[1]),
                              width: asCGFloat(args[2]), height: asCGFloat(args[3]))
            ctx.clear(rect)
            return nil

        // Text
        case "fillText":
            guard let ctx = bitmapContext else { return nil }
            let text = args[0] as? String ?? ""
            let x = asCGFloat(args[1]), y = asCGFloat(args[2])
            drawText(ctx: ctx, text: text, x: x, y: y, fill: true)
            return nil
        case "strokeText":
            guard let ctx = bitmapContext else { return nil }
            let text = args[0] as? String ?? ""
            let x = asCGFloat(args[1]), y = asCGFloat(args[2])
            drawText(ctx: ctx, text: text, x: x, y: y, fill: false)
            return nil
        case "measureText":
            let text = args[0] as? String ?? ""
            let font = resolveFont()
            let attributes: [NSAttributedString.Key: Any] = [.font: font]
            let size = (text as NSString).size(withAttributes: attributes)
            return ["width": size.width]

        // Transform — immediate on bitmapContext
        case "translate":
            guard let ctx = bitmapContext else { return nil }
            ctx.translateBy(x: asCGFloat(args[0]), y: asCGFloat(args[1]))
            return nil
        case "rotate":
            guard let ctx = bitmapContext else { return nil }
            ctx.rotate(by: asCGFloat(args[0]))
            return nil
        case "scale":
            guard let ctx = bitmapContext else { return nil }
            ctx.scaleBy(x: asCGFloat(args[0]), y: asCGFloat(args[1]))
            return nil
        case "transform":
            guard let ctx = bitmapContext else { return nil }
            let a = asCGFloat(args[0]), b = asCGFloat(args[1])
            let c = asCGFloat(args[2]), d = asCGFloat(args[3])
            let tx = asCGFloat(args[4]), ty = asCGFloat(args[5])
            ctx.concatenate(CGAffineTransform(a: a, b: b, c: c, d: d, tx: tx, ty: ty))
            return nil
        case "setTransform":
            guard let ctx = bitmapContext else { return nil }
            let a = asCGFloat(args[0]), b = asCGFloat(args[1])
            let c = asCGFloat(args[2]), d = asCGFloat(args[3])
            let tx = asCGFloat(args[4]), ty = asCGFloat(args[5])
            let userMatrix = CGAffineTransform(a: a, b: b, c: c, d: d, tx: tx, ty: ty)
            // Reset to baseCTM then apply user matrix
            let current = ctx.ctm
            ctx.concatenate(current.inverted())
            ctx.concatenate(baseCTM.concatenating(userMatrix))
            return nil
        case "resetTransform":
            guard let ctx = bitmapContext else { return nil }
            let current = ctx.ctm
            ctx.concatenate(current.inverted())
            ctx.concatenate(baseCTM)
            return nil

        // State
        case "save":
            stateStack.append(captureState())
            bitmapContext?.saveGState()
            return nil
        case "restore":
            if !stateStack.isEmpty {
                restoreState(stateStack.removeLast())
            }
            bitmapContext?.restoreGState()
            return nil

        // Gradients
        case "createLinearGradient":
            return CanvasGradient(
                type: .linear,
                x0: asCGFloat(args[0]), y0: asCGFloat(args[1]),
                x1: asCGFloat(args[2]), y1: asCGFloat(args[3])
            )
        case "createRadialGradient":
            return CanvasGradient(
                type: .radial,
                x0: asCGFloat(args[0]), y0: asCGFloat(args[1]),
                x1: asCGFloat(args[3]), y1: asCGFloat(args[4]),
                r0: asCGFloat(args[2]), r1: asCGFloat(args[5])
            )

        // Line dash
        case "setLineDash":
            if let arr = args[0] as? [Any], !arr.isEmpty {
                lineDashPattern = arr.map { asCGFloat($0) }
            } else {
                lineDashPattern = nil
            }
            return nil
        case "getLineDash":
            return lineDashPattern ?? []

        // drawImage — immediate
        case "drawImage":
            guard let ctx = bitmapContext, let image = args[0] as? UIImage else { return nil }
            applyCurrentPaintState(fill: true, to: ctx)
            UIGraphicsPushContext(ctx)
            if args.count >= 9 {
                // drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)
                let sx = asCGFloat(args[1]), sy = asCGFloat(args[2])
                let sw = asCGFloat(args[3]), sh = asCGFloat(args[4])
                let dx = asCGFloat(args[5]), dy = asCGFloat(args[6])
                let dw = asCGFloat(args[7]), dh = asCGFloat(args[8])
                ctx.saveGState()
                let destRect = CGRect(x: dx, y: dy, width: dw, height: dh)
                ctx.clip(to: destRect)
                if let cgImage = image.cgImage, sw > 0, sh > 0 {
                    let scaleX = CGFloat(cgImage.width)
                    let scaleY = CGFloat(cgImage.height)
                    let sourceRect = CGRect(
                        x: sx / image.size.width * scaleX,
                        y: sy / image.size.height * scaleY,
                        width: sw / image.size.width * scaleX,
                        height: sh / image.size.height * scaleY
                    )
                    if let cropped = cgImage.cropping(to: sourceRect) {
                        let croppedImage = UIImage(cgImage: cropped)
                        croppedImage.draw(in: destRect)
                    }
                }
                ctx.restoreGState()
            } else if args.count >= 5 {
                // drawImage(image, dx, dy, dw, dh)
                let dx = asCGFloat(args[1]), dy = asCGFloat(args[2])
                let dw = asCGFloat(args[3]), dh = asCGFloat(args[4])
                image.draw(in: CGRect(x: dx, y: dy, width: dw, height: dh))
            } else {
                // drawImage(image, dx, dy)
                let dx = asCGFloat(args[1]), dy = asCGFloat(args[2])
                image.draw(at: CGPoint(x: dx, y: dy))
            }
            UIGraphicsPopContext()
            return nil

        // Pixel manipulation
        case "getImageData":
            return getImageData(args)
        case "putImageData":
            putImageData(args)
            return nil

        default:
            return nil
        }
    }

    // MARK: - Rendering to Image

    func renderToImage(size: CGSize? = nil) -> UIImage? {
        guard let cgImage = bitmapContext?.makeImage() else { return nil }
        let image = UIImage(cgImage: cgImage)
        guard let targetSize = size, targetSize.width > 0, targetSize.height > 0,
              targetSize != image.size else {
            return image
        }
        let renderer = UIGraphicsImageRenderer(size: targetSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
    }

    // MARK: - Cleanup

    deinit {
        bitmapData?.deallocate()
    }

    // MARK: - Private Helpers

    private func applyCurrentPaintState(fill: Bool, to ctx: CGContext) {
        let color: UIColor
        if fill {
            color = fillColor.withAlphaComponent(globalAlpha)
            ctx.setFillColor(color.cgColor)
        } else {
            color = strokeColor.withAlphaComponent(globalAlpha)
            ctx.setStrokeColor(color.cgColor)
        }
        ctx.setLineWidth(lineWidth)
        ctx.setLineCap(lineCap)
        ctx.setLineJoin(lineJoin)
        ctx.setMiterLimit(miterLimit)
        ctx.setBlendMode(globalCompositeOperation)

        if shadowBlur > 0 || shadowOffsetX != 0 || shadowOffsetY != 0 {
            ctx.setShadow(offset: CGSize(width: shadowOffsetX, height: shadowOffsetY),
                          blur: shadowBlur, color: shadowColor.cgColor)
        } else {
            ctx.setShadow(offset: .zero, blur: 0, color: nil)
        }

        if let dash = lineDashPattern, !dash.isEmpty {
            ctx.setLineDash(phase: lineDashOffset, lengths: dash)
        } else {
            ctx.setLineDash(phase: 0, lengths: [])
        }
    }

    private func addEllipse(cx: CGFloat, cy: CGFloat, rx: CGFloat, ry: CGFloat,
                            rotation: CGFloat, startAngle: CGFloat, endAngle: CGFloat, ccw: Bool) {
        let ellipsePath = CGMutablePath()
        var transform = CGAffineTransform.identity
        transform = transform.translatedBy(x: cx, y: cy)
        transform = transform.rotated(by: rotation)
        transform = transform.scaledBy(x: rx, y: ry)
        ellipsePath.addArc(center: .zero, radius: 1,
                           startAngle: startAngle, endAngle: endAngle,
                           clockwise: ccw, transform: transform)
        currentPath.addPath(ellipsePath)
    }

    private func parseFont(_ fontString: String) {
        let parts = fontString.trimmingCharacters(in: .whitespaces).components(separatedBy: .whitespaces)
        var idx = 0

        if idx < parts.count && (parts[idx] == "italic" || parts[idx] == "oblique") {
            fontStyle = parts[idx]
            idx += 1
        } else {
            fontStyle = "normal"
        }

        if idx < parts.count {
            let w = parts[idx]
            if w == "bold" || w == "bolder" || w == "lighter" || Int(w) != nil {
                fontWeight = w
                idx += 1
            } else {
                fontWeight = "normal"
            }
        }

        if idx < parts.count {
            fontSize = CGFloat(Float(parts[idx].replacingOccurrences(of: "px", with: "")) ?? 10)
            idx += 1
        }

        if idx < parts.count {
            fontFamily = parts[idx...].joined(separator: " ")
                .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        }
    }

    private func resolveFont() -> UIFont {
        let isBold = fontWeight == "bold" || fontWeight == "bolder" ||
            (Int(fontWeight) ?? 0) >= 600
        let isItalic = fontStyle == "italic" || fontStyle == "oblique"

        var traits: UIFontDescriptor.SymbolicTraits = []
        if isBold { traits.insert(.traitBold) }
        if isItalic { traits.insert(.traitItalic) }

        let baseFont = UIFont.systemFont(ofSize: fontSize)
        if let descriptor = baseFont.fontDescriptor.withSymbolicTraits(traits) {
            return UIFont(descriptor: descriptor, size: fontSize)
        }
        return baseFont
    }

    // MARK: - Text Drawing (immediate)

    private func drawText(ctx: CGContext, text: String, x: CGFloat, y: CGFloat, fill: Bool) {
        let font = resolveFont()
        let color = (fill ? fillColor : strokeColor).withAlphaComponent(globalAlpha)

        var attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: color,
        ]
        if !fill {
            attributes[.strokeColor] = color
            attributes[.strokeWidth] = lineWidth
            attributes[.foregroundColor] = UIColor.clear
        }

        let textSize = (text as NSString).size(withAttributes: attributes)
        let drawX = adjustTextX(x, textWidth: textSize.width, align: textAlign)
        let drawY = adjustTextY(y, font: font, baseline: textBaseline)

        applyCurrentPaintState(fill: fill, to: ctx)

        UIGraphicsPushContext(ctx)
        (text as NSString).draw(at: CGPoint(x: drawX, y: drawY), withAttributes: attributes)
        UIGraphicsPopContext()
    }

    private func adjustTextX(_ x: CGFloat, textWidth: CGFloat, align: String) -> CGFloat {
        switch align {
        case "center": return x - textWidth / 2
        case "right", "end": return x - textWidth
        default: return x
        }
    }

    private func adjustTextY(_ y: CGFloat, font: UIFont, baseline: String) -> CGFloat {
        switch baseline {
        case "top", "hanging":
            return y
        case "middle":
            return y - font.capHeight / 2
        case "bottom":
            return y - (font.ascender - font.descender)
        case "alphabetic":
            return y - font.ascender
        default:
            return y - font.ascender
        }
    }

    // MARK: - Pixel Manipulation

    private func getImageData(_ args: [Any?]) -> Any? {
        guard let data = bitmapData else { return nil }
        let sx = Int(asCGFloat(args[0]))
        let sy = Int(asCGFloat(args[1]))
        let sw = Int(asCGFloat(args[2]))
        let sh = Int(asCGFloat(args[3]))
        guard sw > 0, sh > 0 else { return nil }

        var result: [UInt8] = []
        result.reserveCapacity(sw * sh * 4)
        let bytesPerRow = bitmapWidth * 4
        let ptr = data.assumingMemoryBound(to: UInt8.self)

        for row in sy..<(sy + sh) {
            for col in sx..<(sx + sw) {
                if row >= 0, row < bitmapHeight, col >= 0, col < bitmapWidth {
                    // Bitmap is BGRA premultiplied; convert to RGBA unpremultiplied
                    let offset = row * bytesPerRow + col * 4
                    let b = ptr[offset]
                    let g = ptr[offset + 1]
                    let r = ptr[offset + 2]
                    let a = ptr[offset + 3]
                    if a > 0 && a < 255 {
                        let af = Float(a)
                        result.append(UInt8(min(Float(r) * 255.0 / af, 255)))
                        result.append(UInt8(min(Float(g) * 255.0 / af, 255)))
                        result.append(UInt8(min(Float(b) * 255.0 / af, 255)))
                    } else {
                        result.append(r)
                        result.append(g)
                        result.append(b)
                    }
                    result.append(a)
                } else {
                    result.append(contentsOf: [0, 0, 0, 0])
                }
            }
        }
        return ["width": sw, "height": sh, "data": result]
    }

    private func putImageData(_ args: [Any?]) {
        guard let data = bitmapData else { return }
        guard let imageData = args[0] as? [String: Any],
              let pixels = imageData["data"] as? [Any] else { return }
        let dx = Int(asCGFloat(args[1]))
        let dy = Int(asCGFloat(args[2]))
        let iw = imageData["width"] as? Int ?? 0
        let ih = imageData["height"] as? Int ?? 0
        guard iw > 0, ih > 0 else { return }

        let bytesPerRow = bitmapWidth * 4
        let ptr = data.assumingMemoryBound(to: UInt8.self)

        for row in 0..<ih {
            for col in 0..<iw {
                let targetX = dx + col
                let targetY = dy + row
                guard targetX >= 0, targetX < bitmapWidth, targetY >= 0, targetY < bitmapHeight else { continue }
                let srcIdx = (row * iw + col) * 4
                guard srcIdx + 3 < pixels.count else { continue }

                let r = UInt8(clamping: Int(asCGFloat(pixels[srcIdx])))
                let g = UInt8(clamping: Int(asCGFloat(pixels[srcIdx + 1])))
                let b = UInt8(clamping: Int(asCGFloat(pixels[srcIdx + 2])))
                let a = UInt8(clamping: Int(asCGFloat(pixels[srcIdx + 3])))

                // Convert RGBA to BGRA premultiplied
                let offset = targetY * bytesPerRow + targetX * 4
                if a == 255 {
                    ptr[offset] = b
                    ptr[offset + 1] = g
                    ptr[offset + 2] = r
                    ptr[offset + 3] = a
                } else if a == 0 {
                    ptr[offset] = 0
                    ptr[offset + 1] = 0
                    ptr[offset + 2] = 0
                    ptr[offset + 3] = 0
                } else {
                    let af = Float(a) / 255.0
                    ptr[offset] = UInt8(Float(b) * af)
                    ptr[offset + 1] = UInt8(Float(g) * af)
                    ptr[offset + 2] = UInt8(Float(r) * af)
                    ptr[offset + 3] = a
                }
            }
        }
    }

    // MARK: - Blend Mode

    private func parseBlendMode(_ value: String?) -> CGBlendMode {
        switch value {
        case "source-over": return .normal
        case "source-atop": return .sourceAtop
        case "source-in": return .sourceIn
        case "source-out": return .sourceOut
        case "destination-over": return .destinationOver
        case "destination-atop": return .destinationAtop
        case "destination-in": return .destinationIn
        case "destination-out": return .destinationOut
        case "lighter": return .plusLighter
        case "copy": return .copy
        case "xor": return .xor
        case "multiply": return .multiply
        case "screen": return .screen
        case "overlay": return .overlay
        case "darken": return .darken
        case "lighten": return .lighten
        case "color-dodge": return .colorDodge
        case "color-burn": return .colorBurn
        case "hard-light": return .hardLight
        case "soft-light": return .softLight
        case "difference": return .difference
        case "exclusion": return .exclusion
        case "hue": return .hue
        case "saturation": return .saturation
        case "color": return .color
        case "luminosity": return .luminosity
        default: return .normal
        }
    }

    // MARK: - State Save/Restore

    private struct CanvasDrawState {
        let fillColor: UIColor
        let strokeColor: UIColor
        let fillGradient: CanvasGradient?
        let strokeGradient: CanvasGradient?
        let lineWidth: CGFloat
        let lineCap: CGLineCap
        let lineJoin: CGLineJoin
        let miterLimit: CGFloat
        let globalAlpha: CGFloat
        let fontSize: CGFloat
        let fontFamily: String
        let fontWeight: String
        let fontStyle: String
        let textAlign: String
        let textBaseline: String
        let shadowBlur: CGFloat
        let shadowColor: UIColor
        let shadowOffsetX: CGFloat
        let shadowOffsetY: CGFloat
        let lineDashPattern: [CGFloat]?
        let lineDashOffset: CGFloat
        let globalCompositeOperation: CGBlendMode
    }

    private func captureState() -> CanvasDrawState {
        return CanvasDrawState(
            fillColor: fillColor, strokeColor: strokeColor,
            fillGradient: fillGradient, strokeGradient: strokeGradient,
            lineWidth: lineWidth,
            lineCap: lineCap, lineJoin: lineJoin, miterLimit: miterLimit,
            globalAlpha: globalAlpha, fontSize: fontSize, fontFamily: fontFamily,
            fontWeight: fontWeight, fontStyle: fontStyle, textAlign: textAlign,
            textBaseline: textBaseline, shadowBlur: shadowBlur, shadowColor: shadowColor,
            shadowOffsetX: shadowOffsetX, shadowOffsetY: shadowOffsetY,
            lineDashPattern: lineDashPattern, lineDashOffset: lineDashOffset,
            globalCompositeOperation: globalCompositeOperation
        )
    }

    private func restoreState(_ state: CanvasDrawState) {
        fillColor = state.fillColor
        strokeColor = state.strokeColor
        fillGradient = state.fillGradient
        strokeGradient = state.strokeGradient
        lineWidth = state.lineWidth
        lineCap = state.lineCap
        lineJoin = state.lineJoin
        miterLimit = state.miterLimit
        globalAlpha = state.globalAlpha
        fontSize = state.fontSize
        fontFamily = state.fontFamily
        fontWeight = state.fontWeight
        fontStyle = state.fontStyle
        textAlign = state.textAlign
        textBaseline = state.textBaseline
        shadowBlur = state.shadowBlur
        shadowColor = state.shadowColor
        shadowOffsetX = state.shadowOffsetX
        shadowOffsetY = state.shadowOffsetY
        lineDashPattern = state.lineDashPattern
        lineDashOffset = state.lineDashOffset
        globalCompositeOperation = state.globalCompositeOperation
    }
}

// MARK: - CanvasGradient

class CanvasGradient {
    enum GradientType { case linear, radial }

    let type: GradientType
    let x0: CGFloat
    let y0: CGFloat
    let x1: CGFloat
    let y1: CGFloat
    let r0: CGFloat
    let r1: CGFloat
    private var stops: [(CGFloat, UIColor)] = []

    init(type: GradientType,
         x0: CGFloat = 0, y0: CGFloat = 0,
         x1: CGFloat = 0, y1: CGFloat = 0,
         r0: CGFloat = 0, r1: CGFloat = 0) {
        self.type = type
        self.x0 = x0
        self.y0 = y0
        self.x1 = x1
        self.y1 = y1
        self.r0 = r0
        self.r1 = r1
    }

    func addColorStop(_ offset: CGFloat, _ color: UIColor) {
        stops.append((offset, color))
        stops.sort { $0.0 < $1.0 }
    }

    func draw(in ctx: CGContext) {
        guard stops.count >= 2 else { return }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var cgColors: [CGColor] = []
        var locations: [CGFloat] = []
        for (offset, color) in stops {
            cgColors.append(color.cgColor)
            locations.append(offset)
        }
        guard let gradient = CGGradient(colorsSpace: colorSpace,
                                        colors: cgColors as CFArray,
                                        locations: locations) else { return }
        switch type {
        case .linear:
            ctx.drawLinearGradient(gradient,
                                   start: CGPoint(x: x0, y: y0),
                                   end: CGPoint(x: x1, y: y1),
                                   options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        case .radial:
            ctx.drawRadialGradient(gradient,
                                    startCenter: CGPoint(x: x0, y: y0), startRadius: r0,
                                    endCenter: CGPoint(x: x1, y: y1), endRadius: r1,
                                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
    }
}

// MARK: - Utility

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

func parseCanvasColor(_ value: Any?) -> UIColor {
    guard let str = value as? String else { return .black }
    let color = str.trimmingCharacters(in: .whitespaces).lowercased()

    if color == "transparent" { return .clear }

    // Named colors
    let namedColors: [String: UIColor] = [
        "black": .black, "white": .white, "red": .red, "green": UIColor(red: 0, green: 0.502, blue: 0, alpha: 1),
        "blue": .blue, "yellow": .yellow, "cyan": .cyan, "magenta": .magenta,
        "gray": .gray, "grey": .gray, "orange": .orange, "purple": .purple, "brown": .brown,
    ]
    if let named = namedColors[color] { return named }

    // #hex
    if color.hasPrefix("#") {
        return parseHexColor(color)
    }

    // rgba() / rgb()
    if color.hasPrefix("rgba(") || color.hasPrefix("rgb(") {
        return parseRgbColor(color)
    }

    return .black
}

private func parseHexColor(_ hex: String) -> UIColor {
    var hexStr = String(hex.dropFirst()) // remove #
    if hexStr.count == 3 {
        hexStr = hexStr.map { "\($0)\($0)" }.joined()
    } else if hexStr.count == 4 {
        let chars = Array(hexStr)
        hexStr = "\(chars[0])\(chars[0])\(chars[1])\(chars[1])\(chars[2])\(chars[2])\(chars[3])\(chars[3])"
    }

    var rgbValue: UInt64 = 0
    Scanner(string: hexStr).scanHexInt64(&rgbValue)

    if hexStr.count == 8 {
        let r = CGFloat((rgbValue >> 24) & 0xFF) / 255
        let g = CGFloat((rgbValue >> 16) & 0xFF) / 255
        let b = CGFloat((rgbValue >> 8) & 0xFF) / 255
        let a = CGFloat(rgbValue & 0xFF) / 255
        return UIColor(red: r, green: g, blue: b, alpha: a)
    } else {
        let r = CGFloat((rgbValue >> 16) & 0xFF) / 255
        let g = CGFloat((rgbValue >> 8) & 0xFF) / 255
        let b = CGFloat(rgbValue & 0xFF) / 255
        return UIColor(red: r, green: g, blue: b, alpha: 1)
    }
}

private func parseRgbColor(_ color: String) -> UIColor {
    let values = color
        .components(separatedBy: "(").last?
        .components(separatedBy: ")").first?
        .components(separatedBy: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) } ?? []

    let r = CGFloat(Float(values[safe: 0] ?? "0") ?? 0) / 255
    let g = CGFloat(Float(values[safe: 1] ?? "0") ?? 0) / 255
    let b = CGFloat(Float(values[safe: 2] ?? "0") ?? 0) / 255
    var a: CGFloat = 1
    if let aStr = values[safe: 3], let aVal = Float(aStr) {
        a = CGFloat(aVal <= 1 ? aVal : aVal / 255)
    }
    return UIColor(red: min(max(r, 0), 1), green: min(max(g, 0), 1),
                   blue: min(max(b, 0), 1), alpha: min(max(a, 0), 1))
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        return indices.contains(index) ? self[index] : nil
    }
}
