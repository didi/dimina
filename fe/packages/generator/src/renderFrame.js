import '@dimina/fe-container-sdk/pageFrame'
import '@dimina/fe-container-sdk/pageFrame.css'

// A sandboxed srcdoc has its own opaque origin. Communicate through a port,
// without giving either the render frame or its generated code host DOM access.
window.addEventListener('message', event => {
	if (event.source !== parent || event.data?.type !== 'dimina:connect' || !event.ports[0]) return
	const port = event.ports[0]
	const bridge = window.DiminaRenderBridge
	bridge.mapRenderer = 'web'
	bridge.invoke = message => port.postMessage({ type: 'invoke', message })
	bridge.publish = message => port.postMessage({ type: 'publish', message })
	bridge.publishTransfer = (message, transferables) => port.postMessage({ type: 'publish', message }, transferables)
	port.onmessage = ({ data }) => bridge.onMessage(data)
}, { once: true })
