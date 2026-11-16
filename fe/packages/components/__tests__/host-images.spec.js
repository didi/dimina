/** @vitest-environment jsdom */
import { createApp, h, nextTick, reactive } from 'vue'
import Image from '../src/component/image/Image.vue'
import { resolveImageSource } from '../src/common/hostImages'

vi.mock('../src/common/events', () => ({ useInfo: () => ({}), triggerEvent: vi.fn() }))
vi.mock('../src/common/useTouchEvents', () => ({ useTouchEvents: vi.fn() }))

it.each(['https://dimina.local/pageFrame.html', 'dimina:///pageFrame.html', 'http://127.0.0.1/pageFrame.html', 'file:///pageFrame.html'])('resolves host IDs and nested paths on %s', (base) => {
	expect(resolveImageSource('dimina-image://Light_ON', base)).toBe(new URL('/__dimina_host_images/Light_ON', base).href)
	expect(resolveImageSource('dimina-image://icons/device/灯 on.svg?v=2#light', base))
		.toBe(new URL('/__dimina_host_images/icons/device/%E7%81%AF%20on.svg?v=2#light', base).href)
})

it.each(['icons/../secret.png', 'icons/%2e%2e/secret.png', 'icons/%252e%252e/secret.png', 'icons/a%2fb.png', 'icons/a\\b.png', 'icons//b.png', 'icons/a%00.png', 'icons/%zz', '', '../x', 'bad.id'])('rejects malformed host image reference %s before URL normalization', (key) => {
	expect(resolveImageSource(`dimina-image://${key}`, 'https://dimina.local/pageFrame.html'))
		.toBe('https://dimina.local/__dimina_host_images/!invalid')
})

it.each([null, undefined, '', '/app/main/static/a.png', 'relative.png', 'https://cdn.example/a.png', 'difile://usr/a.png', 'data:image/png;base64,a'])('preserves existing source %s', (src) => {
	expect(resolveImageSource(src, 'https://dimina.local/pageFrame.html')).toBe(src)
})

it.each([
	['img', null], ['backgroundImage', null],
	['img', undefined], ['backgroundImage', undefined],
])('mounts an empty %s image with src %s', (renderingMode, src) => {
	const host = document.createElement('div')
	const onError = vi.fn()
	const app = createApp({ render: () => h(Image, { src, renderingMode }) })
	app.config.errorHandler = onError
	try {
		app.mount(host)
		expect(onError).not.toHaveBeenCalled()
		expect(host.querySelector('img')).not.toBeNull()
		expect(host.querySelector('img').getAttribute('src')).toBe(src === null ? null : '')
		expect(host.querySelector('.dd-image').style.backgroundImage).toBe('')
	} finally { app.unmount() }
})

it.each(['img', 'backgroundImage'])('clears and restores ordinary and host images in %s mode', async (renderingMode) => {
	const props = reactive({ src: '/ordinary.png', renderingMode })
	const host = document.createElement('div')
	const onError = vi.fn()
	const app = createApp({ render: () => h(Image, props) })
	app.config.errorHandler = onError
	try {
		app.mount(host)
		for (const src of ['/ordinary.png', 'dimina-image://Light_ON']) {
			props.src = src
			await nextTick()
			expect(host.querySelector('img').getAttribute('src')).toBe(resolveImageSource(src))
			props.src = null
			await nextTick()
			expect(onError).not.toHaveBeenCalled()
			expect(host.querySelector('img').getAttribute('src')).toBeNull()
			expect(host.querySelector('.dd-image').style.backgroundImage).toBe('')
		}
		props.src = 'dimina-image://restored'
		await nextTick()
		expect(host.querySelector('img').getAttribute('src')).toBe(resolveImageSource(props.src))
	} finally { app.unmount() }
})

it('accepts a null lazy source when it enters the viewport', async () => {
	let intersect
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback) { intersect = callback }
		observe() {}
		disconnect() {}
	})
	const host = document.createElement('div')
	const onError = vi.fn()
	const app = createApp({ render: () => h(Image, { src: null, lazyLoad: true }) })
	app.config.errorHandler = onError
	try {
		app.mount(host)
		expect(host.querySelector('img').getAttribute('src')).toBe('')
		expect(() => intersect([{ isIntersecting: true }])).not.toThrow()
		await nextTick()
		expect(onError).not.toHaveBeenCalled()
		expect(host.querySelector('img').getAttribute('src')).toBeNull()
		expect(host.querySelector('.dd-image').style.backgroundImage).toBe('')
	} finally { app.unmount(); vi.unstubAllGlobals() }
})

it('uses the resolved URL for both image rendering modes and reactive src changes', async () => {
	const props = reactive({ src: 'dimina-image://Light_ON', renderingMode: 'backgroundImage' })
	const host = document.createElement('div')
	document.body.appendChild(host)
	const app = createApp({ render: () => h(Image, props) })
	try {
		app.mount(host)
		expect(host.querySelector('img').getAttribute('src')).toBe(resolveImageSource(props.src))
		expect(host.querySelector('.dd-image').style.backgroundImage).toContain('/__dimina_host_images/Light_ON')
		props.src = 'dimina-image://icons/nested/light.webp'
		props.renderingMode = 'img'
		await nextTick()
		expect(host.querySelector('img').getAttribute('src')).toBe(resolveImageSource(props.src))
		expect(host.querySelector('.dd-image').style.backgroundImage).toBe('')
		props.src = '/ordinary.png'
		await nextTick()
		expect(host.querySelector('img').getAttribute('src')).toBe('/ordinary.png')
	} finally { app.unmount(); host.remove() }
})

it('resolves lazy images only when they enter the viewport', async () => {
	let intersect
	vi.stubGlobal('IntersectionObserver', class {
		constructor(callback) { intersect = callback }
		observe() {}
		disconnect() {}
	})
	const host = document.createElement('div')
	const app = createApp({ render: () => h(Image, { src: 'dimina-image://lazy', lazyLoad: true }) })
	try {
		app.mount(host)
		expect(host.querySelector('img').getAttribute('src')).toBe('')
		intersect([{ isIntersecting: true }])
		await nextTick()
		expect(host.querySelector('img').getAttribute('src')).toBe(resolveImageSource('dimina-image://lazy'))
	} finally { app.unmount(); vi.unstubAllGlobals() }
})
