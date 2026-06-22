import { callback, isFunction, uuid } from '@dimina/common'
import message from '@/core/message'
import router from '@/core/router'

export const CANVAS_NODE_TYPE = 'dimina-canvas-node'

const CONTEXT_2D_TYPES = new Set(['2d'])
const WEBGL_CONTEXT_TYPES = new Set(['webgl', 'experimental-webgl', 'webgl2'])
const CANVAS_2D_RESOURCE_METHODS = new Set(['createLinearGradient', 'createPattern', 'createRadialGradient'])
const WEBGL_RESOURCE_METHODS = new Set([
	'createBuffer',
	'createFramebuffer',
	'createProgram',
	'createRenderbuffer',
	'createShader',
	'createTexture',
])
const WEBGL_LOCATION_METHODS = new Set(['getAttribLocation', 'getUniformLocation'])

const WEBGL_CONSTANTS = {
	DEPTH_BUFFER_BIT: 0x00000100,
	STENCIL_BUFFER_BIT: 0x00000400,
	COLOR_BUFFER_BIT: 0x00004000,
	FALSE: 0,
	TRUE: 1,
	POINTS: 0x0000,
	LINES: 0x0001,
	LINE_LOOP: 0x0002,
	LINE_STRIP: 0x0003,
	TRIANGLES: 0x0004,
	TRIANGLE_STRIP: 0x0005,
	TRIANGLE_FAN: 0x0006,
	ZERO: 0,
	ONE: 1,
	SRC_COLOR: 0x0300,
	ONE_MINUS_SRC_COLOR: 0x0301,
	SRC_ALPHA: 0x0302,
	ONE_MINUS_SRC_ALPHA: 0x0303,
	DST_ALPHA: 0x0304,
	ONE_MINUS_DST_ALPHA: 0x0305,
	DST_COLOR: 0x0306,
	ONE_MINUS_DST_COLOR: 0x0307,
	SRC_ALPHA_SATURATE: 0x0308,
	FUNC_ADD: 0x8006,
	BLEND_EQUATION: 0x8009,
	BLEND_EQUATION_RGB: 0x8009,
	BLEND_EQUATION_ALPHA: 0x883D,
	FUNC_SUBTRACT: 0x800A,
	FUNC_REVERSE_SUBTRACT: 0x800B,
	BLEND_DST_RGB: 0x80C8,
	BLEND_SRC_RGB: 0x80C9,
	BLEND_DST_ALPHA: 0x80CA,
	BLEND_SRC_ALPHA: 0x80CB,
	CONSTANT_COLOR: 0x8001,
	ONE_MINUS_CONSTANT_COLOR: 0x8002,
	CONSTANT_ALPHA: 0x8003,
	ONE_MINUS_CONSTANT_ALPHA: 0x8004,
	BLEND_COLOR: 0x8005,
	ARRAY_BUFFER: 0x8892,
	ELEMENT_ARRAY_BUFFER: 0x8893,
	ARRAY_BUFFER_BINDING: 0x8894,
	ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
	STREAM_DRAW: 0x88E0,
	STATIC_DRAW: 0x88E4,
	DYNAMIC_DRAW: 0x88E8,
	BUFFER_SIZE: 0x8764,
	BUFFER_USAGE: 0x8765,
	CURRENT_VERTEX_ATTRIB: 0x8626,
	FRONT: 0x0404,
	BACK: 0x0405,
	FRONT_AND_BACK: 0x0408,
	CULL_FACE: 0x0B44,
	BLEND: 0x0BE2,
	DITHER: 0x0BD0,
	STENCIL_TEST: 0x0B90,
	DEPTH_TEST: 0x0B71,
	SCISSOR_TEST: 0x0C11,
	POLYGON_OFFSET_FILL: 0x8037,
	SAMPLE_ALPHA_TO_COVERAGE: 0x809E,
	SAMPLE_COVERAGE: 0x80A0,
	NO_ERROR: 0,
	INVALID_ENUM: 0x0500,
	INVALID_VALUE: 0x0501,
	INVALID_OPERATION: 0x0502,
	OUT_OF_MEMORY: 0x0505,
	CW: 0x0900,
	CCW: 0x0901,
	LINE_WIDTH: 0x0B21,
	ALIASED_POINT_SIZE_RANGE: 0x846D,
	ALIASED_LINE_WIDTH_RANGE: 0x846E,
	CULL_FACE_MODE: 0x0B45,
	FRONT_FACE: 0x0B46,
	DEPTH_RANGE: 0x0B70,
	DEPTH_WRITEMASK: 0x0B72,
	DEPTH_CLEAR_VALUE: 0x0B73,
	DEPTH_FUNC: 0x0B74,
	STENCIL_CLEAR_VALUE: 0x0B91,
	STENCIL_FUNC: 0x0B92,
	STENCIL_FAIL: 0x0B94,
	STENCIL_PASS_DEPTH_FAIL: 0x0B95,
	STENCIL_PASS_DEPTH_PASS: 0x0B96,
	STENCIL_REF: 0x0B97,
	STENCIL_VALUE_MASK: 0x0B93,
	STENCIL_WRITEMASK: 0x0B98,
	STENCIL_BACK_FUNC: 0x8800,
	STENCIL_BACK_FAIL: 0x8801,
	STENCIL_BACK_PASS_DEPTH_FAIL: 0x8802,
	STENCIL_BACK_PASS_DEPTH_PASS: 0x8803,
	STENCIL_BACK_REF: 0x8CA3,
	STENCIL_BACK_VALUE_MASK: 0x8CA4,
	STENCIL_BACK_WRITEMASK: 0x8CA5,
	VIEWPORT: 0x0BA2,
	SCISSOR_BOX: 0x0C10,
	COLOR_CLEAR_VALUE: 0x0C22,
	COLOR_WRITEMASK: 0x0C23,
	UNPACK_ALIGNMENT: 0x0CF5,
	PACK_ALIGNMENT: 0x0D05,
	MAX_TEXTURE_SIZE: 0x0D33,
	MAX_VIEWPORT_DIMS: 0x0D3A,
	SUBPIXEL_BITS: 0x0D50,
	RED_BITS: 0x0D52,
	GREEN_BITS: 0x0D53,
	BLUE_BITS: 0x0D54,
	ALPHA_BITS: 0x0D55,
	DEPTH_BITS: 0x0D56,
	STENCIL_BITS: 0x0D57,
	POLYGON_OFFSET_UNITS: 0x2A00,
	POLYGON_OFFSET_FACTOR: 0x8038,
	TEXTURE_BINDING_2D: 0x8069,
	SAMPLE_BUFFERS: 0x80A8,
	SAMPLES: 0x80A9,
	SAMPLE_COVERAGE_VALUE: 0x80AA,
	SAMPLE_COVERAGE_INVERT: 0x80AB,
	COMPRESSED_TEXTURE_FORMATS: 0x86A3,
	DONT_CARE: 0x1100,
	FASTEST: 0x1101,
	NICEST: 0x1102,
	GENERATE_MIPMAP_HINT: 0x8192,
	BYTE: 0x1400,
	UNSIGNED_BYTE: 0x1401,
	SHORT: 0x1402,
	UNSIGNED_SHORT: 0x1403,
	INT: 0x1404,
	UNSIGNED_INT: 0x1405,
	FLOAT: 0x1406,
	DEPTH_COMPONENT: 0x1902,
	ALPHA: 0x1906,
	RGB: 0x1907,
	RGBA: 0x1908,
	LUMINANCE: 0x1909,
	LUMINANCE_ALPHA: 0x190A,
	UNSIGNED_SHORT_4_4_4_4: 0x8033,
	UNSIGNED_SHORT_5_5_5_1: 0x8034,
	UNSIGNED_SHORT_5_6_5: 0x8363,
	FRAGMENT_SHADER: 0x8B30,
	VERTEX_SHADER: 0x8B31,
	MAX_VERTEX_ATTRIBS: 0x8869,
	MAX_VERTEX_UNIFORM_VECTORS: 0x8DFB,
	MAX_VARYING_VECTORS: 0x8DFC,
	MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8B4D,
	MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8B4C,
	MAX_TEXTURE_IMAGE_UNITS: 0x8872,
	MAX_FRAGMENT_UNIFORM_VECTORS: 0x8DFD,
	SHADER_TYPE: 0x8B4F,
	DELETE_STATUS: 0x8B80,
	LINK_STATUS: 0x8B82,
	VALIDATE_STATUS: 0x8B83,
	ATTACHED_SHADERS: 0x8B85,
	ACTIVE_UNIFORMS: 0x8B86,
	ACTIVE_ATTRIBUTES: 0x8B89,
	SHADING_LANGUAGE_VERSION: 0x8B8C,
	CURRENT_PROGRAM: 0x8B8D,
	NEVER: 0x0200,
	LESS: 0x0201,
	EQUAL: 0x0202,
	LEQUAL: 0x0203,
	GREATER: 0x0204,
	NOTEQUAL: 0x0205,
	GEQUAL: 0x0206,
	ALWAYS: 0x0207,
	KEEP: 0x1E00,
	REPLACE: 0x1E01,
	INCR: 0x1E02,
	DECR: 0x1E03,
	INVERT: 0x150A,
	INCR_WRAP: 0x8507,
	DECR_WRAP: 0x8508,
	VENDOR: 0x1F00,
	RENDERER: 0x1F01,
	VERSION: 0x1F02,
	NEAREST: 0x2600,
	LINEAR: 0x2601,
	NEAREST_MIPMAP_NEAREST: 0x2700,
	LINEAR_MIPMAP_NEAREST: 0x2701,
	NEAREST_MIPMAP_LINEAR: 0x2702,
	LINEAR_MIPMAP_LINEAR: 0x2703,
	TEXTURE_MAG_FILTER: 0x2800,
	TEXTURE_MIN_FILTER: 0x2801,
	TEXTURE_WRAP_S: 0x2802,
	TEXTURE_WRAP_T: 0x2803,
	TEXTURE_2D: 0x0DE1,
	TEXTURE: 0x1702,
	TEXTURE_CUBE_MAP: 0x8513,
	TEXTURE_BINDING_CUBE_MAP: 0x8514,
	TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
	TEXTURE_CUBE_MAP_NEGATIVE_X: 0x8516,
	TEXTURE_CUBE_MAP_POSITIVE_Y: 0x8517,
	TEXTURE_CUBE_MAP_NEGATIVE_Y: 0x8518,
	TEXTURE_CUBE_MAP_POSITIVE_Z: 0x8519,
	TEXTURE_CUBE_MAP_NEGATIVE_Z: 0x851A,
	MAX_CUBE_MAP_TEXTURE_SIZE: 0x851C,
	TEXTURE0: 0x84C0,
	TEXTURE1: 0x84C1,
	TEXTURE2: 0x84C2,
	TEXTURE3: 0x84C3,
	TEXTURE4: 0x84C4,
	TEXTURE5: 0x84C5,
	TEXTURE6: 0x84C6,
	TEXTURE7: 0x84C7,
	TEXTURE8: 0x84C8,
	TEXTURE9: 0x84C9,
	TEXTURE10: 0x84CA,
	TEXTURE11: 0x84CB,
	TEXTURE12: 0x84CC,
	TEXTURE13: 0x84CD,
	TEXTURE14: 0x84CE,
	TEXTURE15: 0x84CF,
	TEXTURE16: 0x84D0,
	TEXTURE17: 0x84D1,
	TEXTURE18: 0x84D2,
	TEXTURE19: 0x84D3,
	TEXTURE20: 0x84D4,
	TEXTURE21: 0x84D5,
	TEXTURE22: 0x84D6,
	TEXTURE23: 0x84D7,
	TEXTURE24: 0x84D8,
	TEXTURE25: 0x84D9,
	TEXTURE26: 0x84DA,
	TEXTURE27: 0x84DB,
	TEXTURE28: 0x84DC,
	TEXTURE29: 0x84DD,
	TEXTURE30: 0x84DE,
	TEXTURE31: 0x84DF,
	ACTIVE_TEXTURE: 0x84E0,
	REPEAT: 0x2901,
	CLAMP_TO_EDGE: 0x812F,
	MIRRORED_REPEAT: 0x8370,
	FLOAT_VEC2: 0x8B50,
	FLOAT_VEC3: 0x8B51,
	FLOAT_VEC4: 0x8B52,
	INT_VEC2: 0x8B53,
	INT_VEC3: 0x8B54,
	INT_VEC4: 0x8B55,
	BOOL: 0x8B56,
	BOOL_VEC2: 0x8B57,
	BOOL_VEC3: 0x8B58,
	BOOL_VEC4: 0x8B59,
	FLOAT_MAT2: 0x8B5A,
	FLOAT_MAT3: 0x8B5B,
	FLOAT_MAT4: 0x8B5C,
	SAMPLER_2D: 0x8B5E,
	SAMPLER_CUBE: 0x8B60,
	LOW_FLOAT: 0x8DF0,
	MEDIUM_FLOAT: 0x8DF1,
	HIGH_FLOAT: 0x8DF2,
	LOW_INT: 0x8DF3,
	MEDIUM_INT: 0x8DF4,
	HIGH_INT: 0x8DF5,
	FRAMEBUFFER: 0x8D40,
	RENDERBUFFER: 0x8D41,
	RGBA4: 0x8056,
	RGB5_A1: 0x8057,
	RGB565: 0x8D62,
	DEPTH_COMPONENT16: 0x81A5,
	STENCIL_INDEX8: 0x8D48,
	DEPTH_STENCIL: 0x84F9,
	RENDERBUFFER_WIDTH: 0x8D42,
	RENDERBUFFER_HEIGHT: 0x8D43,
	RENDERBUFFER_INTERNAL_FORMAT: 0x8D44,
	RENDERBUFFER_RED_SIZE: 0x8D50,
	RENDERBUFFER_GREEN_SIZE: 0x8D51,
	RENDERBUFFER_BLUE_SIZE: 0x8D52,
	RENDERBUFFER_ALPHA_SIZE: 0x8D53,
	RENDERBUFFER_DEPTH_SIZE: 0x8D54,
	RENDERBUFFER_STENCIL_SIZE: 0x8D55,
	FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE: 0x8CD0,
	FRAMEBUFFER_ATTACHMENT_OBJECT_NAME: 0x8CD1,
	FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL: 0x8CD2,
	FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE: 0x8CD3,
	COLOR_ATTACHMENT0: 0x8CE0,
	DEPTH_ATTACHMENT: 0x8D00,
	STENCIL_ATTACHMENT: 0x8D20,
	DEPTH_STENCIL_ATTACHMENT: 0x821A,
	NONE: 0,
	FRAMEBUFFER_COMPLETE: 0x8CD5,
	FRAMEBUFFER_INCOMPLETE_ATTACHMENT: 0x8CD6,
	FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT: 0x8CD7,
	FRAMEBUFFER_INCOMPLETE_DIMENSIONS: 0x8CD9,
	FRAMEBUFFER_UNSUPPORTED: 0x8CDD,
	FRAMEBUFFER_BINDING: 0x8CA6,
	RENDERBUFFER_BINDING: 0x8CA7,
	MAX_RENDERBUFFER_SIZE: 0x84E8,
	INVALID_FRAMEBUFFER_OPERATION: 0x0506,
	UNPACK_FLIP_Y_WEBGL: 0x9240,
	UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
	CONTEXT_LOST_WEBGL: 0x9242,
	UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
	BROWSER_DEFAULT_WEBGL: 0x9244,
	COMPILE_STATUS: 0x8B81,
}

