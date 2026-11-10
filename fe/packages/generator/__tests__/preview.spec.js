// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreview } from '../src/preview.js'

const app = { id: 'test', name: 'Test', resources: {} }
const storageKey = 'dimina-generated-data:test'
const send = (frame, type, body = {}) => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { channel: 'dimina-generator', type, ...body } }))
let preview
function setup(options = {}) {
	const mount = document.createElement('div')
	document.body.append(mount)
	preview = createPreview({ mount, runtimeSource: '', ...options })
	return mount
}
afterEach(() => { preview?.destroy(); document.body.replaceChildren(); localStorage.clear() })

describe('preview commit boundary', () => {
	it('commits the runtime color with its frame and accepts live black/white changes only from that frame', async () => {
		const onStatusBarColorChange = vi.fn()
		const mount = setup({ onStatusBarColorChange })
		const ready = preview.open(app)
		void ready.catch(() => {})
		const frame = mount.querySelector('iframe')
		send(frame, 'statusBarColor', { color: 'white' })
		expect(onStatusBarColorChange).not.toHaveBeenCalled()
		send(frame, 'ready')
		await ready
		expect(onStatusBarColorChange).toHaveBeenLastCalledWith('white')
		onStatusBarColorChange.mockClear()
		window.dispatchEvent(new MessageEvent('message', { source: window, data: { channel: 'dimina-generator', type: 'statusBarColor', color: 'white' } }))
		send(frame, 'statusBarColor', { color: 'red' })
		expect(onStatusBarColorChange).not.toHaveBeenCalled()
		send(frame, 'statusBarColor', { color: 'black' })
		expect(onStatusBarColorChange).toHaveBeenLastCalledWith('black')
	})

	it('keeps the old frame color when a candidate cannot be saved and ignores disposed frames', async () => {
		const onStatusBarColorChange = vi.fn()
		const mount = setup({ onStatusBarColorChange })
		const initial = preview.open(app)
		const original = mount.querySelector('iframe')
		send(original, 'statusBarColor', { color: 'white' })
		send(original, 'ready')
		await initial
		onStatusBarColorChange.mockClear()
		const failed = preview.open(app, { beforeCommit: () => Promise.reject(new Error('quota')) })
		const candidate = mount.querySelectorAll('iframe')[1]
		send(candidate, 'statusBarColor', { color: 'black' })
		send(candidate, 'ready')
		await expect(failed).rejects.toThrow('quota')
		expect(onStatusBarColorChange).not.toHaveBeenCalled()
		const replaced = preview.open(app)
		const replacement = mount.querySelectorAll('iframe')[1]
		send(replacement, 'statusBarColor', { color: 'black' })
		send(replacement, 'ready')
		await replaced
		onStatusBarColorChange.mockClear()
		send(original, 'statusBarColor', { color: 'white' })
		expect(onStatusBarColorChange).not.toHaveBeenCalled()
	})

	it('passes the host status-bar geometry into the isolated runtime without host DOM access', async () => {
		const mount = setup({ statusBarHeight: 48 })
		const ready = preview.open(app)
		void ready.catch(() => {})
		const frame = mount.querySelector('iframe')
		const post = vi.spyOn(frame.contentWindow, 'postMessage')
		send(frame, 'boot')
		expect(post).toHaveBeenCalledWith(expect.objectContaining({ channel: 'dimina-generator', type: 'init', statusBarHeight: 48 }), '*')
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
		send(frame, 'ready')
		await ready
	})

	it('buffers startup storage until readiness and persistence both succeed', async () => {
		const mount = setup()
		const commit = vi.fn()
		const ready = preview.open(app, { beforeCommit: commit })
		// Keep cleanup safe when an earlier assertion fails during an ablation.
		void ready.catch(() => {})
		const frame = mount.querySelector('iframe')
		send(frame, 'storage', { storage: { count: '1' } })
		expect(localStorage.getItem(storageKey)).toBeNull()
		expect(commit).not.toHaveBeenCalled()
		send(frame, 'ready')
		await ready
		expect(commit).toHaveBeenCalledOnce()
		expect(JSON.parse(localStorage.getItem(storageKey))).toEqual({ count: '1' })
	})

	it('preserves the running frame and its data when saving the candidate fails', async () => {
		const mount = setup()
		const initial = preview.open(app)
		const original = mount.querySelector('iframe')
		send(original, 'ready')
		await initial
		localStorage.setItem(storageKey, '{"count":"1"}')
		const next = preview.open(app, { beforeCommit: () => Promise.reject(new Error('quota')) })
		const failed = mount.querySelectorAll('iframe')[1]
		send(failed, 'storage', { storage: { count: '999' } })
		send(failed, 'ready')
		await expect(next).rejects.toThrow('quota')
		expect(mount.querySelectorAll('iframe')).toHaveLength(1)
		expect(original.isConnected).toBe(true)
		expect(localStorage.getItem(storageKey)).toBe('{"count":"1"}')
	})

	it('ignores messages from other windows and cleans up a cancelled startup', async () => {
		const mount = setup()
		const controller = new AbortController()
		const commit = vi.fn()
		const ready = preview.open(app, { signal: controller.signal, beforeCommit: commit })
		window.dispatchEvent(new MessageEvent('message', { source: window, data: { channel: 'dimina-generator', type: 'ready' } }))
		controller.abort()
		await expect(ready).rejects.toMatchObject({ name: 'AbortError' })
		expect(commit).not.toHaveBeenCalled()
		expect(mount.querySelector('iframe')).toBeNull()
	})
})
