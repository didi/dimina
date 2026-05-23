import VConsole from 'vconsole'

function setupVConsole(options = {}) {
	if (!window.vConsole) {
		const vConsole = new VConsole()
		vConsole.setSwitchPosition(options.x ?? 10, options.y ?? 140)
		window.vConsole = vConsole
	}
	return window.vConsole
}

window.__dimina_enable_vconsole__ = function enableVConsole(options = {}) {
	return Promise.resolve(setupVConsole(options))
}

if (new URLSearchParams(window.location.search).get('vconsole') === '1') {
	window.__dimina_enable_vconsole__()
}