let canvasResourceSerial = 1
let canvasRafSerial = 1

function getCurrentBridgeId() {
	const pageInfo = router.getPageInfo()
	return pageInfo?.bridgeId || pageInfo?.id || ''
}

function sendCanvasMessage(bridgeId, name, params) {
	message.send({
		type: 'invokeAPI',
		target: 'render',
		body: {
			bridgeId,
			name,
			params,
		},
	})
}

function scheduleMicrotask(fn) {
	Promise.resolve().then(fn)
}

function isPlainObject(value) {
	return Object.prototype.toString.call(value) === '[object Object]'
}

function serializeTypedArray(value) {
	if (typeof ArrayBuffer === 'undefined' || !ArrayBuffer.isView(value)) {
		return null
	}
	if (value instanceof DataView) {
		return {
			__canvasTypedArray: 'DataView',
			data: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
		}
	}
	return {
		__canvasTypedArray: value.constructor.name,
		data: Array.from(value),
	}
}

function serializeCanvasArg(value) {
	if (value === null || value === undefined) {
		return value
	}

	if (value.__canvasResourceId) {
		return { __canvasResourceId: value.__canvasResourceId }
	}

	if (value.__diminaCanvasNode) {
		return { __canvasNodeId: value.nodeId }
	}

	const typedArray = serializeTypedArray(value)
	if (typedArray) {
		return typedArray
	}

	if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
		return {
			__canvasArrayBuffer: true,
			data: Array.from(new Uint8Array(value)),
		}
	}

	if (Array.isArray(value)) {
		return value.map(item => serializeCanvasArg(item))
	}

	if (isPlainObject(value)) {
		const result = {}
		for (const [key, item] of Object.entries(value)) {
			result[key] = serializeCanvasArg(item)
		}
		return result
	}

	return value
}

