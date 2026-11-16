const HOST_IMAGE_PREFIX = 'dimina-image://'
const HOST_IMAGE_PATH = '/__dimina_host_images/'

// Resolve on the render origin, preserving ID case and avoiding custom-scheme WebView differences.
export function resolveImageSource(source, baseUrl = document.baseURI) {
	if (typeof source !== 'string' || !source.startsWith(HOST_IMAGE_PREFIX)) return source
	const reference = source.slice(HOST_IMAGE_PREFIX.length)
	const [path] = reference.split(/[?#]/, 1)
	try {
		if (/%(?:2f|5c)/i.test(path)) throw new Error('encoded separator')
		const parts = decodeURIComponent(path).split('/')
		if (!/^[A-Za-z0-9_-]{1,128}$/.test(parts[0]) || parts.some(part =>
			// eslint-disable-next-line no-control-regex -- Host paths must reject control characters.
			!part || part === '.' || part === '..' || /[\\%?#\u0000-\u001F\u007F]/.test(part))) {
			throw new Error('invalid host image path')
		}
		return new URL(`${HOST_IMAGE_PATH}${parts.map(encodeURIComponent).join('/')}${reference.slice(path.length)}`, baseUrl).href
	}
	catch {
		// A deterministic local failure, without normalizing traversal into another registered image.
		return new URL(`${HOST_IMAGE_PATH}!invalid`, baseUrl).href
	}
}
