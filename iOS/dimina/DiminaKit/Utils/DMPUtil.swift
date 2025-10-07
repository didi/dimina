//
//  DMPUtil.swift
//  dimina
//
//  Created by Lehem on 2025/4/27.
//

import Foundation
import SwiftUI
import UIKit

public class DMPUtil {
    
    public static func jsonEncode(from dict: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
    
    public static func jsonEncode(from dict: [AnyHashable: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }
    
    public static func jsonEncode(from array: [Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: array, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public static func jsonDecodeToDict(from jsonString: String) -> [String: Any]? {
        guard let data = jsonString.data(using: .utf8) else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
    }

    public static func jsonDecodeToArray(from jsonString: String) -> [Any]? {
        guard let data = jsonString.data(using: .utf8) else {
            return nil
        }
        return try? JSONSerialization.jsonObject(with: data, options: []) as? [Any]
    }

    public static func queryPath(path: String) -> [String: Any] {
        let parts = path.components(separatedBy: "?")
        let pagePath = parts[0]
        var paramsDict: [String: String] = [:]

        if parts.count > 1, let paramStr = parts[1].components(separatedBy: "&").first {
            for param in paramStr.components(separatedBy: "&") {
                let keyValueArray = param.components(separatedBy: "=")
                guard keyValueArray.count == 2 else { continue }
                
                let (key, value) = (keyValueArray[0], keyValueArray[1])
                paramsDict[key] = value
            }
        }

        return ["query": paramsDict as Any, "pagePath": pagePath]
    }

    public static func generateColorFromName(name: String) -> Color {
        // If name is empty, return a default color (Material Blue)
        if name.isEmpty {
            return Color(red: 33/255, green: 150/255, blue: 243/255)
        }

        // Custom hash function to exactly match Kotlin's String.hashCode()
        func customHash(_ string: String) -> Int32 {
            var hash: Int32 = 0
            for char in string.unicodeScalars {
                hash = 31 &* hash &+ Int32(char.value)
            }
            return hash
        }

        // Generate hash to match Kotlin's hashCode()
        let hash = customHash(name)

        // Generate HSV color with consistent hue based on name
        // Match Kotlin's calculations exactly
        let hue = Float(abs(hash % 360))
        let saturation = 0.7 + Float(hash % 3000) / 10000.0 // Range: 0.7-1.0
        let value = 0.8 + Float(hash % 2000) / 10000.0 // Range: 0.8-1.0

        // Convert HSV to Color, ensuring hue is in 0-1 range for SwiftUI
        return Color(hue: Double(hue / 360.0),
                     saturation: Double(saturation),
                     brightness: Double(value))
    }
    
    public static func colorFromHexString(_ hexString: String) -> UIColor? {
        var cleanedHex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        
        // 移除 # 前缀
        if cleanedHex.hasPrefix("#") {
            cleanedHex = String(cleanedHex.dropFirst())
        }
        
        // 处理简写：3 位 → 6 位，4 位（含 Alpha）→ 8 位
        if [3, 4].contains(cleanedHex.count) {
            cleanedHex = cleanedHex.map { "\($0)\($0)" }.joined()
        }
        
        // 验证有效长度（6 位 RGB 或 8 位 RGBA）
        guard [6, 8].contains(cleanedHex.count) else {
            return nil
        }
        
        // 解析十六进制数值
        var color: UInt64 = 0
        guard Scanner(string: cleanedHex).scanHexInt64(&color) else {
            return nil
        }
        
        // 提取颜色分量
        let divisor: CGFloat = 255.0
        let r, g, b, a: CGFloat
        if cleanedHex.count == 8 {
            // RGBA（8 位）
            r = CGFloat((color & 0xFF000000) >> 24) / divisor
            g = CGFloat((color & 0x00FF0000) >> 16) / divisor
            b = CGFloat((color & 0x0000FF00) >> 8)  / divisor
            a = CGFloat( color & 0x000000FF)        / divisor
        } else {
            // RGB（6 位）
            r = CGFloat((color & 0xFF0000) >> 16) / divisor
            g = CGFloat((color & 0x00FF00) >> 8)  / divisor
            b = CGFloat( color & 0x0000FF)        / divisor
            a = 1.0
        }
        
        return UIColor(red: r, green: g, blue: b, alpha: a)
    }}