function serializeCanvasArgs(args) {
	return Array.from(args).map(arg => serializeCanvasArg(arg))
}

function makeResourceId(prefix = 'canvas_resource') {
	return `${prefix}_${uuid()}`
}

class CanvasResource {
	constructor(canvas, resourceId) {
		this.__canvasResourceId = resourceId
		this.__canvasProxyValue = canvasResourceSerial++
		this.canvas = canvas

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					return target[prop]
				}
				if (typeof prop === 'symbol') {
					return undefined
				}
				return (...args) => {
					target.canvas.enqueueOperation({
						op: 'resourceCall',
						resourceId,
						method: prop,
						args: serializeCanvasArgs(args),
					})
				}
			},
		})
	}

	valueOf() {
		return this.__canvasProxyValue
	}

	toString() {
		return String(this.__canvasProxyValue)
	}
}

class CanvasImage {
	constructor(canvas, imageId) {
		this.__canvasResourceId = imageId
		this.canvas = canvas
		this.imageId = imageId
		this.onload = null
		this.onerror = null
		this.width = 0
		this.height = 0
		this._src = ''

		this.canvas.enqueueOperation({
			op: 'createImage',
			imageId,
		})
	}

	get src() {
		return this._src
	}

	set src(value) {
		this._src = value
		const onload = callback.store((event = {}) => {
			this.width = event.width || this.width
			this.height = event.height || this.height
			if (isFunction(this.onload)) {
				this.onload(event)
			}
		})
		const onerror = callback.store((event = {}) => {
			if (isFunction(this.onerror)) {
				this.onerror(event)
			}
		})

		this.canvas.enqueueOperation({
			op: 'imageSetSrc',
			imageId: this.imageId,
			src: value,
			onload,
			onerror,
		})
	}
}

