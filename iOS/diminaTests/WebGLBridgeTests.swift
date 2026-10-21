import JavaScriptCore
import Testing
import UIKit
import WebKit
import XCTest
@testable import dimina

// Loads the shipped SDK in the same JavaScriptCore/WKWebView environments as
// a mini game, including the native synchronous bridge and queued publications.
extension DMPUIIntegrationTests {
    @Suite
    @MainActor
    struct WebGLBridgeTests {
        @Test(arguments: ["webgl", "webgl2"], [false, true])
        func shaderQueriesKeepThePreviousFrameVisible(contextType: String, preserveDrawingBuffer: Bool) async throws {
            DMPResourceManager.prepareSdk()
            let owner = "webgl-frame-\(UUID().uuidString)"
            let app = DMPApp(appConfig: DMPAppConfig(appName: "WebGL frame regression", appId: owner), appIndex: -1)
            let service = DMPService(app: app)
            let render = DMPRender(app: app)
            app.service = service
            app.render = render
            let view = render.createWebView(appName: "WebGL frame regression")
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
            let resume = DispatchSemaphore(value: 0)
            defer {
                resume.signal()
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
                "body": ["appId": owner, "bridgeId": view.getWebViewId(), "pagePath": "game", "runtimeType": "game",
                         "hostEnv": ["systemInfo": ["windowWidth": 256, "windowHeight": 256, "pixelRatio": 1]]],
            ]))
            let engine = service.getEngine()
            let label = "\(contextType)-\(preserveDrawingBuffer ? "preserved" : "default")"
            let first = try await evaluate(service, """
                globalThis.frameCanvas = wx.createCanvas(); frameCanvas.width = 256; frameCanvas.height = 256;
                globalThis.frameGL = frameCanvas.getContext('\(contextType)'\(preserveDrawingBuffer ? ", {preserveDrawingBuffer: true}" : ""));
                if (!frameGL) throw new Error('WebGL context unavailable');
                \(contextType == "webgl2" ? "frameGL.clearBufferfv(frameGL.COLOR, 0, new Float32Array([1, 0, 1, 1]));" : "frameGL.clearColor(1, 0, 1, 1); frameGL.clear(frameGL.COLOR_BUFFER_BIT);")
                return {preserveDrawingBuffer: frameGL.getContextAttributes().preserveDrawingBuffer};
                """)
            #expect(first["preserveDrawingBuffer"] as? Bool == preserveDrawingBuffer)
            try await waitForPresentation(webView)
            let initial = try await snapshotCenter(webView, label: "\(label)-initial")
            print("WEBGL_FRAME_INITIAL=\(label):\(initial)")
            #expect(initial[0] > 240 && initial[1] < 15 && initial[2] > 240)

