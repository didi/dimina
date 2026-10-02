import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/core/file', () => ({ getFileSystemManager: () => ({ readFile: readFile }) }))
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
import { demuxMP4, WebVideoDecoder } from '../src/api/core/media/video/web-video-decoder'
import message from '../src/core/message'
import router from '../src/core/router'

const fixture = () => {
	const bytes = fs.readFileSync(new URL('./fixtures/colors.mp4', import.meta.url))
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

class BrowserDecoder {
	static instances = []
	static isConfigSupported = async () => ({ supported: true })
	constructor(callbacks) { this.callbacks = callbacks; this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; BrowserDecoder.instances.push(this) }
	configure(config) { this.config = config; this.state = 'configured' }
	decode(chunk) { this.chunks.push(chunk); this.decodeQueueSize++ }
	addEventListener(_event, listener) { this.dequeue = listener }
	flush() { return Promise.resolve() }
	close() { this.state = 'closed' }
}

function frame(timestamp, pixel = [255, 0, 0, 255]) {
	return { timestamp, displayWidth: 1, displayHeight: 1, visibleRect: {}, close: vi.fn(), copyTo: vi.fn(async data => data.set(pixel)) }
}

describe('WebCodecs video adapter', () => {
	const decoders = []
	function create() { const decoder = new WebVideoDecoder(); decoders.push(decoder); return decoder }
	beforeEach(() => {
		vi.stubGlobal('VideoDecoder', BrowserDecoder)
		vi.stubGlobal('EncodedVideoChunk', class { constructor(options) { Object.assign(this, options) } })
		vi.stubGlobal('OffscreenCanvas', class {})
		BrowserDecoder.instances = []
		readFile.mockImplementation(options => options.success({ data: fixture() }))
	})
	afterEach(async () => { for (const decoder of decoders.splice(0)) await decoder.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

	it('demuxes B frames in decode order and applies the MP4 edit-list offset', () => {
		const media = demuxMP4(fixture())
		expect(media.config.codec).toBe('avc1.64000b')
		expect(media.config.description.byteLength).toBe(31)
		expect(media.samples.map(sample => sample.timestamp)).toEqual([0, 1000000, 500000])
		expect(media.samples.map(sample => sample.key)).toEqual([true, false, false])
		expect(media.samples[0].data.byteLength).toBeGreaterThan(0)
		expect(() => demuxMP4(new ArrayBuffer(0))).toThrow('no video samples')
	})
	it('keeps synchronous owned RGBA frames, bounds feeding, seeks from a key frame and drops stale output', async () => {
		const decoder = create()
		expect(await decoder.start({ source: '/video.mp4' })).toEqual({ width: 16, height: 16 })
		const old = BrowserDecoder.instances.at(-1)
		expect(old.chunks.map(chunk => chunk.type)).toEqual(['key', 'delta'])
		const red = frame(0)
		old.callbacks.output(red)
		await decoder.copyTail
		const result = decoder.getFrameData()
		expect([...new Uint8Array(result.data)]).toEqual([255, 0, 0, 255])
		expect(result.pts).toBe(0)
		expect(red.close).toHaveBeenCalledTimes(1)
		await decoder.seek(500)
		expect(old.state).toBe('closed')
		const stale = frame(1000000)
		old.callbacks.output(stale)
		expect(stale.close).toHaveBeenCalledTimes(1)
		expect(decoder.getFrameData()).toBeNull()
		const current = BrowserDecoder.instances.at(-1)
		const preroll = frame(0)
		current.callbacks.output(preroll)
		expect(preroll.close).toHaveBeenCalled()
		current.callbacks.output(frame(500000, [0, 255, 0, 255]))
		await decoder.copyTail
		expect(decoder.getFrameData().pts).toBe(500000)
		expect([...new Uint8Array(result.data)]).toEqual([255, 0, 0, 255])
	})
	it('preserves browser presentation order when pixel copies finish at different times', async () => {
		const decoder = create()
		await decoder.start({ source: '/video.mp4' })
		const browser = BrowserDecoder.instances.at(-1)
		let finish
		const first = frame(0)
		first.copyTo.mockImplementation(data => new Promise(resolve => { finish = () => { data.set([255, 0, 0, 255]); resolve() } }))
		browser.callbacks.output(first)
		browser.callbacks.output(frame(500000))
		await Promise.resolve()
		expect(decoder.getFrameData()).toBeNull()
		finish()
		await decoder.copyTail
		expect(decoder.getFrameData().pts).toBe(0)
		expect(decoder.getFrameData().pts).toBe(500000)
	})

	it('ends after all actual browser outputs are consumed, including streams with non-display samples', async () => {
		const decoder = create()
		const ended = vi.fn()
		decoder.on('ended', ended)
		await decoder.start({ source: '/video.mp4' })
		const browser = BrowserDecoder.instances.at(-1)
		browser.callbacks.output(frame(0))
		await decoder.copyTail
		expect(decoder.getFrameData().pts).toBe(0)
		browser.callbacks.output(frame(1000000))
		await decoder.copyTail
		expect(decoder.getFrameData().pts).toBe(1000000)
		decoder.inputEnded = true
		expect(decoder.getFrameData()).toBeNull()
		expect(ended).toHaveBeenCalledTimes(1)
	})

	it('cancels a pending source read immediately and does not revive on its late reply', async () => {
		let reply
		readFile.mockImplementation(options => { reply = options.success })
		const decoder = create()
		const start = decoder.start({ source: '/slow.mp4' })
		const rejection = expect(start).rejects.toThrow('stopped')
		await Promise.resolve()
		await decoder.stop()
		await rejection
		reply({ data: fixture() })
		expect(BrowserDecoder.instances).toHaveLength(0)
		readFile.mockImplementation(options => options.success({ data: fixture() }))
		await decoder.start({ source: '/ready.mp4' })
		expect(decoder.running).toBe(true)
		await decoder.remove()
		await expect(decoder.seek(0)).rejects.toThrow('removed')
		await expect(decoder.stop()).rejects.toThrow('removed')
	})
	it('emits ended once, uses a fresh clock after seek, and releases page-owned decoders on unload', async () => {
		vi.spyOn(router, 'getPageInfo').mockReturnValue({ bridgeId: 'video-page' })
		const decoder = create()
		const ended = vi.fn()
		decoder.on('ended', ended)
		await decoder.start({ source: '/video.mp4', mode: 0 })
		const browser = BrowserDecoder.instances.at(-1)
		browser.callbacks.output(frame(0))
		browser.callbacks.output(frame(500000))
		browser.callbacks.output(frame(1000000))
		await decoder.copyTail
		expect(decoder.getFrameData().pts).toBe(0)
		expect(decoder.getFrameData()).toBeNull()
		decoder.clock -= 1001
		expect(decoder.getFrameData().pts).toBe(500000)
		expect(decoder.getFrameData().pts).toBe(1000000)
		decoder.inputEnded = true
		decoder.getFrameData(); decoder.getFrameData()
		expect(ended).toHaveBeenCalledTimes(1)
		await decoder.seek(0)
		expect(decoder.clock).toBeUndefined()
		message.event.emit('pageUnload', { bridgeId: 'video-page' })
		expect(decoder.removed).toBe(true)
		expect(BrowserDecoder.instances.at(-1).state).toBe('closed')
	})
})