class CanvasRenderingContext2DProxy {
	constructor(canvas, contextId) {
		this.canvas = canvas
		this.contextId = contextId
		this.state = {
			fillStyle: '#000000',
			strokeStyle: '#000000',
			font: '10px sans-serif',
			globalAlpha: 1,
			lineWidth: 1,
		}

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					return target[prop]
				}
				if (prop in target.state) {
					return target.state[prop]
				}
				if (typeof prop === 'symbol') {
					return undefined
				}
				return (...args) => target.call(prop, args)
			},
			set(target, prop, value) {
				target.state[prop] = value
				target.canvas.enqueueOperation({
					op: 'contextSetProperty',
					contextId,
					prop,
					value: serializeCanvasArg(value),
				})
				return true
			},
		})
	}

	call(method, args) {
		if (method === 'measureText') {
			return { width: String(args[0] ?? '').length * 10 }
		}

		const resultId = CANVAS_2D_RESOURCE_METHODS.has(method) ? makeResourceId() : undefined
		this.canvas.enqueueOperation({
			op: 'contextCall',
			contextId: this.contextId,
			method,
			args: serializeCanvasArgs(args),
			resultId,
		})

		if (resultId) {
			return new CanvasResource(this.canvas, resultId)
		}
	}
}

class WebGLRenderingContextProxy {
	constructor(canvas, contextId, contextType) {
		this.canvas = canvas
		this.contextId = contextId
		this.contextType = contextType

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					return target[prop]
				}
				if (Object.prototype.hasOwnProperty.call(WEBGL_CONSTANTS, prop)) {
					return WEBGL_CONSTANTS[prop]
				}
				if (prop === 'drawingBufferWidth') {
					return target.canvas.width
				}
				if (prop === 'drawingBufferHeight') {
					return target.canvas.height
				}
				if (typeof prop === 'symbol') {
					return undefined
				}
				return (...args) => target.call(prop, args)
			},
		})
	}

	call(method, args) {
		switch (method) {
			case 'getParameter':
				return this.getParameter(args[0])
			case 'getShaderParameter':
			case 'getProgramParameter':
				return true
			case 'getShaderInfoLog':
			case 'getProgramInfoLog':
				return ''
			case 'getError':
				return WEBGL_CONSTANTS.NO_ERROR
			case 'isContextLost':
				return false
			case 'checkFramebufferStatus':
				return WEBGL_CONSTANTS.FRAMEBUFFER_COMPLETE
			case 'getContextAttributes':
				return {}
			case 'getSupportedExtensions':
				return []
			case 'getExtension':
				return null
			default:
				break
		}

		const resultId = (WEBGL_RESOURCE_METHODS.has(method) || WEBGL_LOCATION_METHODS.has(method))
			? makeResourceId('webgl_resource')
			: undefined

		this.canvas.enqueueOperation({
			op: 'contextCall',
			contextId: this.contextId,
			method,
			args: serializeCanvasArgs(args),
			resultId,
		})

		if (resultId) {
			return new CanvasResource(this.canvas, resultId)
		}
	}

	getParameter(pname) {
		const { width, height } = this.canvas
		switch (pname) {
			case WEBGL_CONSTANTS.VERSION:
				return 'WebGL 1.0'
			case WEBGL_CONSTANTS.SHADING_LANGUAGE_VERSION:
				return 'WebGL GLSL ES 1.0'
			case WEBGL_CONSTANTS.VENDOR:
				return 'Dimina'
			case WEBGL_CONSTANTS.RENDERER:
				return 'Dimina WebGL Proxy'
			case WEBGL_CONSTANTS.VIEWPORT:
				return [0, 0, width, height]
			case WEBGL_CONSTANTS.MAX_VIEWPORT_DIMS:
				return [width || 4096, height || 4096]
			case WEBGL_CONSTANTS.ALIASED_POINT_SIZE_RANGE:
				return [1, 64]
			case WEBGL_CONSTANTS.ALIASED_LINE_WIDTH_RANGE:
				return [1, 1]
			case WEBGL_CONSTANTS.COLOR_CLEAR_VALUE:
				return [0, 0, 0, 0]
			case WEBGL_CONSTANTS.COLOR_WRITEMASK:
			case WEBGL_CONSTANTS.DEPTH_WRITEMASK:
				return true
			case WEBGL_CONSTANTS.COMPRESSED_TEXTURE_FORMATS:
				return []
			case WEBGL_CONSTANTS.MAX_TEXTURE_SIZE:
			case WEBGL_CONSTANTS.MAX_CUBE_MAP_TEXTURE_SIZE:
			case WEBGL_CONSTANTS.MAX_RENDERBUFFER_SIZE:
				return 4096
			case WEBGL_CONSTANTS.MAX_VERTEX_ATTRIBS:
				return 16
			case WEBGL_CONSTANTS.MAX_TEXTURE_IMAGE_UNITS:
			case WEBGL_CONSTANTS.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
			case WEBGL_CONSTANTS.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
				return 8
			case WEBGL_CONSTANTS.MAX_VERTEX_UNIFORM_VECTORS:
			case WEBGL_CONSTANTS.MAX_FRAGMENT_UNIFORM_VECTORS:
			case WEBGL_CONSTANTS.MAX_VARYING_VECTORS:
				return 128
			default:
				return 0
		}
	}
}

