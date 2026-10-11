import Foundation
import JavaScriptCore

/// Only use on the owning engine's JS thread. Native messages contain Foundation
/// values, never JSValues retained by another thread or engine.
enum DMPBinaryBridge {
    static func encode(_ value: Any, in context: JSContext) -> JSValue {
        if let data = value as? Data {
            // JSCore owns this independent copy until the ArrayBuffer is collected.
            // Retaining Data's withUnsafeBytes pointer would outlive its valid scope.
            let bytes = UnsafeMutableRawPointer.allocate(byteCount: max(1, data.count), alignment: 1)
            data.withUnsafeBytes { source in
                if let base = source.baseAddress, !data.isEmpty {
                    bytes.copyMemory(from: base, byteCount: data.count)
                }
            }
            var exception: JSValueRef?
            let buffer = JSObjectMakeArrayBufferWithBytesNoCopy(
                context.jsGlobalContextRef, bytes, data.count,
                { bytes, _ in bytes?.deallocate() }, nil, &exception
            )
            // JSCore calls the deallocator on failure too.
            if let exception {
                context.exception = JSValue(jsValueRef: exception, in: context)
            }
            guard let buffer else { return JSValue(undefinedIn: context) }
            return JSValue(jsValueRef: buffer, in: context)
        }
        if let map = value as? DMPMap { return encode(map.toDictionary(), in: context) }
        if let dict = value as? [String: Any] {
            let object = JSValue(newObjectIn: context)!
            for (key, item) in dict {
                object.defineProperty(key, descriptor: [
                    "value": encode(item, in: context),
                    "writable": true, "enumerable": true, "configurable": true
                ])
            }
            return object
        }
        if let array = value as? [Any] {
            let object = JSValue(newArrayIn: context)!
            for (index, item) in array.enumerated() { object.setValue(encode(item, in: context), at: index) }
            return object
        }
        return JSValue(object: value, in: context)
    }

    static func decodeBuffer(_ value: JSValue) -> Data? {
        let context = value.context.jsGlobalContextRef!
        guard JSValueGetTypedArrayType(context, value.jsValueRef, nil) == kJSTypedArrayTypeArrayBuffer,
              let object = JSValueToObject(context, value.jsValueRef, nil) else { return nil }
        let length = JSObjectGetArrayBufferByteLength(context, object, nil)
        if length == 0 { return Data() }
        // The temporary pointer cannot survive another JSCore API call.
        guard let bytes = JSObjectGetArrayBufferBytesPtr(context, object, nil) else { return nil }
        return Data(bytes: bytes, count: length)
    }

    /// Avoid toDictionary on binary file parameters: Foundation would enumerate
    /// typed arrays or lose ArrayBuffer contents before the file handler sees them.
    static func decodeFileParams(_ value: JSValue) -> Any {
        guard value.isObject, !value.isArray,
              let object = JSValueToObject(value.context.jsGlobalContextRef, value.jsValueRef, nil),
              let names = JSObjectCopyPropertyNames(value.context.jsGlobalContextRef, object) else {
            return value.toObject() ?? NSNull()
        }
        defer { JSPropertyNameArrayRelease(names) }
        var result: [String: Any] = [:]
        for index in 0..<JSPropertyNameArrayGetCount(names) {
            let name = JSPropertyNameArrayGetNameAtIndex(names, index)!
            let key = JSValue(jsValueRef: JSValueMakeString(value.context.jsGlobalContextRef, name), in: value.context).toString()!
            guard let item = value.forProperty(key) else { continue }
            if (key == "data" || key == "arrayBuffer"), let data = decodeBuffer(item) {
                result[key] = data
            } else {
                result[key] = item.toObject() ?? NSNull()
            }
        }
        return result
    }
}
