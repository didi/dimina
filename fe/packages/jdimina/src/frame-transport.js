// Stable wire protocol shared with the web-view render component. The SDK is
// also distributed as a standalone script, without a dependency on the runtime.
const CHANNEL = 'dimina:web-view:v1'

export function createFrameTransport(win, onCallback) {
	// Some native hosts expose their proxy to every subframe. A child document
	// must still use its owning web-view component rather than the host proxy.
	if (win.parent === win) return null
	const session = `${Date.now()}-${Math.random().toString(36).slice(2)}`
	let parentOrigin = '*'
	const receive = (event) => {
		const data = event.data
		if (event.source !== win.parent || data?.channel !== CHANNEL || data.session !== session) return
		if (parentOrigin !== '*' && event.origin !== parentOrigin) return
		if (data.kind === 'ready') {
			parentOrigin = event.origin === 'null' ? '*' : event.origin
			win.__wxjs_environment = 'miniprogram'
			win.dispatchEvent(new win.Event('didiJsBridgeLoaded'))
		}
		else if (data.kind === 'callback') onCallback(data.id, data.args)
	}
	win.addEventListener('message', receive)
	win.parent.postMessage({ channel: CHANNEL, kind: 'hello', session }, '*')
	return {
		invoke(request) {
			win.parent.postMessage({ channel: CHANNEL, kind: 'invoke', session, request }, parentOrigin)
		},
	}
}