export class CanvasNode {
	constructor({ nodeId, bridgeId = getCurrentBridgeId(), width = 300, height = 150, type = '2d', offscreen = false }) {
		this.__diminaCanvasNode = true
		this.nodeId = nodeId
		this.bridgeId = bridgeId
		this.type = type
		this.offscreen = offscreen
		this.contexts = new Map()
		this.pendingOperations = []
		this.flushScheduled = false
		this._width = width
		this._height = height
	}

	get width() {
		return this._width
	}

	set width(value) {
		this._width = value
		this.enqueueOperation({
			op: 'setCanvasProperty',
			prop: 'width',
			value,
		})
	}

	get height() {
		return this._height
	}

	set height(value) {
		this._height = value
		this.enqueueOperation({
			op: 'setCanvasProperty',
			prop: 'height',
			value,
		})
	}

	getContext(type = '2d', attributes) {
		const contextType = String(type).toLowerCase()
		if (!CONTEXT_2D_TYPES.has(contextType) && !WEBGL_CONTEXT_TYPES.has(contextType)) {
			return null
		}

		if (this.contexts.has(contextType)) {
			return this.contexts.get(contextType)
		}

		const contextId = makeResourceId('canvas_context')
		this.enqueueOperation({
			op: 'getContext',
			contextId,
			contextType,
			attributes: serializeCanvasArg(attributes),
		})

		const context = WEBGL_CONTEXT_TYPES.has(contextType)
			? new WebGLRenderingContextProxy(this, contextId, contextType)
			: new CanvasRenderingContext2DProxy(this, contextId)
		this.contexts.set(contextType, context)
		return context
	}

