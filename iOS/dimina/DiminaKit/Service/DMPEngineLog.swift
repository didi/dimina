//
//  DMPEngineLog.swift
//  dimina
//
//  Created by Lehem on 2025/4/16.
//

import Foundation
import JavaScriptCore

public enum LogLevel: Int {
    case log = 0
    case info = 1
    case warn = 2
    case error = 3
    
    var prefix: String {
        switch self {
        case .log: return "LOG"
        case .info: return "INFO"
        case .warn: return "WARN"
        case .error: return "ERROR"
        }
    }
}

public class DMPEngineLog {
    
    public static func injectConsole(to context: JSContext) {
        let console = JSValue(newObjectIn: context)
        
        let consoleLog: @convention(block) (JSValue) -> Void = { value in
            printLog(.log, values: [value])
        }
        
        let consoleInfo: @convention(block) (JSValue) -> Void = { value in
            printLog(.info, values: [value])
        }
        
        let consoleWarn: @convention(block) (JSValue) -> Void = { value in
            printLog(.warn, values: [value])
        }
        
        let consoleError: @convention(block) (JSValue) -> Void = { value in
            printLog(.error, values: [value])
        }
        
        console?.setObject(consoleLog, forKeyedSubscript: "log" as NSString)
        console?.setObject(consoleInfo, forKeyedSubscript: "info" as NSString)
        console?.setObject(consoleWarn, forKeyedSubscript: "warn" as NSString)
        console?.setObject(consoleError, forKeyedSubscript: "error" as NSString)
        
        context.setObject(console!, forKeyedSubscript: "console" as NSString)
    }
    
    private static func printLog(_ level: LogLevel, values: [JSValue]) {
        let stringValues = values.map { formatJSValue($0) }
        let message = stringValues.joined(separator: " ")
        
        switch level {
        case .log, .info:
            DMPLogger.debug("[\(level.prefix)] \(message)")
        case .warn:
            DMPLogger.debug("⚠️ [\(level.prefix)] \(message)")
        case .error:
            DMPLogger.debug("❌ [\(level.prefix)] \(message)")
        }
    }
    
    private static func formatJSValue(_ value: JSValue) -> String {
        if value.isNull || value.isUndefined {
            return value.isNull ? "null" : "undefined"
        } else if value.isString || value.isNumber || value.isBoolean {
            return value.toString()
        } else if value.isArray {
            guard let array = value.toArray() else { return "[]" }
            let formattedItems = array.compactMap { item -> String? in
                if let jsValue = item as? JSValue {
                    return formatJSValue(jsValue)
                }
                return "\(item)"
            }
            return "[\(formattedItems.joined(separator: ", "))]"
        } else if value.isObject {
            if let dict = value.toDictionary() {
                do {
                    let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted])
                    if let jsonString = String(data: data, encoding: .utf8) {
                        return jsonString
                    }
                } catch {
                }
            } else {
                return value.toString() ?? "Object"
            }
        }
        
        return value.toString() ?? "Unknown"
    }
}




