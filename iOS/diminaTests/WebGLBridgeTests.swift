import JavaScriptCore
import Testing
import UIKit
import WebKit
@testable import dimina

// Loads the shipped SDK in the same JavaScriptCore/WKWebView environments as
// a mini game, including the native synchronous bridge and queued publications.
@Suite(.serialized)
@MainActor
struct WebGLBridgeTests {
    @Test func bundledSDKQueriesDrawsAndRecoversOnWebKit() async throws {
        DMPResourceManager.prepareSdk()
        let app = DMPApp(appConfig: DMPAppConfig(appName: "WebGL regression", appId: "webgl-test"), appIndex: -1)
        let service = DMPService(app: app)
        let render = DMPRender(app: app)
        app.service = service
        app.render = render
        let view = render.createWebView(appName: "WebGL regression")
        render.setupJSBridge(webViewId: view.getWebViewId())
        let webView = view.getWebView()
        let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        window.windowLevel = .alert + 2
        window.isHidden = false
        webView.frame = controller.view.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        controller.view.addSubview(webView)
        defer {
            window.isHidden = true
            webView.removeFromSuperview()
            render.releaseWebView(view)
            service.destroy()
            app.service = nil
            app.render = nil
        }
        let navigation = NavigationReady()
        webView.navigationDelegate = navigation
        try await navigation.load(view)
        webView.navigationDelegate = view
        await service.loadFile(path: DMPSandboxManager.sdkServicePath())
        await service.evaluateScript("modDefine('game', function () {});")
        await service.postMessage(data: DMPMap([
            "type": "loadResource",
            "body": ["appId": "webgl-test", "bridgeId": view.getWebViewId(), "pagePath": "game", "runtimeType": "game",
                     "hostEnv": ["systemInfo": ["windowWidth": 256, "windowHeight": 256, "pixelRatio": 1]]],
        ]))
        let report = try await evaluate(service, Self.queryAndDraw)
        try #require(report["error"] == nil, "\(report)")
        #expect(report["checks"] as? [String: Bool] == [
            "webgl1Methods": true, "webgl2Methods": true, "viewportType": true,
            "vaoBinding": true, "extensionPredicate": true, "syncStatus": true,
            "smallDataView": true, "largeDataView": true, "pixels": true,
        ], "\(report)")
        print("WEBGL_REPORT=\(report)")

        // Explicit context loss uses the real WebKit extension. Wait for Service's
        // forwarded restored event instead of guessing how many frames it takes.
        let events = await withCheckedContinuation { continuation in
            service.getEngine().registerMethod(name: "__webglRecovered") { value in
                continuation.resume(returning: value.toString() ?? "")
                return nil
            }
            service.getEngine().enqueueScript(Self.loseAndRecover)
        }
        let recovery = try JSONSerialization.jsonObject(with: Data(events.utf8)) as? [String: Any]
        #expect(recovery?["error"] == nil, "\(events)")
        #expect(recovery?["lost"] as? Bool == true)
        #expect(recovery?["lostResourcesInvalid"] as? Bool == true)
        #expect(recovery?["restored"] as? Bool == true)
        #expect(recovery?["pixels"] as? Bool == true)
        print("WEBGL_RECOVERY=\(events)")
        let image = try await webView.takeSnapshot(configuration: nil)
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("webgl-restored-triangle.png")
        try #require(image.pngData()).write(to: path)
        print("WEBGL_SCREENSHOT=\(path.path)")
    }

    private func evaluate(_ service: DMPService, _ script: String) async throws -> [String: Any] {
        let result = await service.evaluateScript("""
        (function () {
            try { return JSON.stringify((function () { \(script) })()); }
            catch (e) { return JSON.stringify({error: String(e), stack: e.stack}); }
        })()
        """)
        let json = try #require(result?.toString())
        return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private static let queryAndDraw = """
    const canvas = wx.createCanvas(); canvas.width = 256; canvas.height = 256;
    const gl = canvas.getContext('webgl', {preserveDrawingBuffer: true});
    if (!gl) throw new Error('WebGL 1 unavailable');
    globalThis.__webgl = gl;
    const checks = {webgl1Methods: typeof gl.texStorage2D === 'undefined'};
    const astc = gl.getExtension('WEBGL_compressed_texture_astc');
    const profiles = astc ? astc.getSupportedProfiles() : null;
    if (astc && (typeof astc.COMPRESSED_RGBA_ASTC_6x6_KHR !== 'number' || !Array.isArray(profiles)))
        throw new Error('ASTC descriptor/query mismatch');
    const vao = gl.getExtension('OES_vertex_array_object');
    if (!vao) throw new Error('VAO extension unavailable');
    const first = vao.createVertexArrayOES(); vao.bindVertexArrayOES(first);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer);
    const binding = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
    vao.bindVertexArrayOES(vao.createVertexArrayOES());
    checks.vaoBinding = binding === buffer && gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === null;
    vao.bindVertexArrayOES(first);
    let wrongTypeThrows = false;
    try { vao.isVertexArrayOES(buffer); } catch (e) { wrongTypeThrows = e instanceof TypeError; }
    checks.extensionPredicate = wrongTypeThrows && vao.isVertexArrayOES(first) === true;
    gl.viewport(1, 2, 30, 40);
    const viewport = gl.getParameter(gl.VIEWPORT);
    checks.viewportType = viewport instanceof Int32Array && viewport.join(',') === '1,2,30,40';
    const offscreen = wx.createOffscreenCanvas({type: 'webgl2', width: 8, height: 8});
    const gl2 = offscreen.getContext('webgl2');
    if (!gl2) throw new Error('WebGL 2 unavailable');
    checks.webgl2Methods = typeof gl2.texStorage2D === 'function';
    const sync = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
    const status = gl2.clientWaitSync(sync, 0, 0);
    checks.syncStatus = [gl2.ALREADY_SIGNALED, gl2.CONDITION_SATISFIED, gl2.TIMEOUT_EXPIRED].includes(status);
    for (const length of [8, 2048]) {
        const data = new Uint8Array(length).fill(42);
        gl2.bindBuffer(gl2.ARRAY_BUFFER, gl2.createBuffer()); gl2.bufferData(gl2.ARRAY_BUFFER, data, gl2.STATIC_DRAW);
        const bytes = new Uint8Array(length + 4).fill(7);
        gl2.getBufferSubData(gl2.ARRAY_BUFFER, 0, new DataView(bytes.buffer, 2, length));
        checks[length === 8 ? 'smallDataView' : 'largeDataView'] = bytes.slice(2, length + 2).every(x => x === 42)
            && bytes[0] === 7 && bytes[1] === 7 && bytes[length + 2] === 7 && bytes[length + 3] === 7;
    }
    globalThis.__drawWebGL = function () {
        function shader(type, source) {
            const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        }
        const program = gl.createProgram();
        gl.attachShader(program, shader(gl.VERTEX_SHADER, 'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}'));
        gl.attachShader(program, shader(gl.FRAGMENT_SHADER, 'precision mediump float;void main(){gl_FragColor=vec4(1.0,0.0,1.0,1.0);}'));
        gl.linkProgram(program); if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program); const position = gl.getAttribLocation(program, 'position');
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0.8,-0.8,-0.8,0.8,-0.8]), gl.STATIC_DRAW);
        gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0); gl.enableVertexAttribArray(position);
        gl.viewport(0,0,256,256); gl.clearColor(0.03,0.08,0.13,1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES,0,3);
        const pixel = new Uint8Array(4); gl.readPixels(128,128,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
        return pixel.join(',') === '255,0,255,255' && gl.getError() === gl.NO_ERROR;
    };
    checks.pixels = __drawWebGL();
    return {checks, astcProfiles: profiles, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION)};
    """

    private static let loseAndRecover = """
    (function () {
        const gl = __webgl, canvas = gl.canvas, ext = gl.getExtension('WEBGL_lose_context');
        const result = {};
        let finished = false;
        const finish = () => { if (!finished) { finished = true; __webglRecovered(JSON.stringify(result)); } };
        // A bounded failure timeout reports a missing event; it never drives recovery.
        const timeout = setTimeout(() => { result.error = 'WebGL restoration event timed out'; finish(); }, 10000);
        if (!ext) { result.error = 'WEBGL_lose_context unavailable'; clearTimeout(timeout); finish(); return; }
        canvas.addEventListener('webglcontextlost', event => {
            try {
                result.lost = gl.isContextLost() && gl.getContextAttributes() === null;
                const buffer = gl.createBuffer();
                result.lostResourcesInvalid = buffer === null || !gl.isBuffer(buffer);
                event.preventDefault(); ext.restoreContext();
            } catch (e) { result.error = String(e); clearTimeout(timeout); finish(); }
        });
        canvas.addEventListener('webglcontextrestored', () => {
            try { result.restored = !gl.isContextLost(); result.pixels = __drawWebGL(); }
            catch (e) { result.error = String(e); }
            clearTimeout(timeout); finish();
        });
        ext.loseContext();
    })();
    """
}

@MainActor
private final class NavigationReady: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    func load(_ view: DMPWebview) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            view.loadPageFrame()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.webView(webView, didFail: navigation, withError: error)
    }
}