	createImage() {
		return new CanvasImage(this, makeResourceId('canvas_image'))
	}

	requestAnimationFrame(fn) {
		const requestId = canvasRafSerial++
		const callbackId = callback.store((timestamp) => {
			if (isFunction(fn)) {
				fn(timestamp)
			}
		})
		sendCanvasMessage(this.bridgeId, 'canvasNodeRequestAnimationFrame', {
			nodeId: this.nodeId,
			requestId,
			callback: callbackId,
		})
		return requestId
	}

	cancelAnimationFrame(requestId) {
		sendCanvasMessage(this.bridgeId, 'canvasNodeCancelAnimationFrame', {
			nodeId: this.nodeId,
			requestId,
		})
	}

	enqueueOperation(operation) {
		this.pendingOperations.push(operation)
		if (this.flushScheduled) {
			return
		}
		this.flushScheduled = true
		scheduleMicrotask(() => this.flushOperations())
	}

	flushOperations() {
		this.flushScheduled = false
		if (this.pendingOperations.length === 0) {
			return
		}
		const operations = this.pendingOperations
		this.pendingOperations = []
		sendCanvasMessage(this.bridgeId, 'canvasNodeFlush', {
			nodeId: this.nodeId,
			operations,
		})
	}
}

export function hydrateCanvasNode(node, bridgeId = getCurrentBridgeId()) {
	if (!node || node.__diminaNodeType !== CANVAS_NODE_TYPE) {
		return node
	}
	return new CanvasNode({
		nodeId: node.nodeId,
		bridgeId,
		width: node.width,
		height: node.height,
		type: node.type,
	})
}

export function hydrateSelectorQueryResult(value, bridgeId = getCurrentBridgeId()) {
	if (Array.isArray(value)) {
		return value.map(item => hydrateSelectorQueryResult(item, bridgeId))
	}

	if (!value || typeof value !== 'object') {
		return value
	}

	if (value.node) {
		return {
			...value,
			node: hydrateCanvasNode(value.node, bridgeId),
		}
	}

	return value
}

export function createOffscreenCanvas(options = {}) {
	const width = Number(options.width) || 300
	const height = Number(options.height) || 150
	const type = options.type || '2d'
	const nodeId = makeResourceId('offscreen_canvas')
	const bridgeId = getCurrentBridgeId()
	sendCanvasMessage(bridgeId, 'createOffscreenCanvas', {
		nodeId,
		width,
		height,
		type,
	})
	return new CanvasNode({
		nodeId,
		bridgeId,
		width,
		height,
		type,
		offscreen: true,
	})
}
