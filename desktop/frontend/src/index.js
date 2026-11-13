import { createContainer } from '@dimina/fe-container-sdk'
import '@dimina/fe-container-sdk/style.css'
import { desktop, registerDesktopApis, registerHostApis, dispatchRuntimeEvent } from './native.js'
import { AppListView, getAppInfo } from '@dimina/container-ui'
import '@dimina/container-ui/style.css'
import './style.css'
import './app-list.css'

const root = document.getElementById('root')

async function presentWindow() {
	// A hidden WKWebView can pause animation frames. Wait for the loading UI's
	// assets and force layout instead, before allowing the native window to show.
	await document.fonts.ready
	await Promise.all(Array.from(root.querySelectorAll('img'), img => img.decode().catch(() => {})))
	root.getBoundingClientRect()
	await desktop.presentWindow()
}

function showError(error) {
	console.error('[desktop]', error)
	let status = document.getElementById('status')
	if (!status) {
		status = document.createElement('div')
		status.id = 'status'
		status.setAttribute('role', 'alert')
		root.appendChild(status)
	}
	status.textContent = error?.message || String(error)
	status.hidden = false
}

async function launcher() {
	root.innerHTML = `<main class="desktop-library">
		<header class="desktop-library__navigation"><h1>星河小程序</h1></header>
		<div id="status" role="alert" hidden></div>
	</main>`
	const library = new AppListView({
		loadApps: async () => (await desktop.listApps()).map(getAppInfo),
		onOpen: app => desktop.openApp(app.appId),
		refreshable: true,
		action: {
			label: '导入小程序',
			refreshAfter: true,
			onClick: async () => {
				try { await desktop.importApp() }
				catch (error) {
					if (String(error?.message).includes('已取消导入')) return false
					throw error
				}
			},
		},
	})
	root.firstElementChild.appendChild(library.el)
	const onFind = (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); library.search.focus() }
	}
	window.addEventListener('keydown', onFind)
	window.addEventListener('pagehide', () => {
		library.destroy()
		window.removeEventListener('keydown', onFind)
	}, { once: true })
	await library.refresh()
}

async function openMiniProgram(bootstrap) {
	const appInfo = getAppInfo(bootstrap.app)
	root.replaceChildren()
	root.classList.add('runtime')
	document.title = bootstrap.app.name
	const container = createContainer({
		mount: root,
		appTransitions: false,
		urlSync: false,
		resourceBaseUrl: bootstrap.resourceBaseUrl,
		pageFrameUrl: new URL('pageFrame.html', bootstrap.baseUrl).href,
		allowedOrigins: [location.origin],
		synchronousApiUrl: bootstrap.synchronousApiUrl,
		hostSystemInfo: { platform: bootstrap.platform, brand: 'desktop', model: bootstrap.arch, system: bootstrap.system, version: '0.1.0' },
		getAppInfo: () => appInfo,
		onAppWillDismiss: () => desktop.prepareToClose(),
		onAppDismiss: () => { if (!container.application.views.length) window.mygo.window.close() },
		onAppLaunchError: error => showError(error || new Error('小程序启动失败')),
	})
	registerDesktopApis(container, bootstrap.runtimeApis)
	if (Array.isArray(bootstrap.nativeApis)) registerHostApis(container, bootstrap.nativeApis)
	window.mygo.on('desktop:native-apis', names => registerHostApis(container, names))
	const setVisible = (visible) => {
		if (visible) container.application.wakeActiveView()
		else container.application.sleepActiveView()
	}
	window.mygo.on('desktop:visible', setVisible)
	window.mygo.on('desktop:close', () => {
		if (container.application.views.length) container.closeApp()
		else window.mygo.window.close()
	})
	document.addEventListener('visibilitychange', () => setVisible(!document.hidden))
	window.addEventListener('pagehide', () => container.closeApp())
	let currentApp
	const pendingEvents = []
	window.mygo.on('desktop:event', event => currentApp ? dispatchRuntimeEvent(currentApp, event) : pendingEvents.push(event))
	const app = await container.openApp({ appId: bootstrap.app.appId, path: bootstrap.app.path })
	currentApp = app
	for (const event of pendingEvents) dispatchRuntimeEvent(app, event)
	pendingEvents.length = 0
	await presentWindow()
	await app.whenReady()
	const observer = new ResizeObserver(() => app.notifyViewportChange())
	observer.observe(root)
	window.addEventListener('pagehide', () => observer.disconnect(), { once: true })
	await desktop.runtimeReady()
}

let bootstrap
try {
	bootstrap = await desktop.bootstrap()
	if (bootstrap.app) await openMiniProgram(bootstrap)
	else await launcher()
}
catch (error) {
	showError(error)
	if (bootstrap?.app) {
		try { await desktop.runtimeFailed(error?.message || String(error)) }
		catch (reportError) { console.error('[desktop] cannot report startup error', reportError) }
		try { await presentWindow() }
		catch (presentationError) { console.error('[desktop] cannot present error window', presentationError) }
	}
}
