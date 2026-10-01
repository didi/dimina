import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const nativeRoot = resolve(process.cwd(), '../../../harmony/dimina/src/main/ets')

// Exercise the real ArkTS host code with only platform/worker boundaries replaced.
function loadNative(file: string, imports: Record<string, unknown>) {
	const source = readFileSync(resolve(nativeRoot, file), 'utf8')
	const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
	const exports: Record<string, any> = {}
	runInNewContext(code, { exports, require: (name: string) => imports[name] || {}, ArrayBuffer, Map })
	return exports
}

for (const [debugBuild, appDebug, enabled] of [[false, false, false], [false, true, true], [true, false, true]]) {
	it(`aligns Harmony service, URL and MMKV panel: build=${debugBuild}, app=${appDebug}`, async () => {
		const calls: string[] = []
		class Worker {
			initEngine() { calls.push('init') }
			evalJSAb(data: ArrayBuffer) { calls.push(new TextDecoder().decode(data)) }
			evalJSByUri(uri: string) { calls.push(uri) }
		}
		const imports = {
			'../Utils/DMPContextUtils': { DMPContextUtils: { debugMode: debugBuild } },
			'./DMPWorkerWrapper': { DMPWorkerWrapper: Worker },
			'./DMPSendableObjects': { WorkerAppData: class {} },
			'./DMPJavaScriptSourceURL': { DMPJavaScriptSourceURL: { runtimeEval: () => '/runtime.js' } },
			'@kit.ArkTS': { util: { TextEncoder: class { encodeInto(value: string) { return new TextEncoder().encode(value) } } }, buffer: { from: (data: ArrayBuffer) => ({ write: (value: string) => new Uint8Array(data).set(new TextEncoder().encode(value)) }) } },
			'@ohos.web.webview': { __esModule: true, default: { WebviewController: class {} } },
			'../DApp/config/DMPAppConfig': { DMPLaunchType: { DebugUrl: 3 } },
			'./DMPWebViewProxy': { DMPWebViewProxy: class {} },
			'./DMPWebViewLifeCycle': { WebViewLifeCycle: class {} },
			'../Utils/DMPMap': { DMPMap: class { constructor(public value: unknown) {} } },
			'../Service/DMPChannelProxyNext': { DMPChannelProxyNext: { ContainerToRender: (msg: any) => { calls.push(JSON.stringify(msg.value)) } } },
		}
		const config = { appId: 'app', isDebugMode: appDebug, launchAppType: 2 }
		const app = { appConfig: config, bundleManager: { getJsAppModuleConfig: () => ({ getRootPackage: () => 'main' }), getCurrentJSSdkDir: () => 'https://example.com/sdk' } }
		const { DMPService } = loadNative('Service/DMPService.ets', imports)
		const service = new DMPService(7, config)
		await service.loadFileUri('/service.js')
		expect(calls.slice(0, 3)).toEqual(['init', `globalThis.__diminaDebug = ${enabled};`, '/service.js'])
		const { DMPWebViewController } = loadNative('HybridContainer/DMPWebViewController.ets', imports)
		const controller = new DMPWebViewController(8, app)
		expect(controller.loadPath()).toBe(`http://127.0.0.1/pageFrame.html${enabled ? '?vconsole=1' : ''}`)
		config.launchAppType = 3
		expect(controller.loadPath()).toBe(`https://example.com/sdk/pageFrame.html${enabled ? '?vconsole=1' : ''}`)
		const { DMPContainer } = loadNative('Container/DMPContainer.ets', imports)
		new DMPContainer(app).loadResourceRender(8, 'pages/index')
		expect(JSON.parse(calls.at(-1)!).body).toMatchObject({ bridgeId: 8, appId: 'app', debugEnabled: String(enabled) })
	})
}
