import { expect, it, vi } from 'vitest'
import { WebGLFramePresentation } from '../src/core/webgl-frame-presentation'

function fixture(preserveDrawingBuffer = false) {
	const names = ['DRAW_FRAMEBUFFER_BINDING', 'DRAW_FRAMEBUFFER', 'SCISSOR_TEST', 'COLOR_WRITEMASK', 'DEPTH_WRITEMASK',
		'STENCIL_WRITEMASK', 'STENCIL_BACK_WRITEMASK', 'COLOR_CLEAR_VALUE', 'DEPTH_CLEAR_VALUE', 'STENCIL_CLEAR_VALUE', 'FRONT', 'BACK']
	const gl = Object.fromEntries(names.map((name, index) => [name, index + 1]))
	Object.assign(gl, { COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400 })
	const state = new Map([
		[gl.DRAW_FRAMEBUFFER_BINDING, null], [gl.COLOR_WRITEMASK, [false, true, false, true]], [gl.DEPTH_WRITEMASK, false],
		[gl.STENCIL_WRITEMASK, 3], [gl.STENCIL_BACK_WRITEMASK, 7], [gl.COLOR_CLEAR_VALUE, [0.2, 0.3, 0.4, 0.5]],
		[gl.DEPTH_CLEAR_VALUE, 0.25], [gl.STENCIL_CLEAR_VALUE, 2], [gl.SCISSOR_TEST, true],
	])
	Object.assign(gl, {
		getParameter: key => state.get(key), isEnabled: key => state.get(key), isContextLost: () => false,
		getContextAttributes: () => ({ preserveDrawingBuffer }),
		bindFramebuffer: (_target, value) => state.set(gl.DRAW_FRAMEBUFFER_BINDING, value),
		enable: key => state.set(key, true), disable: key => state.set(key, false),
		colorMask: (...value) => state.set(gl.COLOR_WRITEMASK, value), depthMask: value => state.set(gl.DEPTH_WRITEMASK, value),
		stencilMaskSeparate: (face, value) => state.set(face === gl.FRONT ? gl.STENCIL_WRITEMASK : gl.STENCIL_BACK_WRITEMASK, value),
		clearColor: (...value) => state.set(gl.COLOR_CLEAR_VALUE, value), clearDepth: value => state.set(gl.DEPTH_CLEAR_VALUE, value),
		clearStencil: value => state.set(gl.STENCIL_CLEAR_VALUE, value), clear: vi.fn(() => new Map(state)),
	})
	const context = { drawImage: vi.fn() }
	const canvas = { getContext: () => context }
	const drawing = { width: 8, height: 8 }
	return { gl, state, context, drawing, presentation: new WebGLFramePresentation(canvas, drawing, gl) }
}

it('presents only completed default-framebuffer draws, never resource queries or offscreen draws', () => {
	const { gl, state, context, drawing, presentation } = fixture(true)
	presentation.markDraw('compileShader'); presentation.markDraw('drawBuffers'); presentation.present()
	expect(context.drawImage).not.toHaveBeenCalled()
	state.set(gl.DRAW_FRAMEBUFFER_BINDING, {})
	presentation.markDraw('drawArrays'); presentation.present()
	expect(context.drawImage).not.toHaveBeenCalled()
	state.set(gl.DRAW_FRAMEBUFFER_BINDING, null)
	presentation.markDraw('drawArraysInstancedANGLE')
	expect(context.drawImage).not.toHaveBeenCalled()
	presentation.present(); presentation.present()
	expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(drawing, 0, 0)
	expect(context.globalCompositeOperation).toBe('copy')
	expect(gl.clear).not.toHaveBeenCalled()
	for (const method of ['clearBufferfv', 'clearBufferiv', 'clearBufferuiv', 'clearBufferfi']) {
		presentation.markDraw(method); presentation.present()
	}
	expect(context.drawImage).toHaveBeenCalledTimes(5)
})

it('clears non-preserved color, depth and stencil after presentation and restores application state', () => {
	const { gl, state, presentation } = fixture()
	presentation.markDraw('clear')
	// The frame may finish with an application framebuffer bound.
	state.set(gl.DRAW_FRAMEBUFFER_BINDING, { id: 'application-fbo' })
	const original = new Map(state)
	presentation.present()
	expect(gl.clear).toHaveBeenCalledExactlyOnceWith(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
	const cleared = gl.clear.mock.results[0].value
	expect(cleared.get(gl.DRAW_FRAMEBUFFER_BINDING)).toBeNull()
	expect(cleared.get(gl.SCISSOR_TEST)).toBe(false)
	expect(cleared.get(gl.COLOR_WRITEMASK)).toEqual([true, true, true, true])
	expect(cleared.get(gl.DEPTH_WRITEMASK)).toBe(true)
	expect(cleared.get(gl.STENCIL_WRITEMASK)).toBe(0xFFFFFFFF)
	expect(cleared.get(gl.STENCIL_BACK_WRITEMASK)).toBe(0xFFFFFFFF)
	expect(cleared.get(gl.COLOR_CLEAR_VALUE)).toEqual([0, 0, 0, 0])
	expect(cleared.get(gl.DEPTH_CLEAR_VALUE)).toBe(1)
	expect(cleared.get(gl.STENCIL_CLEAR_VALUE)).toBe(0)
	expect(state).toEqual(original)
})

it('does not copy an empty drawing surface', () => {
	const { drawing, context, presentation } = fixture()
	drawing.width = 0
	presentation.markDraw('clear'); presentation.present()
	expect(context.drawImage).not.toHaveBeenCalled()
	expect(presentation.dirty).toBe(false)
})
