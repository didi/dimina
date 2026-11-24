/** @vitest-environment jsdom */

import { createApp, h, nextTick, provide, reactive } from 'vue'
import Video from '../src/component/video/Video.vue'

const mounts = []
let listeners

async function mountVideo(values = {}) {
	const props = reactive({ id: 'video', src: 'assets/clip.mp4', bindplay: 'played', ...values })
	const host = document.createElement('div')
	const app = createApp({
		setup() {
			provide('bridgeId', 'page-1')
			provide('path', 'page')
			provide('page', { id: 'module-1' })
			return () => h(Video, props)
		},
	})
	app.mount(host)
	mounts.push(app)
	await nextTick()
	return { host, props, video: host.querySelector('video') }
}

beforeEach(() => {
	listeners = new Map()
	window.__message = {
		invoke: vi.fn(),
		send: vi.fn(),
		on: (name, fn) => listeners.set(name, fn),
		off: name => listeners.delete(name),
	}
})

afterEach(() => {
	for (const app of mounts.splice(0)) app.unmount()
	delete window.__message
	delete window.DiminaRenderBridge
	delete window.__diminaLocalMediaUrl
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

it('keeps the same CSS-styled video and playback position with controls on or off', async () => {
	const { host, props, video } = await mountVideo({
		autoplay: true, loop: true, muted: true, style: 'position:absolute;z-index:8',
	})
	const root = host.querySelector('#video')
	expect(root.style.zIndex).toBe('8')
	expect(root.contains(video)).toBe(true)
	expect(video.hasAttribute('playsinline')).toBe(true)
	expect(video.autoplay && video.loop && video.muted).toBe(true)
	expect(host.querySelector('.dd-video-controls')).not.toBeNull()
	video.currentTime = 1.25

	props.controls = false
	await nextTick()
	expect(host.querySelector('.dd-video-controls')).toBeNull()
	expect(host.querySelector('video')).toBe(video)
	expect(video.currentTime).toBe(1.25)

	props.controls = true
	await nextTick()
	expect(host.querySelector('.dd-video-controls')).not.toBeNull()
	expect(host.querySelector('video')).toBe(video)
	expect(video.currentTime).toBe(1.25)
	expect(window.__message.invoke).not.toHaveBeenCalled()
})

it('honors play button visibility and sends commands and events through the DOM player', async () => {
	const { host, video } = await mountVideo({ showCenterPlayBtn: false, showPlayBtn: false })
	expect(host.querySelector('.dd-video-center')).toBeNull()
	expect(host.querySelector('[aria-label="播放"]')).toBeNull()
	const play = vi.spyOn(video, 'play').mockResolvedValue()
	const pause = vi.spyOn(video, 'pause').mockImplementation(() => {})
	Object.defineProperty(video, 'readyState', { value: 1 })
	const command = listeners.get('videoContext')
	command({ id: 'video', moduleId: 'other-module', command: 'play' })
	command({ id: 'video', command: 'play' })
	command({ id: 'video', command: 'seek', position: 3 })
	command({ id: 'video', command: 'pause' })
	expect(play).toHaveBeenCalledOnce()
	expect(pause).toHaveBeenCalledOnce()
	expect(video.currentTime).toBe(3)

	video.dispatchEvent(new Event('play'))
	expect(window.__message.send).toHaveBeenCalledWith(expect.objectContaining({
		body: expect.objectContaining({
			methodName: 'played',
			event: expect.objectContaining({
				currentTarget: expect.objectContaining({ id: 'video' }),
				detail: { id: 'video', src: 'assets/clip.mp4' },
			}),
		}),
	}))
})

it('forwards the VideoContext fullscreen direction when the browser can lock orientation', async () => {
	const { host } = await mountVideo()
	const enter = vi.fn().mockResolvedValue()
	const lock = vi.fn().mockResolvedValue()
	host.querySelector('#video').requestFullscreen = enter
	vi.stubGlobal('screen', { orientation: { lock } })
	Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
	try {
		listeners.get('videoContext')({ id: 'video', command: 'requestFullScreen', direction: 90 })
		await Promise.resolve()
		expect(enter).toHaveBeenCalledOnce()
		expect(lock).toHaveBeenCalledWith('landscape-primary')
	} finally {
		delete document.fullscreenEnabled
	}
})

it.each([
	'dimina:///__dimina_media',
	'https://appassets.androidplatform.net/__dimina_media',
	'http://127.0.0.1/__dimina_media',
])('resolves local media through the host resource handler and plays remote URLs directly', async (endpoint) => {
	window.DiminaRenderBridge = endpoint.startsWith('dimina:')
		? { localMediaUrl: endpoint }
		: { endpoint, localMediaUrl() { return this.endpoint } }
	if (endpoint.startsWith('http:')) {
		window.__diminaLocalMediaUrl = endpoint
		delete window.DiminaRenderBridge
	}
	const { props, video } = await mountVideo({ src: 'difile://tmp/My + clip.mp4', poster: 'assets/frame.jpg' })
	expect(video.getAttribute('src')).toBe(`${endpoint}?source=difile%3A%2F%2Ftmp%2FMy%20%2B%20clip.mp4`)
	expect(video.getAttribute('poster')).toBe(`${endpoint}?source=assets%2Fframe.jpg`)
	props.src = 'https://example.test/clip.mp4'
	await nextTick()
	expect(video.getAttribute('src')).toBe(props.src)
})

it('uses the Web chooseVideo temporary blob URL directly', async () => {
	const tempFilePath = 'blob:https://example.test/selected-video'
	window.DiminaRenderBridge = { localMediaUrl: vi.fn() }
	const { video } = await mountVideo({ src: tempFilePath })
	expect(video.getAttribute('src')).toBe(tempFilePath)
	expect(window.DiminaRenderBridge.localMediaUrl).not.toHaveBeenCalled()
})
