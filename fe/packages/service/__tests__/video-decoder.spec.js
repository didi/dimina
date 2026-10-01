import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/common', () => ({ invokeAPI: vi.fn() }))
import { invokeAPI } from '@/api/common'
import * as wx from '../src/api/core/media/video/index.js'
import { canIUse } from '../src/api/core/base/index.js'

const createVideoDecoder = () => wx.createVideoDecoder()

describe('VideoDecoder native adapter', () => {
	beforeEach(() => vi.mocked(invokeAPI).mockReset())

	it('starts asynchronously in fastest mode, reports dimensions and seeks in milliseconds', async () => {
		const decoder = createVideoDecoder()
		const started = vi.fn()
		const sought = vi.fn()
		decoder.on('start', started)
		decoder.on('seek', sought)
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 2, height: 1 })
		expect(await decoder.start({ source: 'difile://usr/video.mp4' })).toEqual({ width: 2, height: 1 })
		expect(invokeAPI).toHaveBeenLastCalledWith('VideoDecoder.start', expect.objectContaining({ mode: 1 }))
		expect(started).toHaveBeenCalledWith({ width: 2, height: 1 })
		vi.mocked(invokeAPI).mockResolvedValueOnce({})
		expect(await decoder.seek(125)).toBe(125)
		expect(invokeAPI).toHaveBeenLastCalledWith('VideoDecoder.seek', expect.objectContaining({ position: 125 }))
		expect(sought).toHaveBeenCalledWith({ position: 125 })
	})

	it('returns owned RGBA ArrayBuffers synchronously and null while buffering', async () => {
		const decoder = createVideoDecoder()
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 1, height: 1 })
		await decoder.start({ source: 'video.mp4' })
		vi.mocked(invokeAPI).mockReturnValueOnce({ width: 1, height: 1, pts: 0, data: { __diminaArrayBufferBase64: 'AQID/w==' } })
		const frame = decoder.getFrameData()
		expect(frame.data).toBeInstanceOf(ArrayBuffer)
		expect([...new Uint8Array(frame.data)]).toEqual([1, 2, 3, 255])
		expect(invokeAPI).toHaveBeenLastCalledWith('VideoDecoder.getFrameData', expect.any(Object), 'container', false)
		vi.mocked(invokeAPI).mockReturnValueOnce({})
		expect(decoder.getFrameData()).toBeNull()
	})

	it('emits ended once after consuming the final frame and permits seeking from ended', async () => {
		const decoder = createVideoDecoder()
		const ended = vi.fn()
		decoder.on('ended', ended)
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 1, height: 1 })
		await decoder.start({ source: 'video.mp4' })
		vi.mocked(invokeAPI).mockReturnValue({ ended: true })
		decoder.getFrameData()
		decoder.getFrameData()
		expect(ended).toHaveBeenCalledTimes(1)
		vi.mocked(invokeAPI).mockResolvedValueOnce({})
		await decoder.seek(0)
		decoder.getFrameData()
		expect(ended).toHaveBeenCalledTimes(2)
	})

	it('invalidates pending control replies when removed and releases native resources', async () => {
		const decoder = createVideoDecoder()
		const started = vi.fn()
		decoder.on('start', started)
		let finish
		vi.mocked(invokeAPI).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
		const starting = decoder.start({ source: 'video.mp4' })
		await Promise.resolve()
		await decoder.remove()
		finish({ width: 1, height: 1 })
		await expect(starting).rejects.toThrow('removed')
		expect(started).not.toHaveBeenCalled()
		expect(decoder.getFrameData()).toBeNull()
		await expect(decoder.seek(0)).rejects.toThrow('removed')
	})

	it('stops an unfinished start without waiting for its reply and ignores that stale reply', async () => {
		const decoder = createVideoDecoder()
		const started = vi.fn()
		decoder.on('start', started)
		let finishStart
		vi.mocked(invokeAPI).mockImplementation(command => command === 'VideoDecoder.start'
			? new Promise(resolve => { finishStart = resolve }) : Promise.resolve({}))
		const starting = decoder.start({ source: 'https://example.com/slow.mp4' })
		const rejectedStart = expect(starting).rejects.toThrow('stopped')
		await Promise.resolve()
		const stopping = decoder.stop()
		await Promise.resolve()
		expect(invokeAPI).toHaveBeenLastCalledWith('VideoDecoder.stop', expect.any(Object))
		await stopping
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 2, height: 3 })
		await decoder.start({ source: 'ready.mp4' })
		const frame = { width: 2, height: 3, pts: 0, data: new ArrayBuffer(24) }
		vi.mocked(invokeAPI).mockReturnValueOnce(frame)
		expect(decoder.getFrameData()).toEqual(frame)
		finishStart({ width: 1, height: 1 })
		await rejectedStart
		expect(started).toHaveBeenCalledTimes(1)
		expect(decoder.width).toBe(2)
		expect(decoder.height).toBe(3)
	})

	it('cancels a queued start before native dispatch and can restart after stop', async () => {
		const decoder = createVideoDecoder()
		vi.mocked(invokeAPI).mockImplementation(command => command === 'VideoDecoder.stop'
			? Promise.reject(new Error('decoder is not started')) : Promise.resolve({ width: 1, height: 1 }))
		const starting = decoder.start({ source: 'queued.mp4' })
		const rejectedStart = expect(starting).rejects.toThrow('stopped')
		await Promise.all([decoder.stop(), decoder.stop()])
		await rejectedStart
		expect(invokeAPI).not.toHaveBeenCalled()
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 2, height: 1 })
		await decoder.start({ source: 'ready.mp4' })
		expect(invokeAPI).toHaveBeenCalledTimes(1)
	})

	it('validates input and uses native capability checks rather than claiming support on Web', async () => {
		const decoder = createVideoDecoder()
		await expect(decoder.start({ source: 'video.mp4', mode: 3 })).rejects.toThrow('mode')
		await expect(decoder.start({})).rejects.toThrow('source')
		expect(invokeAPI).not.toHaveBeenCalled()
		vi.mocked(invokeAPI).mockReturnValueOnce(false)
		expect(canIUse('createVideoDecoder')).toBe(false)
		expect(invokeAPI).toHaveBeenLastCalledWith('canIUse', 'VideoDecoder.start')
	})

	it('serializes controls, returns no old frames during seek and recovers after a failed operation', async () => {
		const decoder = createVideoDecoder()
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 1, height: 1 })
		await decoder.start({ source: 'video.mp4' })
		let finishSeek
		vi.mocked(invokeAPI).mockReturnValueOnce(new Promise(resolve => { finishSeek = resolve }))
		const seek = decoder.seek(100)
		const stopping = decoder.stop()
		await Promise.resolve()
		const count = vi.mocked(invokeAPI).mock.calls.length
		expect(decoder.getFrameData()).toBeNull()
		expect(invokeAPI).toHaveBeenCalledTimes(count)
		finishSeek({})
		await seek
		await stopping
		expect(invokeAPI).toHaveBeenLastCalledWith('VideoDecoder.stop', expect.any(Object))
		expect(decoder.getFrameData()).toBeNull()
		vi.mocked(invokeAPI).mockRejectedValueOnce(new Error('unsupported codec'))
		await expect(decoder.start({ source: 'bad.mp4' })).rejects.toThrow('unsupported codec')
		vi.mocked(invokeAPI).mockResolvedValueOnce({ width: 1, height: 1 })
		await decoder.start({ source: 'good.mp4' })
		vi.mocked(invokeAPI).mockReturnValueOnce({ error: 'decode failed' })
		expect(() => decoder.getFrameData()).toThrow('decode failed')
	})

	it('supports multiple listeners and selective unsubscribe', async () => {
		const decoder = createVideoDecoder()
		const first = vi.fn(), second = vi.fn()
		decoder.on('start', first)
		decoder.on('start', second)
		decoder.off('start', first)
		vi.mocked(invokeAPI).mockResolvedValue({ width: 1, height: 1 })
		await decoder.start({ source: 'video.mp4' })
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledOnce()
		decoder.off('start')
		await decoder.start({ source: 'video.mp4' })
		expect(second).toHaveBeenCalledOnce()
	})
})
