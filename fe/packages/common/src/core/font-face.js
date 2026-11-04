export const HOST_FONT_PATH = '/__dimina_host_fonts/'

// A host ID is an opaque registry key, never a filesystem path.
export function normalizeFontFace(options) {
	if (!options || typeof options.family !== 'string' || !options.family.trim()) {
		throw new Error('family must be a non-empty string')
	}
	if (typeof options.source !== 'string' || !options.source.trim()) {
		throw new Error('source must be a non-empty string')
	}
	if (options.global !== undefined && typeof options.global !== 'boolean') {
		throw new Error('global must be a boolean')
	}
	if (options.desc !== undefined && (!options.desc || typeof options.desc !== 'object' || Array.isArray(options.desc))) {
		throw new Error('desc must be an object')
	}
	if (options.scopes !== undefined && (!Array.isArray(options.scopes)
		|| !options.scopes.length || options.scopes.some(scope => scope !== 'webview'))) {
		throw new Error('only the webview scope is supported')
	}
	const desc = {}
	for (const name of ['style', 'weight', 'variant']) {
		const value = options.desc?.[name]
		if (value !== undefined && typeof value !== 'string') throw new Error(`desc.${name} must be a string`)
		desc[name] = value ?? 'normal'
	}
	const source = options.source.trim()
	if (source.includes('dimina-font:') && !/^url\(\s*(["']?)dimina-font:\/\/[A-Za-z0-9_-]{1,128}\1\s*\)$/.test(source)) {
		throw new Error('invalid host font source')
	}
	return { family: options.family.trim(), source, desc }
}

export function fontFaceKey(font) {
	return JSON.stringify([font.family, font.desc.style, font.desc.weight, font.desc.variant])
}

export function resolveFontFaceSource(source, baseUrl) {
	return source.replace(/^url\(\s*(["']?)dimina-font:\/\/([A-Za-z0-9_-]{1,128})\1\s*\)$/, (_, _quote, id) =>
		`url("${new URL(`${HOST_FONT_PATH}${id}`, baseUrl).href}")`)
}
