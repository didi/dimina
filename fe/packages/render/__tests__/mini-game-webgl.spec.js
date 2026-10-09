import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Native Service and Render have separate JavaScript environments. Keep their
// messages queued and JSON-encoded here, including capabilities that cannot
// reach Service until the synchronous game entry has returned.
const clone = value => JSON.parse(JSON.stringify(value))
const bridgeId = 'native-game-webgl'
let runtime
let serviceMessage
let renderMessage
let canvasApi
let hostEnv
let router
let callback
let toRender
let toService
let contexts

function drainRender() {
	while (toRender.length) window.DiminaRenderBridge.onMessage(toRender.shift())
}

function drainService() {
	while (toService.length) globalThis.DiminaServiceBridge.onMessage(toService.shift())
}

function createHostGL(canvas, attributes, type) {
	const commands = []
	const halfFloat = Object.create({ get HALF_FLOAT_OES() { return 0x8D61 } })
	const anisotropic = Object.create({ get TEXTURE_MAX_ANISOTROPY_EXT() { return 0x84FE } })
	const astc = Object.create(Object.defineProperties({}, {
		COMPRESSED_RGBA_ASTC_6x6_KHR: { value: 0x93B4 },
		COMPRESSED_RGBA_ASTC_10x10_KHR: { value: 0x93BB },
		COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR: { value: 0x93DD },
		getSupportedProfiles: { value: () => ['ldr'] },
	}))
	let currentProgram
	let currentBuffer
	let currentVertexArray = { elementBuffer: null }
	let viewport = new Int32Array([0, 0, canvas.width, canvas.height])
	const vertexArrays = new Set()
	const vao = {
		createVertexArrayOES() {
			if (gl.failVertexArrayCreation) return null
			const value = { elementBuffer: null }
			vertexArrays.add(value)
			return value
		},
		bindVertexArrayOES(value) { currentVertexArray = value || { elementBuffer: null } },
		isVertexArrayOES(value) {
			if (value && !('elementBuffer' in value)) throw new TypeError('Expected a WebGLVertexArrayObjectOES')
			return vertexArrays.has(value)
		},
		deleteVertexArrayOES(value) { vertexArrays.delete(value) },
	}
	let color = new Uint8Array(4)
	const gl = {
		canvas, commands,
		NO_ERROR: 0, VERTEX_SHADER: 0x8B31, FRAGMENT_SHADER: 0x8B30,
		COMPILE_STATUS: 0x8B81, SHADER_TYPE: 0x8B4F,
		LINK_STATUS: 0x8B82, VALIDATE_STATUS: 0x8B83, ACTIVE_UNIFORMS: 0x8B86,
		FLOAT_VEC4: 0x8B52, ARRAY_BUFFER: 0x8892, STATIC_DRAW: 0x88E4,
		FLOAT: 0x1406, TRIANGLES: 4, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
		VIEWPORT: 0x0BA2, ELEMENT_ARRAY_BUFFER: 0x8893, ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
		SYNC_GPU_COMMANDS_COMPLETE: 0x9117, TIMEOUT_EXPIRED: 0x911B,
		getContextAttributes: () => gl.lost ? null : ({ alpha: true, preserveDrawingBuffer: false, ...attributes }),
		getSupportedExtensions: () => gl.lost ? null : [
			'EXT_texture_filter_anisotropic', 'WEBGL_compressed_texture_astc', 'OES_vertex_array_object', 'advertised-unavailable',
			...(type === 'webgl' ? ['OES_texture_half_float'] : []),
		],
		getExtension: name => name === 'EXT_texture_filter_anisotropic'
			? anisotropic
			: name === 'WEBGL_compressed_texture_astc' ? astc
				: name === 'OES_vertex_array_object' ? vao
					: name === 'OES_texture_half_float' && type === 'webgl' ? halfFloat : null,
		getParameter: pname => pname === gl.VIEWPORT ? viewport.slice()
			: pname === gl.ELEMENT_ARRAY_BUFFER_BINDING ? currentVertexArray.elementBuffer : null,
		viewport(x, y, width, height) { if (width >= 0 && height >= 0) viewport = new Int32Array([x, y, width, height]) },
		getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
		isContextLost: () => Boolean(gl.lost),
		getError: () => 0,
		createShader(type) { const shader = { type }; commands.push(['createShader', shader]); return shader },
		shaderSource(shader, source) { shader.source = source; commands.push(['shaderSource', shader]) },
		compileShader(shader) { shader.compiled = shader.source !== 'invalid'; commands.push(['compileShader', shader]) },
		getShaderParameter: (shader, pname) => pname === gl.SHADER_TYPE ? shader.type : shader.compiled,
		getShaderInfoLog: shader => shader.compiled ? '' : 'shader compilation failed',
		createProgram() { return { shaders: [] } },
		attachShader(program, shader) { program.shaders.push(shader) },
		linkProgram(program) { program.linked = program.shaders.every(shader => shader.compiled); commands.push(['linkProgram', program]) },
		getProgramParameter: (program, pname) => pname === gl.ACTIVE_UNIFORMS ? 1 : Boolean(program.linked),
		getActiveUniform: () => Object.create({ name: 'color', size: 1, type: gl.FLOAT_VEC4 }),
		getAttribLocation: (_program, name) => name === 'position' ? 0 : -1,
		getUniformLocation: (program, name) => name === 'color' ? { program, name } : null,
		useProgram(program) { currentProgram = program; commands.push(['useProgram', program]) },
		uniform4fv(location, values) { commands.push(['uniform4fv', location, values]); color = Uint8Array.from(values, channel => Math.round(channel * 255)) },
		texImage2D(...args) { commands.push(['texImage2D', ...args]) },
		compressedTexImage2D(...args) { commands.push(['compressedTexImage2D', ...args]) },
		texParameterf(...args) { commands.push(['texParameterf', ...args]) },
		createBuffer: () => ({}),
		bindBuffer(target, buffer) {
			if (target === gl.ELEMENT_ARRAY_BUFFER) currentVertexArray.elementBuffer = buffer
			else currentBuffer = buffer
		},
		bufferData(_target, values, usage) { currentBuffer.vertices = values; commands.push(['bufferData', values, usage]) },
		vertexAttribPointer(...args) { commands.push(['vertexAttribPointer', ...args]) },
		enableVertexAttribArray(location) { commands.push(['enableVertexAttribArray', location]) },
		drawArrays(...args) { commands.push(['drawArrays', currentProgram, currentBuffer, ...args]) },
		readPixels(_x, _y, _width, _height, _format, _type, pixels) { pixels.set(color); commands.push(['readPixels']) },
	}
	if (type === 'webgl2') {
		gl.fenceSync = () => ({})
		gl.clientWaitSync = () => gl.TIMEOUT_EXPIRED
		gl.texStorage2D = () => {}
		gl.getBufferSubData = (_target, _offset, data, destinationOffset = 0, length = 0) => {
			const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			bytes.fill(42, destinationOffset, length ? destinationOffset + length : bytes.length)
		}
	}
	return gl
}

