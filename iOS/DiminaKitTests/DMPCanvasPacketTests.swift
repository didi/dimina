import Foundation
import JavaScriptCore
import Testing
import WebKit
@testable import dimina

struct DMPCanvasPacketTests {
    @Test func preservesJSONSemanticsAndOwnsOnlyNegotiatedPackedBytes() throws {
        let context = try #require(JSContext())
        let value = try #require(context.evaluateScript("""
            globalThis.bytes=new Uint8Array([0,255,128,17]);
            ({omit:undefined,ordinary:new ArrayBuffer(8),array:[undefined,NaN],
              typed:{__canvasTypedArray:'Uint8Array',packed:bytes.buffer},
              custom:{toJSON(){return {value:42}}}})
            """))
        let packet = try DMPCanvasPacket.read(value, using: DMPCanvasPacket.serializer(in: context))
        context.evaluateScript("bytes.fill(99)")
        #expect(packet.buffers == [Data([0, 255, 128, 17])])
        let body = try #require(JSONSerialization.jsonObject(with: Data(packet.json.utf8)) as? NSDictionary)
        #expect(body["omit"] == nil)
        #expect((body["ordinary"] as? NSDictionary)?.count == 0)
        #expect(body["array"] as? NSArray == [NSNull(), NSNull()] as NSArray)
        #expect((body["custom"] as? NSDictionary)?["value"] as? Int == 42)
        #expect((body["typed"] as? NSDictionary)?["packed"] as? NSDictionary == ["__canvasBinaryIndex": 0] as NSDictionary)
        let wire = try packet.wire(type: "canvas", deadline: 1234)
        #expect(wire.suffix(4) == Data([0, 255, 128, 17]))
    }

    @Test func encoderKeepsLegacyPagesCompatibleWithoutAliasing() throws {
        let context = try #require(JSContext())
        context.evaluateScript("globalThis.DiminaServiceBridge={}")
        DMPCanvasPacket.installEncoder(in: context, appResolver: { nil })
        let result = try #require(context.evaluateScript("""
            const bytes=new Uint8Array(65536).fill(255);
            const wire=DiminaServiceBridge.encodeCanvasArrayBuffer(bytes.buffer,999);
            bytes.fill(0);JSON.stringify(wire)
            """)?.toString())
        let wire = try #require(JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])
        #expect(wire["encoding"] as? String == "rle32-v1")
        #expect(wire["byteLength"] as? Int == 65536)
        #expect(wire["packed"] == nil)
        #expect(Data(base64Encoded: try #require(wire["base64"] as? String)) == Data([0, 64, 0, 128, 255, 255, 255, 255]))
    }

    @Test @MainActor func resourcesAreOwnedByOnePageAndConsumedOnce() throws {
        let store = DMPCanvasResources(), first = WKWebView(), other = WKWebView()
        let bytes = Data([0, 255, 128, 17])
        let url = try #require(URL(string: store.store(bytes, for: first)))
        #expect(store.take(url, for: other) == nil)
        #expect(store.take(url, for: first) == bytes)
        #expect(store.take(url, for: first) == nil)
        let old = try #require(URL(string: store.store(bytes, for: first)))
        store.clear(for: first)
        #expect(store.take(old, for: first) == nil)
    }
}
