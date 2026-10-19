import Foundation
import JavaScriptCore
import DiminaWasmBridge

struct DMPCanvasPacket {
    let json: String
    let buffers: [Data]

    static func serializer(in context: JSContext) -> JSValue {
        if let existing = context.globalObject.forProperty("__diminaCanvasSerialize"), !existing.isUndefined { return existing }
        // Use JSON.stringify's own traversal, getters and toJSON semantics.
        let function = context.evaluateScript("""
        (function(value) {
            const buffers = []; let bytes = 0;
            const json = JSON.stringify(value, function(key, item) {
                if (key === 'packed' && item instanceof ArrayBuffer &&
                    Object.prototype.hasOwnProperty.call(this, '__canvasTypedArray') &&
                    typeof this.__canvasTypedArray === 'string') {
                    bytes += item.byteLength;
                    if (buffers.length >= 4096 || bytes > 67108864) throw new RangeError('canvas packet exceeds budget');
                    buffers.push(item);
                    return {__canvasBinaryIndex: buffers.length - 1};
                }
                return item;
            });
            return {json, buffers};
        })
        """)!
        context.globalObject.defineProperty("__diminaCanvasSerialize", descriptor: ["value": function])
        return function
    }

    static func read(_ value: JSValue, using serializer: JSValue) throws -> DMPCanvasPacket {
        guard let result = serializer.call(withArguments: [value]), !result.isUndefined,
              let json = result.forProperty("json")?.toString(), json.utf8.count <= 64 * 1024 * 1024 else {
            throw NSError(domain: "CanvasPacket", code: 1)
        }
        let values = result.forProperty("buffers")!
        let count = Int(values.forProperty("length")!.toInt32())
        var buffers: [Data] = []
        for index in 0..<count {
            guard let bytes = DMPBinaryBridge.decodeBuffer(values.atIndex(index)!) else {
                throw NSError(domain: "CanvasPacket", code: 2)
            }
            buffers.append(bytes)
        }
        return DMPCanvasPacket(json: json, buffers: buffers)
    }

    func wire(type: String, deadline: Int64) throws -> Data {
        let body = try JSONSerialization.jsonObject(with: Data(json.utf8))
        let header = try JSONSerialization.data(withJSONObject: [
            "type": type, "body": body, "deadline": deadline,
            "byteLengths": buffers.map(\.count)
        ])
        guard header.count + 4 + buffers.reduce(0, { $0 + $1.count }) <= 64 * 1024 * 1024 else {
            throw NSError(domain: "CanvasPacket", code: 3)
        }
        var length = UInt32(header.count).littleEndian
        var data = withUnsafeBytes(of: &length) { Data($0) }
        data.append(header)
        for bytes in buffers { data.append(bytes) }
        return data
    }

    static func installEncoder(in context: JSContext, appResolver: @escaping () -> DMPApp?) {
        let encode: @convention(block) (JSValue, Int) -> JSValue = { [weak context] value, page in
            guard let context else { return JSValue(undefinedIn: value.context) }
            guard let bytes = DMPBinaryBridge.decodeBuffer(value) else {
                context.exception = JSValue(newErrorFromMessage: "Expected ArrayBuffer", in: context)
                return JSValue(undefinedIn: context)
            }
            var count = 0
            let pointer = bytes.withUnsafeBytes { dimina_canvas_rle32($0.baseAddress?.assumingMemoryBound(to: UInt8.self), $0.count, &count) }
            let packed = pointer.map { Data(bytesNoCopy: $0, count: count, deallocator: .free) }
            let payload = packed ?? bytes
            var result: [String: Any] = [:]
            if packed != nil { result["encoding"] = "rle32-v1"; result["byteLength"] = bytes.count }
            if appResolver()?.render?.getWebView(byId: page)?.canvasBinaryReady == true {
                result["packed"] = payload
            } else { result["base64"] = payload.base64EncodedString() }
            return DMPBinaryBridge.encode(result, in: context)
        }
        let bridge = context.globalObject.forProperty("DiminaServiceBridge")!
        bridge.setObject(true, forKeyedSubscript: "canvasBinarySupported" as NSString)
        bridge.setObject(encode, forKeyedSubscript: "encodeCanvasArrayBuffer" as NSString)
    }
}
