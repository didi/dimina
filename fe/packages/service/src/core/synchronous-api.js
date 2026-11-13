/**
 * An opt-in host transport for desktop Workers. Browser/native consumers without
 * an endpoint keep their existing bridge. Blocking work stays off the UI thread.
 */
export function invokeSynchronousAPI(msg) {
	if (msg.type !== 'invokeAPI' || msg.target !== 'container' || !(msg.body?.name?.endsWith('Sync') || msg.body?.name === 'canIUse' || /^(?:(UDP|TCP)Socket\.|(on|off)(Bluetooth|BLE))/.test(msg.body?.name))) {
		return { handled: false }
	}
	let endpoint
	try { endpoint = JSON.parse(globalThis.name || '{}').synchronousApiUrl }
	catch { return { handled: false } }
	if (!endpoint) return { handled: false }
	const url = new URL(endpoint, globalThis.location.href)
	if (url.origin !== globalThis.location.origin || !['http:', 'https:'].includes(url.protocol)) {
		throw new Error(`${msg.body.name}:fail synchronous API endpoint must be same-origin HTTP(S)`)
	}
	const xhr = new XMLHttpRequest()
	xhr.open('POST', url.href, false)
	xhr.setRequestHeader('Content-Type', 'application/json')
	xhr.send(JSON.stringify({ name: msg.body.name, params: msg.body.params }))
	let result
	try { result = JSON.parse(xhr.responseText) }
	catch { throw new Error(`${msg.body.name}:fail invalid host response`) }
	if (xhr.status !== 200 || result.error) throw new Error(`${msg.body.name}:fail ${result.error || `HTTP ${xhr.status}`}`)
	return { handled: true, value: result.value }
}
