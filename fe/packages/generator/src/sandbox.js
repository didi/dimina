import { createContainer } from '@dimina/fe-container-sdk'
import containerCss from '@dimina/fe-container-sdk/style.css?inline'
import serviceSource from '@dimina/service?raw'
import renderSource from '../.runtime/render.js?raw'
import renderCss from '../.runtime/render.css?raw'

const post = (type, body = {}) => parent.postMessage({ channel: 'dimina-generator', type, ...body }, '*')
const blob = (content, type) => URL.createObjectURL(new Blob([content], { type }))
let started = false
window.addEventListener('message', async event => {
	if (event.source !== parent || event.data?.channel !== 'dimina-generator' || event.data.type !== 'init' || started) return
	started = true
	const { appId, appName, resources, storage = {}, statusBarHeight = 0 } = event.data
	const state = new Map(Object.entries(storage))
	const storageAdapter = {
		getItem: key => state.get(key) ?? null,
		setItem(key, value) { state.set(key, value); post('storage', { storage: Object.fromEntries(state) }) },
		removeItem(key) { state.delete(key); post('storage', { storage: Object.fromEntries(state) }) },
		key: index => [...state.keys()][index] ?? null,
		get length() { return state.size },
	}
	try {
		const style = document.createElement('style')
		style.textContent = `${containerCss}\nhtml,body,#app{margin:0;width:100%;height:100%;overflow:hidden}*{box-sizing:border-box}`
		document.head.append(style)
		const pageFrameHtml = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${renderCss}</style></head><body><script>${renderSource.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
		const container = createContainer({
			mount: document.getElementById('app'),
			resourceBaseUrl: 'https://dimina.invalid/',
			urlSync: false, storageSync: storageAdapter,
			getAppInfo: () => ({ name: appName }),
			shell: {
				getStatusBarRect: () => ({ top: 0, left: 0, width: innerWidth, right: innerWidth, height: statusBarHeight, bottom: statusBarHeight }),
				updateStatusBarColor: color => post('statusBarColor', { color }),
			},
			runtimeAssets: { serviceWorkerUrl: blob(serviceSource, 'text/javascript'), pageFrameHtml },
			onAppLaunchError: error => post('error', { error: error?.message || '小程序启动失败' }),
		})
		const home = document.createElement('div')
		home.className = 'dimina-native-view'
		home.style.background = 'white'
		container.setRootView({ el: home, onPresentIn: () => post('closed') })
		const config = JSON.parse(resources['main/app-config.json'])
		const app = await container.openApp({ appId, path: config.app.entryPagePath || config.app.pages[0], resourceContents: resources })
		await app.whenReady()
		post('ready')
	} catch (error) { post('error', { error: error.message }) }
})
window.addEventListener('error', event => post('runtimeError', { error: event.message }))
window.addEventListener('unhandledrejection', event => post('runtimeError', { error: String(event.reason?.message || event.reason) }))
post('boot')
