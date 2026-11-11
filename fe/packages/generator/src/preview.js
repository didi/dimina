/** Each preview lives in an opaque origin, outside the host's DOM and storage. */
export function createPreview({ mount, storage = globalThis.localStorage, onRuntimeError = () => {}, onStatusBarColorChange = () => {}, onClose = () => {}, timeout = 20000, runtimeSource, statusBarHeight = 0 }) {
	if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative'
	let current
	let pending
	const updateStatusBarColor = color => {
		try { onStatusBarColorChange(color) }
		catch (error) { console.error('[generator] status bar update failed', error) }
	}
	return {
		async open(app, { signal, beforeCommit = async () => {} } = {}) {
			signal?.throwIfAborted()
			pending?.cancel()
			const frame = document.createElement('iframe')
			frame.title = app.name
			frame.setAttribute('sandbox', 'allow-scripts')
			frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'")
			frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:white'
			const key = `dimina-generated-data:${app.id}`
			let initialStorage = {}
			try { initialStorage = JSON.parse(storage.getItem(key) || '{}') } catch {}
			let dispose
			let cancel
			let settled = false
			let committed = false
			let closed = false
			let stagedStorage
			let stagedStatusBarColor = 'black'
			const persist = data => { try { storage.setItem(key, data) } catch (error) { onRuntimeError(error.message) } }
			const ready = new Promise((resolve, reject) => {
				const timer = setTimeout(() => finish(new Error('小程序启动超时')), timeout)
				const abort = () => finish(new DOMException('已取消', 'AbortError'))
				const finish = error => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					signal?.removeEventListener('abort', abort)
					if (error) { dispose(); frame.remove(); reject(error) } else resolve()
				}
				const receive = event => {
					if (event.source !== frame.contentWindow || event.data?.channel !== 'dimina-generator') return
					const message = event.data
					if (message.type === 'boot') frame.contentWindow.postMessage({ channel: 'dimina-generator', type: 'init', appId: app.id, appName: app.name, resources: app.resources, storage: initialStorage, statusBarHeight }, '*')
					if (message.type === 'closed' && !closed) {
						closed = true
						if (!committed) finish(new Error('小程序已关闭'))
						else if (current?.frame === frame) {
							// Keep listening for storage written by the app's onHide.
							// The host covers the closed view; replacement/destroy releases it.
							updateStatusBarColor('black')
							onClose()
						}
					}
					if (message.type === 'ready') finish()
					if (message.type === 'error') settled ? onRuntimeError(String(message.error)) : finish(new Error(message.error))
					if (message.type === 'runtimeError') onRuntimeError(String(message.error).slice(0, 4000))
					if (message.type === 'statusBarColor' && (message.color === 'black' || message.color === 'white')) {
						stagedStatusBarColor = message.color
						if (committed && !closed) updateStatusBarColor(message.color)
					}
					if (message.type === 'storage' && message.storage && typeof message.storage === 'object' && Object.values(message.storage).every(value => typeof value === 'string')) {
						const data = JSON.stringify(message.storage)
						if (data.length <= 1024 * 1024) {
							stagedStorage = data
							if (committed) persist(data)
						}
					}
				}
				window.addEventListener('message', receive)
				dispose = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort) }
				cancel = () => { finish(new DOMException('已取消', 'AbortError')); dispose(); frame.remove() }
				signal?.addEventListener('abort', abort, { once: true })
				if (signal?.aborted) abort()
			})
			const operation = { cancel }
			pending = operation
			// CSP applies to all descendant frames and workers. The parent receives
			// only lifecycle events, black/white foreground colors and storage for this app's fixed key.
			frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline' blob:; font-src data:; img-src data: blob:; connect-src blob:; worker-src blob:; frame-src about: blob:; form-action 'none'; base-uri 'none'"></head><body><div id="app"></div><script>${runtimeSource.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
			mount.append(frame)
			try {
				await ready
				if (closed) throw new Error('小程序已关闭')
				await beforeCommit()
				if (closed) throw new Error('小程序已关闭')
				signal?.throwIfAborted()
				if (pending !== operation) throw new DOMException('已取消', 'AbortError')
			} catch (error) {
				cancel()
				if (pending === operation) pending = undefined
				throw error
			}
			pending = undefined
			committed = true
			if (stagedStorage) persist(stagedStorage)
			current?.dispose()
			current?.frame.remove()
			current = { frame, dispose }
			updateStatusBarColor(stagedStatusBarColor)
			return frame
		},
		destroy() { pending?.cancel(); pending = undefined; current?.dispose(); current?.frame.remove(); current = undefined },
	}
}
