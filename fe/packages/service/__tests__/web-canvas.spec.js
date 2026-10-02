import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptWebCanvas, getTransferredCanvas } from '../src/api/core/ui/canvas/web-canvas'
import { hydrateCanvasNode } from '../src/api/core/ui/canvas/canvas-node'
import message from '../src/core/message'

class Offscreen {
	constructor() { this._width = 280; this._height = 240; this.lost = vi.fn(); this.context = { canvas: this, getAttribLocation: () => 7, getExtension: () => ({ loseContext: this.lost }), readPixels: (_x, _y, _w, _h, _f, _t, pixels) => pixels.set([255, 0, 0, 255]) } }
	get width() { return this._width }
	set width(value) { this._width = value }
	get height() { return this._height }
	set height(value) { this._height = value }
	getContext() { return this.context }
}

describe('Worker-owned Web Canvas', () => {
	afterEach(() => message.event.emit('pageUnload', { bridgeId: 'canvas-page' }))
	it('hydrates the transferred identity and reads actual synchronous GL values and pixels', () => {
		const canvas = new Offscreen()
		message.event.emit('canvasTransfer', { nodeId: 'visible-canvas', bridgeId: 'canvas-page', canvas })
		const descriptor = { __diminaNodeType: 'dimina-canvas-node', nodeId: 'visible-canvas', webOffscreen: true }
		expect(hydrateCanvasNode(descriptor, 'canvas-page')).toBe(canvas)
		expect(hydrateCanvasNode(descriptor, 'canvas-page')).toBe(canvas)
		expect(() => hydrateCanvasNode(descriptor, 'other-page')).toThrow('this page')
		const gl = canvas.getContext('webgl')
		expect(gl.canvas).toBe(canvas)
		expect(gl.getAttribLocation({}, 'position')).toBe(7)
		const pixels = new Uint8Array(4)
		gl.readPixels(0, 0, 1, 1, 0, 0, pixels)
		expect([...pixels]).toEqual([255, 0, 0, 255])
		canvas.width = 560
		expect(canvas.width).toBe(560)
		expect(() => { canvas.height = 9999 }).toThrow('maximum canvas bitmap')
	})
	it('releases GL state and invalidates the node only for the owning page', () => {
		const canvas = adoptWebCanvas(new Offscreen(), 'lifecycle', 'canvas-page')
		const gl = canvas.getContext('webgl')
		message.event.emit('canvasTransferredDispose', { bridgeId: 'other-page', nodeId: 'lifecycle' })
		expect(canvas.getContext('webgl')).toBe(gl)
		message.event.emit('canvasTransferredDispose', { bridgeId: 'canvas-page', nodeId: 'lifecycle' })
		expect(canvas.lost).toHaveBeenCalledTimes(1)
		expect(canvas.width).toBe(0)
		expect(canvas.getContext('webgl')).toBeNull()
		expect(() => gl.getAttribLocation({}, 'position')).toThrow('disposed')
		expect(() => getTransferredCanvas('lifecycle', 'canvas-page')).toThrow('not arrived')
		canvas.dispose()
	})
})