            // Hold the Service turn after the synchronous shader query so WebKit
            // has time to composite the intermediate clear. This is an observed
            // query boundary, not a timer used to drive rendering.
            var previousColor: [UInt8] = [255, 0, 255, 255]
            let colors: [[UInt8]] = [[0, 255, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255]]
            for (frame, color) in colors.enumerated() {
                let paused = XCTestExpectation(description: "shader query reached in frame \(frame)")
                engine.registerMethod(name: "__shaderQueryPaused") { _ in
                    paused.fulfill()
                    _ = resume.wait(timeout: .now() + 15)
                    return nil
                }
                engine.enqueueScript("""
                (function () {
                frameGL.clearColor(0, 0, 0, 1); frameGL.clear(frameGL.COLOR_BUFFER_BIT);
                const frameShader = frameGL.createShader(frameGL.FRAGMENT_SHADER);
                frameGL.shaderSource(frameShader, '\(contextType == "webgl2" ? "#version 300 es\\nprecision mediump float;out vec4 color;void main(){color=vec4(1.0);}" : "precision mediump float;void main(){gl_FragColor=vec4(1.0);}")');
                frameGL.compileShader(frameShader);
                if (!frameGL.getShaderParameter(frameShader, frameGL.COMPILE_STATUS)) throw new Error(frameGL.getShaderInfoLog(frameShader));
                __shaderQueryPaused();
                frameGL.clearColor(\(color.map { String(Double($0) / 255) }.joined(separator: ","))); frameGL.clear(frameGL.COLOR_BUFFER_BIT);
                })();
                """)
                let pauseResult = await XCTWaiter.fulfillment(of: [paused], timeout: 10)
                try #require(pauseResult == .completed)
                try await waitForPresentation(webView)
                let duringQuery = try await snapshotCenter(webView, label: "\(label)-shader-query-\(frame)")
                print("WEBGL_FRAME_DURING_QUERY=\(label):\(frame):\(duringQuery)")
                #expect(duringQuery == previousColor)
                resume.signal()
                let completed = try await evaluate(service, "return {error: frameGL.getError()};")
                #expect(completed["error"] as? Int == 0)
                try await waitForPresentation(webView)
                let final = try await snapshotCenter(webView, label: "\(label)-final-\(frame)")
                print("WEBGL_FRAME_COMPLETED=\(label):\(frame):\(final)")
                #expect(final == color)
                previousColor = color
            }
        }

        private func waitForPresentation(_ webView: WKWebView) async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var completed = false
                let finish: (Error?) -> Void = { error in
                    guard !completed else { return }
                    completed = true
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                }
                webView.callAsyncJavaScript(
                    "if (document.visibilityState !== 'visible') throw new Error('WebGL document is ' + document.visibilityState); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));",
                    arguments: [:], in: nil, in: .page
                ) { result in
                    switch result {
                    case .success: finish(nil)
                    case .failure(let error): finish(error)
                    }
                }
                // A native deadline still fires if WebContent has been suspended.
                // It fails the test; it does not drive or substitute for a frame.
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                    finish(NSError(domain: "WebGLFrameTest", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "WebKit presentation frames timed out"
                    ]))
                }
            }
        }

        private func snapshotCenter(_ webView: WKWebView, label: String) async throws -> [UInt8] {
            let image = try await webView.takeSnapshot(configuration: nil)
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("\(label).png")
            try #require(image.pngData()).write(to: path)
            print("WEBGL_FRAME_SNAPSHOT=\(path.path)")
            let cgImage = try #require(image.cgImage)
            let center = try #require(cgImage.cropping(to: CGRect(x: cgImage.width / 2, y: cgImage.height / 2, width: 1, height: 1)))
            var pixel = [UInt8](repeating: 0, count: 4)
            try pixel.withUnsafeMutableBytes { bytes in
                let context = try #require(CGContext(data: bytes.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                    bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(center, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            }
            return pixel
        }

        @Test func bundledSDKQueriesDrawsAndRecoversOnWebKit() async throws {
            DMPResourceManager.prepareSdk()
            let owner = "webgl-\(UUID().uuidString)"
            let app = DMPApp(appConfig: DMPAppConfig(appName: "WebGL regression", appId: owner), appIndex: -1)
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
                "body": ["appId": owner, "bridgeId": view.getWebViewId(), "pagePath": "game", "runtimeType": "game",
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

            let binaryDeadline = Date().addingTimeInterval(5)
            while !view.canvasBinaryReady && Date() < binaryDeadline { await Task.yield() }
            #expect(view.canvasBinaryReady, "The real WebKit resource handshake must enable binary Canvas")
            // Model a slow binary resource. Later legacy queries must wait for
            // the upload even when WebKit can execute their scripts sooner.
            _ = try await webView.callAsyncJavaScript("""
                const receive=globalThis.__diminaCanvasResource;
                globalThis.__undelayedCanvasResource=receive;
                const delayed=async url=>{await new Promise(resolve=>setTimeout(resolve,100));return receive(url)};
                delayed.cancel=()=>receive.cancel();globalThis.__diminaCanvasResource=delayed;return true;
                """, arguments: [:], in: nil, in: .page)
            let binary = try await evaluate(service, """
                const pixels = new Uint8Array(256 * 256 * 4); pixels.fill(255);
                const descriptor = DiminaServiceBridge.encodeCanvasArrayBuffer(pixels.buffer, \(view.getWebViewId()));
                const gl = globalThis.__webgl;
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
                const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
                const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
                let exact = true, ordered = true;
                for (let round = 0; round < 3; round++) {
                    for (let i = 0; i < pixels.length; i += 4) {
                        pixels[i] = round === 0 ? 255 : (i * 37 + round) & 255;
                        pixels[i+1] = round === 0 ? 255 : (i * 13 + 9) & 255;
                        pixels[i+2] = round === 0 ? 255 : (i * 7 + 11) & 255;
                        pixels[i+3] = 255;
                    }
                    const expected = pixels.slice();
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                    if (round === 2) {
                        gl.canvas.flushOperations();
                        const first = new Uint8Array(4);
                        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, first);
                        ordered = first.every((byte, index) => byte === expected[index]);
                    }
                    pixels.fill(17);
                    const output = new Uint8Array(expected.length);
                    gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, output);
                    exact = exact && output.every((byte, index) => byte === expected[index]);
                }
                gl.deleteFramebuffer(framebuffer); gl.deleteTexture(texture);
                return {binary: descriptor.packed instanceof ArrayBuffer, compressed: descriptor.encoding === 'rle32-v1',
                    packedBytes: descriptor.packed?.byteLength, exact, ordered, error: gl.getError()};
                """)
            #expect(binary["binary"] as? Bool == true, "\(binary)")
            #expect(binary["compressed"] as? Bool == true)
            #expect(binary["exact"] as? Bool == true, "\(binary)")
            #expect(binary["ordered"] as? Bool == true, "\(binary)")
            #expect(binary["error"] as? Int == 0, "\(binary)")
            print("WEBGL_BINARY_REPORT=\(binary)")

            _ = try await webView.callAsyncJavaScript("""
                const receive=globalThis.__undelayedCanvasResource;
                const delayed=async url=>{await new Promise(resolve=>setTimeout(resolve,5));return receive(url)};
                delayed.cancel=()=>receive.cancel();globalThis.__diminaCanvasResource=delayed;return true;
                """, arguments: [:], in: nil, in: .page)
            let pressure = try await evaluate(service, """
                const gl=globalThis.__webgl, buffer=gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
                for(let i=0;i<512;i++){
                    gl.bufferData(gl.ARRAY_BUFFER,new Uint8Array(1024).fill(i&255),gl.DYNAMIC_DRAW);
                    gl.canvas.flushOperations();
                }
                const size=gl.getBufferParameter(gl.ARRAY_BUFFER,gl.BUFFER_SIZE);
                gl.deleteBuffer(buffer);return {size,errorCode:gl.getError()};
                """)
            try #require(pressure["error"] == nil, "Delayed uploads must apply backpressure without dropping commands: \(pressure)")
            #expect(pressure["size"] as? Int == 1024, "\(pressure)")
            #expect(pressure["errorCode"] as? Int == 0, "\(pressure)")

            // Every upload finishes within its execution timeout, but the FIFO
            // as a whole takes longer than a query deadline. Already admitted
            // publications must survive that queue wait and still present.
            _ = try await webView.callAsyncJavaScript("""
                const receive=globalThis.__undelayedCanvasResource;
                const delayed=async url=>{await new Promise(resolve=>setTimeout(resolve,250));return receive(url)};
                delayed.cancel=()=>receive.cancel();globalThis.__diminaCanvasResource=delayed;return true;
                """, arguments: [:], in: nil, in: .page)
            let queued = try await evaluate(service, """
                const gl=globalThis.__webgl;
                globalThis.queuedBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,queuedBuffer);
                for(let i=0;i<24;i++){
                    gl.bufferData(gl.ARRAY_BUFFER,new Uint8Array(1024).fill(i),gl.DYNAMIC_DRAW);
                    gl.canvas.flushOperations();
                }
                gl.clearColor(1,0,1,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.canvas.flushOperations();
                return {queued:true};
                """)
            try #require(queued["queued"] as? Bool == true, "\(queued)")
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                // A FIFO barrier observes completion without starting a new
                // synchronous query deadline while the uploads are queued.
                view.executeJavaScript("true") { _, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume() }
                }
            }
            #expect(view.canvasBinaryError == nil)
            try await waitForPresentation(webView)
            let queuedPixel = try await snapshotCenter(webView, label: "queued-publications")
            #expect(queuedPixel == [255, 0, 255, 255], "\(queuedPixel)")
            print("WEBGL_QUEUED_PUBLICATIONS=\(queuedPixel)")
            let drained = try await evaluate(service, """
                const size=__webgl.getBufferParameter(__webgl.ARRAY_BUFFER,__webgl.BUFFER_SIZE);
                __webgl.deleteBuffer(queuedBuffer);return {size,errorCode:__webgl.getError()};
                """)
            #expect(drained["size"] as? Int == 1024, "\(drained)")
            #expect(drained["errorCode"] as? Int == 0, "\(drained)")
            _ = try await webView.callAsyncJavaScript("globalThis.__diminaCanvasResource=globalThis.__undelayedCanvasResource;return true", arguments: [:], in: nil, in: .page)

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

        @Test func bundledVideoPAGCanvasTransportComparison() async throws {
            let owner = "pag-canvas-\(UUID().uuidString)"
            DMPResourceManager.prepareSdk()
            try #require(DMPSandboxManager.initBundleDirectoryForApp(appId: owner))
            defer {
                VideoDecoderStore.dispose(owner: owner)
                try? FileManager.default.removeItem(atPath: DMPSandboxManager.appBundlePath(owner))
            }
            // These resources are copied from tracked example sources into the
            // test bundle; no locally compiled mini-program ZIP is required.
            let resources = Bundle(for: WebGLTestResources.self)
            let assets = URL(fileURLWithPath: DMPSandboxManager.appBundlePath(owner))
                .appendingPathComponent("main/pages/libpag/assets", isDirectory: true)
            try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
            for filename in ["libpag.wasm.br", "video.pag"] {
                let source = try #require(resources.url(forResource: filename, withExtension: nil))
                try FileManager.default.copyItem(at: source, to: assets.appendingPathComponent(filename))
            }
            let libraryURL = try #require(resources.url(forResource: "index", withExtension: "js"))
            let library = try String(contentsOf: libraryURL, encoding: .utf8)
            let app = DMPApp(appConfig: DMPAppConfig(appName: "PAG Canvas benchmark", appId: owner), appIndex: -1)
            app.container = DMPContainer(app: app)
            _ = FileAPI(app: app)
            _ = VideoDecoderAPI(app: app)
            let service = DMPService(app: app), render = DMPRender(app: app)
            app.service = service; app.render = render
            let view = render.createWebView(appName: "PAG Canvas benchmark")
            render.setupJSBridge(webViewId: view.getWebViewId())
            let webView = view.getWebView()
            let scene = try #require(UIApplication.shared.connectedScenes.first as? UIWindowScene)
            let window = UIWindow(windowScene: scene), controller = UIViewController()
            window.rootViewController = controller; window.windowLevel = .alert + 2; window.isHidden = false
            webView.frame = controller.view.bounds; controller.view.addSubview(webView)
            let idleTimer = UIApplication.shared.isIdleTimerDisabled
            UIApplication.shared.isIdleTimerDisabled = true
            defer {
                UIApplication.shared.isIdleTimerDisabled = idleTimer
                window.isHidden = true; webView.removeFromSuperview()
                render.releaseWebView(view); service.destroy()
                app.service = nil; app.render = nil
            }
            let navigation = NavigationReady()
            webView.navigationDelegate = navigation
            try await navigation.load(view)
            webView.navigationDelegate = view
            await service.loadFile(path: DMPSandboxManager.sdkServicePath())
            await service.evaluateScript("modDefine('pag-benchmark', function(require,module,exports){\(library)\n});modDefine('game',function(){});")
            await service.postMessage(data: DMPMap(["type": "loadResource", "body": [
                "appId": owner, "bridgeId": view.getWebViewId(), "pagePath": "game", "runtimeType": "game",
                "hostEnv": ["systemInfo": ["windowWidth": 720, "windowHeight": 1080, "pixelRatio": 1]]
            ]]))
            let finished = XCTestExpectation(description: "actual video PAG playback")
            var report = ""
            service.getEngine().registerMethod(name: "__pagCanvasReport") { value in
                report = value.toString() ?? ""; finished.fulfill(); return nil
            }
            service.getEngine().registerMethod(name: "__pagPresentedPixels") { _ in
                let done = DispatchSemaphore(value: 0)
                var result: Any = ["error": "Presented Canvas unavailable"]
                DispatchQueue.main.async {
                    view.executeJavaScript(Self.presentedPixels) { value, error in
                        result = value ?? ["error": error?.localizedDescription ?? "Pixel readback failed"]
                        done.signal()
                    }
                }
                guard done.wait(timeout: .now() + 5) == .success else { return ["error": "Pixel readback timed out"] }
                return result
            }
            service.getEngine().enqueueScript("""
                (async()=>{
                    const report={samples:[],pixels:[]}, encode=DiminaServiceBridge.encodeCanvasArrayBuffer;
                    let file, view;
                    try {
                        const PAG=await modRequire('pag-benchmark').PAGInit({locateFile:name=>'/pages/libpag/assets/'+name});
                        const input=wx.getFileSystemManager().readFileSync('/pages/libpag/assets/video.pag');
                        report.input={type:Object.prototype.toString.call(input),bytes:input?.byteLength,magic:Array.from(new Uint8Array(input).subarray(0,4))};
                        file=await PAG.PAGFile.load(input);
                        report.source={width:file.width(),height:file.height(),duration:file.duration(),fps:file.frameRate()};
                        const canvas=wx.createCanvas();canvas.width=file.width();canvas.height=file.height();
                        for(const mode of ['base64','native']){
                            DiminaServiceBridge.encodeCanvasArrayBuffer=mode==='base64'?undefined:encode;
                            view=await PAG.PAGView.init(file,canvas,{firstFrame:false});view.setRepeatCount(0);
                            const hashes=[];
                            for(const progress of [0,0.5,0.9]){
                                view.setProgress(progress);await view.flush();
                                if(canvas.getContext('webgl').getError()!==0)throw Error('PAG flush GL error');
                                const pixels=__pagPresentedPixels(null);
                                if(pixels.error)throw Error(pixels.error);
                                hashes.push(pixels);
                            }
                            report.pixels.push(hashes);
                            if(!hashes.some(value=>value.alpha>0))throw Error('PAG checkpoints are all transparent');
                            view.setProgress(0);
                            let frames=0,measuring=false,maxFlush=0;
                            const flush=view.flush.bind(view);
                            view.flush=async function(){const start=Date.now(),result=await flush();if(measuring&&result){frames++;maxFlush=Math.max(maxFlush,Date.now()-start)}return result};
                            await view.play();await new Promise(resolve=>setTimeout(resolve,2000));
                            measuring=true;const start=Date.now();await new Promise(resolve=>setTimeout(resolve,10000));
                            const elapsedMs=Date.now()-start;measuring=false;await view.pause();
                            report.samples.push({mode,frames,elapsedMs,fps:frames*1000/elapsedMs,maxFlush,debug:view.getDebugData()});
                            await view.destroy();view=null;
                        }
                    }catch(error){report.error=String(error)+'\\n'+String(error?.stack||'')}
                    finally{DiminaServiceBridge.encodeCanvasArrayBuffer=encode;try{if(view)await view.destroy();if(file)file.destroy()}catch(e){}__pagCanvasReport(JSON.stringify(report))}
                })();
                """)
            let status = await XCTWaiter.fulfillment(of: [finished], timeout: 150)
            try #require(status == .completed)
            print("PAG_CANVAS_REPORT=\(report)")
            let result = try #require(JSONSerialization.jsonObject(with: Data(report.utf8)) as? [String: Any])
            #expect(result["error"] == nil, "\(report)")
            let pixels = try #require(result["pixels"] as? NSArray)
            #expect(pixels.count == 2)
            if pixels.count == 2 { #expect(pixels[0] as? NSArray == pixels[1] as? NSArray, "\(report)") }
            #expect(view.canvasBinaryReady)
            let image = try await webView.takeSnapshot(configuration: nil)
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("video-pag-canvas-binary.png")
            try #require(image.pngData()).write(to: path)
            print("PAG_CANVAS_SCREENSHOT=\(path.path)")
        }

        private static let presentedPixels = """
            (()=>{const canvas=document.querySelector('canvas[data-dimina-game-canvas]');if(!canvas)return {error:'visible game canvas missing'};
            const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            let hash=2166136261,alpha=0;for(let i=0;i<pixels.length;i++){hash=Math.imul(hash^pixels[i],16777619);if(i%4===3)alpha+=pixels[i]}
            return {hash:hash>>>0,alpha}})()
            """

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
}

private final class WebGLTestResources {}

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
