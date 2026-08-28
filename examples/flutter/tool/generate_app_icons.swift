#!/usr/bin/env swift

import AppKit
import Foundation

private let fileManager = FileManager.default
private let scriptURL = URL(fileURLWithPath: #filePath)
private let exampleRoot = scriptURL
  .deletingLastPathComponent()
  .deletingLastPathComponent()
private let repositoryRoot = exampleRoot
  .deletingLastPathComponent()
  .deletingLastPathComponent()

private let diminaSourceURL = repositoryRoot
  .appendingPathComponent("iOS/dimina/Assets.xcassets/AppIcon.appiconset/icon_light_1024x1024.png")
private let flutterSourceURL = scriptURL
  .deletingLastPathComponent()
  .appendingPathComponent("flutter_logo_source.png")

private func loadImage(at url: URL) throws -> NSImage {
  guard let image = NSImage(contentsOf: url) else {
    throw NSError(
      domain: "DiminaFlutterIconGenerator",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Unable to load image: \(url.path)"]
    )
  }
  return image
}

private func bitmap(size: Int, drawing: () -> Void) throws -> NSBitmapImageRep {
  let colorSpace = CGColorSpaceCreateDeviceRGB()
  guard let bitmapContext = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
  ) else {
    throw NSError(
      domain: "DiminaFlutterIconGenerator",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "Unable to allocate a \(size)x\(size) bitmap"]
    )
  }

  NSGraphicsContext.saveGraphicsState()
  defer { NSGraphicsContext.restoreGraphicsState() }

  let context = NSGraphicsContext(cgContext: bitmapContext, flipped: false)
  NSGraphicsContext.current = context
  context.imageInterpolation = NSImageInterpolation.high
  context.shouldAntialias = true
  drawing()
  context.flushGraphics()

  guard let image = bitmapContext.makeImage() else {
    throw NSError(
      domain: "DiminaFlutterIconGenerator",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create a bitmap image"]
    )
  }
  let representation = NSBitmapImageRep(cgImage: image)
  representation.size = NSSize(width: size, height: size)
  return representation
}

private func writePNG(_ representation: NSBitmapImageRep, to url: URL) throws {
  try fileManager.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  guard let data = representation.representation(using: .png, properties: [:]) else {
    throw NSError(
      domain: "DiminaFlutterIconGenerator",
      code: 4,
      userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG: \(url.path)"]
    )
  }
  try data.write(to: url, options: .atomic)
}

private func makeMaster(dimina: NSImage, flutter: NSImage) throws -> NSBitmapImageRep {
  let canvas = NSRect(x: 0, y: 0, width: 1024, height: 1024)
  return try bitmap(size: 1024) {
    NSColor(calibratedRed: 0.98, green: 0.99, blue: 1.0, alpha: 1.0).setFill()
    canvas.fill()

    dimina.draw(
      in: canvas,
      from: .zero,
      operation: .sourceOver,
      fraction: 1.0,
      respectFlipped: false,
      hints: [.interpolation: NSImageInterpolation.high]
    )

    let badgeRect = NSRect(x: 570, y: 100, width: 320, height: 320)
    let badgePath = NSBezierPath(roundedRect: badgeRect, xRadius: 82, yRadius: 82)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor(calibratedWhite: 0.08, alpha: 0.22)
    shadow.shadowBlurRadius = 28
    shadow.shadowOffset = NSSize(width: 0, height: -10)
    shadow.set()
    NSColor.white.setFill()
    badgePath.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSColor(calibratedRed: 0.12, green: 0.48, blue: 0.97, alpha: 0.24).setStroke()
    badgePath.lineWidth = 4
    badgePath.stroke()

    // Crop the whitespace from Flutter's official mark before fitting it in the badge.
    let flutterCrop = NSRect(x: 150, y: 120, width: 700, height: 800)
    let flutterRect = NSRect(x: 626, y: 132, width: 208, height: 258)
    flutter.draw(
      in: flutterRect,
      from: flutterCrop,
      operation: .sourceOver,
      fraction: 1.0,
      respectFlipped: false,
      hints: [.interpolation: NSImageInterpolation.high]
    )
  }
}

private func resize(_ master: NSBitmapImageRep, to size: Int) throws -> NSBitmapImageRep {
  let image = NSImage(size: NSSize(width: 1024, height: 1024))
  image.addRepresentation(master)
  return try bitmap(size: size) {
    NSColor.white.setFill()
    NSRect(x: 0, y: 0, width: size, height: size).fill()
    image.draw(
      in: NSRect(x: 0, y: 0, width: size, height: size),
      from: NSRect(x: 0, y: 0, width: 1024, height: 1024),
      operation: .sourceOver,
      fraction: 1.0,
      respectFlipped: false,
      hints: [.interpolation: NSImageInterpolation.high]
    )
  }
}

private func output(_ relativePath: String, size: Int, master: NSBitmapImageRep) throws {
  let target = exampleRoot.appendingPathComponent(relativePath)
  let representation = size == 1024 ? master : try resize(master, to: size)
  try writePNG(representation, to: target)
  print("generated \(relativePath) (\(size)x\(size))")
}

do {
  let dimina = try loadImage(at: diminaSourceURL)
  let flutter = try loadImage(at: flutterSourceURL)
  let master = try makeMaster(dimina: dimina, flutter: flutter)

  try output("assets/app_icon.png", size: 1024, master: master)

  let androidIcons: [(String, Int)] = [
    ("android/app/src/main/res/mipmap-mdpi/ic_launcher.png", 48),
    ("android/app/src/main/res/mipmap-hdpi/ic_launcher.png", 72),
    ("android/app/src/main/res/mipmap-xhdpi/ic_launcher.png", 96),
    ("android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png", 144),
    ("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", 192),
  ]
  for (path, size) in androidIcons {
    try output(path, size: size, master: master)
  }

  let iosIcons: [(String, Int)] = [
    ("Icon-App-20x20@1x.png", 20),
    ("Icon-App-20x20@2x.png", 40),
    ("Icon-App-20x20@3x.png", 60),
    ("Icon-App-29x29@1x.png", 29),
    ("Icon-App-29x29@2x.png", 58),
    ("Icon-App-29x29@3x.png", 87),
    ("Icon-App-40x40@1x.png", 40),
    ("Icon-App-40x40@2x.png", 80),
    ("Icon-App-40x40@3x.png", 120),
    ("Icon-App-60x60@2x.png", 120),
    ("Icon-App-60x60@3x.png", 180),
    ("Icon-App-76x76@1x.png", 76),
    ("Icon-App-76x76@2x.png", 152),
    ("Icon-App-83.5x83.5@2x.png", 167),
    ("Icon-App-1024x1024@1x.png", 1024),
  ]
  let iosDirectory = "ios/Runner/Assets.xcassets/AppIcon.appiconset"
  for (name, size) in iosIcons {
    try output("\(iosDirectory)/\(name)", size: size, master: master)
  }

  try output("ohos/AppScope/resources/base/media/app_icon.png", size: 1024, master: master)
  try output("ohos/entry/src/main/resources/base/media/icon.png", size: 216, master: master)
} catch {
  fputs("error: \(error.localizedDescription)\n", stderr)
  exit(EXIT_FAILURE)
}
