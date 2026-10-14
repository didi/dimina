// A native Service turn spans several WebView tasks when it queries shaders.
// Keep those tasks on a detached drawing surface, then publish the completed
// batch to the visible canvas once the Service turn has returned.
export class WebGLFramePresentation {
	constructor(canvas, drawingCanvas, gl) {
		this.canvas = canvas
		this.drawingCanvas = drawingCanvas
		this.gl = gl
		this.context = canvas.getContext('2d')
		this.dirty = false
	}

	markDraw(method) {
		if (method !== 'clear' && !/^clearBuffer(?:fv|iv|uiv|fi)$/.test(method) && method !== 'blitFramebuffer'
			&& !/^draw(?:Arrays|Elements|RangeElements)|^multiDraw/.test(method)) return
		const gl = this.gl
		if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING ?? gl.FRAMEBUFFER_BINDING) === null) this.dirty = true
	}

	present() {
		if (!this.dirty || this.gl.isContextLost()) return
		if (this.drawingCanvas.width === 0 || this.drawingCanvas.height === 0) { this.dirty = false; return }
		this.context.globalCompositeOperation = 'copy'
		this.context.drawImage(this.drawingCanvas, 0, 0)
		this.dirty = false
		if (!this.gl.getContextAttributes().preserveDrawingBuffer) this.clearDrawingBuffer()
	}

	clearDrawingBuffer() {
		// Emulate the default drawing-buffer clear after presentation, including
		// depth/stencil, without changing the application's framebuffer or masks.
		const gl = this.gl
		const target = gl.DRAW_FRAMEBUFFER ?? gl.FRAMEBUFFER
		const framebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING ?? gl.FRAMEBUFFER_BINDING)
		const scissor = gl.isEnabled(gl.SCISSOR_TEST)
		const colorMask = gl.getParameter(gl.COLOR_WRITEMASK)
		const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK)
		const stencilMask = gl.getParameter(gl.STENCIL_WRITEMASK)
		const backStencilMask = gl.getParameter(gl.STENCIL_BACK_WRITEMASK)
		const color = gl.getParameter(gl.COLOR_CLEAR_VALUE)
		const depth = gl.getParameter(gl.DEPTH_CLEAR_VALUE)
		const stencil = gl.getParameter(gl.STENCIL_CLEAR_VALUE)
		gl.bindFramebuffer(target, null)
		gl.disable(gl.SCISSOR_TEST)
		gl.colorMask(true, true, true, true)
		gl.depthMask(true)
		gl.stencilMaskSeparate(gl.FRONT, 0xFFFFFFFF)
		gl.stencilMaskSeparate(gl.BACK, 0xFFFFFFFF)
		gl.clearColor(0, 0, 0, 0)
		gl.clearDepth(1)
		gl.clearStencil(0)
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT)
		gl.clearColor(...color)
		gl.clearDepth(depth)
		gl.clearStencil(stencil)
		gl.colorMask(...colorMask)
		gl.depthMask(depthMask)
		gl.stencilMaskSeparate(gl.FRONT, stencilMask)
		gl.stencilMaskSeparate(gl.BACK, backStencilMask)
		if (scissor) gl.enable(gl.SCISSOR_TEST)
		gl.bindFramebuffer(target, framebuffer)
	}
}
