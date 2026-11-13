import { createContainer } from '@dimina/fe-container-sdk'
import '@dimina/fe-container-sdk/style.css'
import { desktop, registerDesktopApis, registerHostApis, dispatchRuntimeEvent } from './native.js'
import { getDesktopAppInfo } from './app-info.js'
import searchIcon from '../../../fe/packages/container/public/images/search.jpg'
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
		<div class="desktop-library__search-bar"><label class="desktop-library__search"><input id="search" type="search" aria-label="搜索小程序" placeholder="搜索小程序" autocomplete="off"></label><button id="refresh" class="desktop-library__refresh">刷新</button></div>
		<div id="status" role="alert" hidden></div>
		<section class="desktop-library__applications" aria-labelledby="apps-title"><div class="desktop-library__section-heading"><h2 id="apps-title">应用列表</h2><button id="import" class="desktop-library__import">导入小程序 <span aria-hidden="true">↗</span></button></div>
		<ul id="apps" class="desktop-library__list" aria-live="polite"></ul></section>
	</main>`
	const grid = document.getElementById('apps')
	const search = document.getElementById('search')
	search.style.backgroundImage = `url("${searchIcon}")`
	let apps = []
	function render() {
		grid.replaceChildren()
		const query = search.value.trim().toLowerCase()
		const visible = apps.filter(app => `${app.name} ${app.appId}`.toLowerCase().includes(query))
		for (const app of visible) {
			const item = document.createElement('li')
			item.className = 'desktop-library__item'
			const button = document.createElement('button')
			button.className = 'desktop-library__open'
			button.type = 'button'
			const icon = document.createElement('img')
			icon.className = 'desktop-library__logo'
			icon.src = app.logo
			icon.alt = ''
			icon.draggable = false
			const title = document.createElement('span')
			title.className = 'desktop-library__name'
			title.textContent = app.name
			button.append(icon, title)
			button.addEventListener('click', async () => {
				button.disabled = true
				button.dataset.state = 'loading'
				button.setAttribute('aria-busy', 'true')
				try { await desktop.openApp(app.appId); button.dataset.state = 'success' }
				catch (error) { button.dataset.state = 'error'; button.setAttribute('aria-describedby', 'status'); showError(error) }
				finally { button.disabled = false; button.removeAttribute('aria-busy') }
			})
			item.appendChild(button)
			grid.appendChild(item)
		}
		if (!visible.length) {
			const empty = document.createElement('li')
			empty.className = 'desktop-library__empty'
			empty.textContent = query ? '未找到匹配的小程序' : '暂无应用'
			grid.appendChild(empty)
		}
	}
	async function refresh() {
		grid.setAttribute('aria-busy', 'true')
		try { apps = (await desktop.listApps()).map(getDesktopAppInfo); render() }
		finally { grid.removeAttribute('aria-busy') }
	}
	search.addEventListener('input', render)
	document.getElementById('refresh').addEventListener('click', () => refresh().catch(showError))
	document.getElementById('import').addEventListener('click', async (event) => {
		event.currentTarget.disabled = true
		try { await desktop.importApp(); document.getElementById('status').hidden = true; await refresh() }
		catch (error) { if (!String(error.message).includes('已取消导入')) showError(error) }
		finally { document.getElementById('import').disabled = false }
	})
	window.addEventListener('keydown', (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === 'f') { event.preventDefault(); search.focus() }
	})
	await refresh()
}

async function openMiniProgram(bootstrap) {
	const appInfo = getDesktopAppInfo(bootstrap.app)
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