describe('native mini game WebGL bridge', () => {
	beforeAll(async () => {
		globalThis.DiminaServiceBridge = {}
		window.DiminaRenderBridge = {}
		callback = (await import('@dimina/common')).callback
		runtime = (await import('../src/core/runtime.js')).default
		renderMessage = (await import('../src/core/message.js')).default
		serviceMessage = (await import('../../service/src/core/message.js')).default
		canvasApi = await import('../../service/src/api/core/ui/canvas/canvas-node.js')
		hostEnv = (await import('../../service/src/core/host-env.js')).default
		router = (await import('../../service/src/core/router.js')).default
		renderMessage.on('invokeAPI', message => runtime[message.name](message))
		serviceMessage.on('triggerCallback', message => callback.invoke(message.id, message.args))
	})

	beforeEach(() => {
		toRender = []
		toService = []
		contexts = []
		canvasApi.disposeCanvasNodes(bridgeId)
		vi.spyOn(console, 'log').mockImplementation(() => {})
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (type, attributes) {
			if (type !== 'webgl' && type !== 'webgl2') return null
			const gl = createHostGL(this, attributes, type)
			contexts.push(gl)
			return gl
		})
		runtime.canvasCapabilities = null
		router.setInitId(bridgeId)
		hostEnv.init({ systemInfo: { windowWidth: 390, windowHeight: 844 } })
		globalThis.DiminaServiceBridge.canvasSyncSupported = true
		globalThis.DiminaServiceBridge.publish = (_id, message) => toRender.push(clone(message))
		globalThis.DiminaServiceBridge.invoke = ({ type, body }) => {
			expect(type).toBe('canvasNodeSync')
			// The native main queue processes older publications before the sync
			// evaluateJavaScript request, but cannot re-enter the Service thread.
			drainRender()
			return clone(runtime.canvasNodeFlush({ ...clone(body), synchronous: true }))
		}
		window.DiminaRenderBridge.publish = json => toService.push(JSON.parse(json))
		window.DiminaRenderBridge.invoke = vi.fn()
	})

	afterEach(async () => {
		canvasApi.disposeCanvasNodes(bridgeId)
		await Promise.resolve()
		drainRender()
		drainService()
		hostEnv.reset()
		vi.restoreAllMocks()
	})

	it.each(['webgl', 'webgl2'])('draws through %s from the first default createCanvas before capability callbacks arrive', async (type) => {
		const canvas = canvasApi.createCanvas()
		expect(canvas.type).toBe('2d')
		const gl = canvas.getContext(type)
		const host = contexts.find(context => context.canvas.hasAttribute('data-dimina-game-canvas'))
		expect(host.canvas.isConnected).toBe(true)
		expect(canvas.webglCapabilities).toBeNull()
		expect(toService.some(message => message.type === 'canvasCapabilities')).toBe(true)
		expect(gl.getContextAttributes().preserveDrawingBuffer).toBe(false)
		const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic')
		expect(anisotropic.TEXTURE_MAX_ANISOTROPY_EXT).toBe(0x84FE)
		expect(gl.getExtension('EXT_texture_filter_anisotropic')).toBe(anisotropic)
		expect(gl.getExtension('advertised-unavailable')).toBeNull()
		gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, 2)
		if (type === 'webgl') {
			const halfFloat = gl.getExtension('OES_texture_half_float')
			expect(halfFloat.HALF_FLOAT_OES).toBe(0x8D61)
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, halfFloat.HALF_FLOAT_OES, null)
		}

		const shaders = [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER].map((shaderType) => {
			const shader = gl.createShader(shaderType)
			gl.shaderSource(shader, 'valid')
			gl.compileShader(shader)
			expect(gl.getShaderParameter(shader, gl.COMPILE_STATUS)).toBe(true)
			return shader
		})
		const invalidShader = gl.createShader(gl.FRAGMENT_SHADER)
		gl.shaderSource(invalidShader, 'invalid')
		gl.compileShader(invalidShader)
		expect(gl.getShaderParameter(invalidShader, gl.COMPILE_STATUS)).toBe(false)
		expect(gl.getShaderInfoLog(invalidShader)).toBe('shader compilation failed')

		const program = gl.createProgram()
		for (const shader of shaders) gl.attachShader(program, shader)
		gl.linkProgram(program)
		expect(gl.getProgramParameter(program, gl.LINK_STATUS)).toBe(true)
		expect(gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS)).toBe(1)
		expect(gl.getActiveUniform(program, 0)).toEqual({ name: 'color', size: 1, type: gl.FLOAT_VEC4 })
		const position = gl.getAttribLocation(program, 'position')
		expect(position).toBe(0)
		expect(gl.getAttribLocation(program, 'missing')).toBe(-1)
		expect(gl.getUniformLocation(program, 'missing')).toBeNull()
		const uniform = gl.getUniformLocation(program, 'color')
		gl.useProgram(program)
		gl.uniform4fv(uniform, new Float32Array([1, 0, 1, 1]))
		const buffer = gl.createBuffer()
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
		const vertices = new Float32Array([0, 0.5, -0.5, -0.5, 0.5, -0.5])
		gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
		gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
		gl.enableVertexAttribArray(position)
		gl.drawArrays(gl.TRIANGLES, 0, 3)
		const pixels = new Uint8Array(4)
		gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
		expect([...pixels]).toEqual([255, 0, 255, 255])
		expect(host.commands.find(command => command[0] === 'texParameterf'))
			.toEqual(['texParameterf', gl.TEXTURE_2D, 0x84FE, 2])
		if (type === 'webgl') expect(host.commands.find(command => command[0] === 'texImage2D')[8]).toBe(0x8D61)
		expect(host.commands.slice(-5)).toEqual([
			['bufferData', vertices, gl.STATIC_DRAW],
			['vertexAttribPointer', 0, 2, gl.FLOAT, false, 0, 0],
			['enableVertexAttribArray', 0],
			['drawArrays', expect.objectContaining({ linked: true }), expect.objectContaining({ vertices }), gl.TRIANGLES, 0, 3],
			['readPixels'],
		])
		expect(host.commands.find(command => command[0] === 'uniform4fv')[1])
			.toEqual({ program: expect.objectContaining({ linked: true }), name: 'color' })
		expect(document.querySelectorAll('[data-dimina-game-canvas]')).toHaveLength(1)
		await Promise.resolve()
		drainRender()
		drainService()
	})

	it.each([
		['webgl', true], ['webgl2', true], ['webgl', false], ['webgl2', false],
	])('preserves mixed-case ASTC enums for %s with synchronous queries %s', async (type, synchronous) => {
		globalThis.DiminaServiceBridge.canvasSyncSupported = synchronous
		if (!synchronous) {
			// The asynchronous path gets extension constants from capability snapshots.
			runtime.publishCanvasCapabilities(bridgeId)
			drainService()
		}
		const canvas = canvasApi.createCanvas()
		const gl = canvas.getContext(type)
		const extension = gl.getExtension('WEBGL_compressed_texture_astc')
		expect(extension.COMPRESSED_RGBA_ASTC_6x6_KHR).toBe(0x93B4)
		expect(extension.COMPRESSED_RGBA_ASTC_10x10_KHR).toBe(0x93BB)
		expect(extension.COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR).toBe(0x93DD)
		expect(typeof extension.getSupportedProfiles).toBe('function')
		expect(extension.constants).not.toHaveProperty('getSupportedProfiles')
		if (synchronous) expect(canvas.webglCapabilities).toBeNull()
		const capabilities = synchronous
			? toService.find(message => message.type === 'canvasCapabilities').body.capabilities
			: canvas.webglCapabilities
		expect(capabilities[type].extensions.WEBGL_compressed_texture_astc.constants).toEqual({
			COMPRESSED_RGBA_ASTC_6x6_KHR: 0x93B4,
			COMPRESSED_RGBA_ASTC_10x10_KHR: 0x93BB,
			COMPRESSED_SRGB8_ALPHA8_ASTC_12x12_KHR: 0x93DD,
		})
		const pixels = new Uint8Array(16)
		gl.compressedTexImage2D(gl.TEXTURE_2D, 0, extension.COMPRESSED_RGBA_ASTC_6x6_KHR, 6, 6, 0, pixels)
		await Promise.resolve()
		drainRender()
		drainService()
		const host = contexts.find(context => context.canvas.hasAttribute('data-dimina-game-canvas'))
		expect(host.commands.find(command => command[0] === 'compressedTexImage2D'))
			.toEqual(['compressedTexImage2D', gl.TEXTURE_2D, 0, 0x93B4, 6, 6, 0, pixels])
	})

	it('returns extension query values and advertises only host methods', () => {
		const gl = canvasApi.createCanvas().getContext('webgl')
		const astc = gl.getExtension('WEBGL_compressed_texture_astc')
		expect(astc.getSupportedProfiles()).toEqual(['ldr'])
		expect(astc.unsupportedMethod).toBeUndefined()
		expect(gl.texStorage2D).toBeUndefined()
		expect(typeof canvasApi.createOffscreenCanvas({ type: 'webgl2' }).getContext('webgl2').texStorage2D).toBe('function')
	})

	it('queries actual VAO bindings and preserves parameter types and rejected state changes', () => {
		const gl = canvasApi.createCanvas().getContext('webgl')
		const vao = gl.getExtension('OES_vertex_array_object')
		const first = vao.createVertexArrayOES()
		vao.bindVertexArrayOES(first)
		const buffer = gl.createBuffer()
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer)
		expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBe(buffer)
		vao.bindVertexArrayOES(vao.createVertexArrayOES())
		expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBeNull()
		vao.bindVertexArrayOES(first)
		expect(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)).toBe(buffer)
		gl.viewport(1, 2, 3, 4)
		expect(gl.getParameter(gl.VIEWPORT)).toEqual(new Int32Array([1, 2, 3, 4]))
		gl.viewport(0, 0, -1, 2)
		expect(gl.getParameter(gl.VIEWPORT)).toEqual(new Int32Array([1, 2, 3, 4]))
	})

	it('uses host extension resource creation and predicates', () => {
		const gl = canvasApi.createCanvas().getContext('webgl')
		const vao = gl.getExtension('OES_vertex_array_object')
		expect(() => vao.isVertexArrayOES(gl.createBuffer())).toThrow(TypeError)
		const vertexArray = vao.createVertexArrayOES()
		expect(vao.isVertexArrayOES(vertexArray)).toBe(true)
		vao.deleteVertexArrayOES(vertexArray)
		expect(vao.isVertexArrayOES(vertexArray)).toBe(false)
		contexts.find(context => context.canvas.hasAttribute('data-dimina-game-canvas')).failVertexArrayCreation = true
		expect(vao.createVertexArrayOES()).toBeNull()
	})

	it('returns clientWaitSync status from the host', () => {
		const gl = canvasApi.createCanvas().getContext('webgl2')
		const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
		expect(gl.clientWaitSync(sync, 0, 0)).toBe(gl.TIMEOUT_EXPIRED)
	})

	it.each([8, 2048])('writes getBufferSubData into a %i byte DataView without changing surrounding bytes', (length) => {
		const gl = canvasApi.createCanvas().getContext('webgl2')
		const bytes = new Uint8Array(length + 4).fill(7)
		const view = new DataView(bytes.buffer, 2, length)
		gl.getBufferSubData(gl.ARRAY_BUFFER, 0, view, 1, length - 2)
		expect([...bytes.slice(0, 3)]).toEqual([7, 7, 7])
		expect([...bytes.slice(3, length + 1)]).toEqual(Array.from({ length: length - 2 }, () => 42))
		expect([...bytes.slice(length + 1)]).toEqual([7, 7, 7])
	})

	it('forwards context loss and restoration and refreshes the context before handlers run', () => {
		const canvas = canvasApi.createCanvas()
		const gl = canvas.getContext('webgl')
		const host = contexts.find(context => context.canvas.hasAttribute('data-dimina-game-canvas'))
		const previousExtension = gl.getExtension('OES_vertex_array_object')
		const lost = vi.fn(event => {
			expect(event.target).toBe(canvas)
			expect(gl.isContextLost()).toBe(true)
			expect(gl.getContextAttributes()).toBeNull()
			expect(gl.getSupportedExtensions()).toBeNull()
			expect(gl.getExtension('OES_vertex_array_object')).toBeNull()
			event.preventDefault()
		})
		const restored = vi.fn(() => {
			expect(gl.isContextLost()).toBe(false)
			expect(gl.getExtension('OES_vertex_array_object')).not.toBe(previousExtension)
		})
		canvas.addEventListener('webglcontextlost', lost)
		canvas.onwebglcontextrestored = restored
		host.lost = true
		// Queries must see loss even before the asynchronous event arrives.
		expect(gl.isContextLost()).toBe(true)
		const event = new Event('webglcontextlost', { cancelable: true })
		host.canvas.dispatchEvent(event)
		expect(event.defaultPrevented).toBe(true)
		drainService()
		expect(lost).toHaveBeenCalledOnce()
		host.lost = false
		host.canvas.dispatchEvent(new Event('webglcontextrestored'))
		drainService()
		expect(restored).toHaveBeenCalledOnce()
		canvasApi.disposeCanvasNodes(bridgeId)
		drainRender()
		host.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }))
		drainService()
		expect(lost).toHaveBeenCalledOnce()
	})
})
