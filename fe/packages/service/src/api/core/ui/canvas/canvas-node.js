import { callback, isFunction, uuid } from '@dimina/common'
import hostEnv from '@/core/host-env'
import message from '@/core/message'
import router from '@/core/router'

export const CANVAS_NODE_TYPE = 'dimina-canvas-node'

const CONTEXT_2D_TYPES = new Set(['2d'])
const WEBGL_CONTEXT_TYPES = new Set(['webgl', 'experimental-webgl', 'webgl2'])
const CANVAS_2D_RESOURCE_METHODS = new Set(['createLinearGradient', 'createPattern', 'createRadialGradient'])
const WEBGL_RESOURCE_METHOD_TYPES = new Map([
	['createBuffer', 'buffer'],
	['createFramebuffer', 'framebuffer'],
	['createProgram', 'program'],
	['createQuery', 'query'],
	['createRenderbuffer', 'renderbuffer'],
	['createSampler', 'sampler'],
	['createShader', 'shader'],
	['createTexture', 'texture'],
	['createTransformFeedback', 'transformFeedback'],
	['createVertexArray', 'vertexArray'],
	['fenceSync', 'sync'],
])
const WEBGL_LOCATION_METHOD_TYPES = new Map([
	['getAttribLocation', 'attribLocation'],
	['getUniformLocation', 'uniformLocation'],
])
const WEBGL_DELETE_METHOD_TYPES = new Map([
	['deleteBuffer', 'buffer'],
	['deleteFramebuffer', 'framebuffer'],
	['deleteProgram', 'program'],
	['deleteQuery', 'query'],
	['deleteRenderbuffer', 'renderbuffer'],
	['deleteSampler', 'sampler'],
	['deleteShader', 'shader'],
	['deleteSync', 'sync'],
	['deleteTexture', 'texture'],
	['deleteTransformFeedback', 'transformFeedback'],
	['deleteVertexArray', 'vertexArray'],
])
const WEBGL_IS_METHOD_TYPES = new Map([
	['isBuffer', 'buffer'],
	['isFramebuffer', 'framebuffer'],
	['isProgram', 'program'],
	['isQuery', 'query'],
	['isRenderbuffer', 'renderbuffer'],
	['isSampler', 'sampler'],
	['isShader', 'shader'],
	['isSync', 'sync'],
	['isTexture', 'texture'],
	['isTransformFeedback', 'transformFeedback'],
	['isVertexArray', 'vertexArray'],
])

const WEBGL_DEFAULT_CONTEXT_ATTRIBUTES = {
	alpha: true,
	depth: true,
	stencil: false,
	antialias: true,
	premultipliedAlpha: true,
	preserveDrawingBuffer: false,
	powerPreference: 'default',
	failIfMajorPerformanceCaveat: false,
	desynchronized: false,
}

const webglCapabilitiesByBridge = new Map()
let miniGameScreenCanvas = null
let miniGameImageCanvas = null

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

function normalizeContextType(type) {
	const contextType = String(type).toLowerCase()
	return contextType === 'experimental-webgl' ? 'webgl' : contextType
}

function setWebGLCapabilities(bridgeId, capabilities) {
	if (!bridgeId || !capabilities) {
		return
	}
	webglCapabilitiesByBridge.set(bridgeId, capabilities)
}

function getWebGLCapabilities(bridgeId) {
	return webglCapabilitiesByBridge.get(bridgeId) || null
}

function getContextCapabilities(capabilities, contextType) {
	if (!capabilities) {
		return null
	}
	return capabilities[normalizeContextType(contextType)] || null
}

function deserializeCanvasValue(value) {
	if (value === null || value === undefined) {
		return value
	}
	if (Array.isArray(value)) {
		return value.map(item => deserializeCanvasValue(item))
	}
	if (typeof value !== 'object') {
		return value
	}
	if (value.__canvasTypedArray) {
		if (value.__canvasTypedArray === 'DataView') {
			return new DataView(new Uint8Array(value.data || []).buffer)
		}
		const Ctor = globalThis[value.__canvasTypedArray]
		if (typeof Ctor === 'function') {
			return new Ctor(value.data || [])
		}
		return value.data || []
	}
	const result = {}
	for (const [key, item] of Object.entries(value)) {
		result[key] = deserializeCanvasValue(item)
	}
	return result
}

message.on('canvasCapabilities', ({ bridgeId, capabilities }) => {
	setWebGLCapabilities(bridgeId, capabilities)
})

message.on('resourceLoaded', ({ bridgeId, canvasCapabilities }) => {
	setWebGLCapabilities(bridgeId, canvasCapabilities)
})

let canvasResourceSerial = 1
let canvasRafSerial = 1

function getCurrentBridgeId() {
	const pageInfo = router.getPageInfo()
	return pageInfo?.bridgeId || pageInfo?.id || ''
}

function normalizeCanvasDimension(value, fallback) {
	if (value === undefined) {
		return fallback
	}
	const number = Number(value)
	return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
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

/**
 * Proxy for ImageData returned by getImageData/createImageData.
 * Provides .width, .height, .data properties like the Web ImageData interface.
 * Also carries __canvasResourceId so it can be serialized back for putImageData.
 */
class ImageDataProxy {
	constructor(canvas, resourceId, width, height) {
		this.__canvasResourceId = resourceId
		this.canvas = canvas
		this.width = width
		this.height = height
		this.data = new Uint8ClampedArray(width * height * 4)
	}
}

class CanvasResource {
	constructor(canvas, resourceId, resourceType = 'resource', metadata = {}) {
		this.__canvasResourceId = resourceId
		this.__canvasProxyValue = canvasResourceSerial++
		this.canvas = canvas
		this.resourceType = resourceType
		this.metadata = metadata
		this.deleted = false

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					const value = target[prop]
					return typeof value === 'function' ? value.bind(target) : value
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

	markDeleted() {
		this.deleted = true
	}

	updateMetadata(patch = {}) {
		Object.assign(this.metadata, patch)
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
        this.canvas = canvas;
        this.contextId = contextId;
        this.state = {
            fillStyle: "#000000",
            strokeStyle: "#000000",
            font: "10px sans-serif",
            globalAlpha: 1,
            lineWidth: 1,
        };

        return new Proxy(this, {
            get(target, prop) {
                if (prop in target) {
                    return target[prop];
                }
                if (prop in target.state) {
                    return target.state[prop];
                }
                if (typeof prop === "symbol") {
                    return undefined;
                }
                return (...args) => target.call(prop, args);
            },
            set(target, prop, value) {
                target.state[prop] = value;
                target.canvas.enqueueOperation({
                    op: "contextSetProperty",
                    contextId,
                    prop,
                    value: serializeCanvasArg(value),
                });
                return true;
            },
        });
    }

    async getImageData(x, y, w, h) {
        const result = await this.canvas.getImageData({
            contextId: this.contextId,
            x,
            y,
            width: w,
            height: h,
        });
        return result;
    }

    toDataURL(type, quality) {
        return this.canvas.toDataURL(type, quality);
    }

    call(method, args) {
        if (method === "measureText") {
            return { width: String(args[0] ?? "").length * 10 };
        }

        if (method === "createImageData") {
            const w = args[0];
            const h = args[1];
            return {
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
            };
        }

        const resultId = CANVAS_2D_RESOURCE_METHODS.has(method)
            ? makeResourceId()
            : undefined;
        this.canvas.enqueueOperation({
            op: "contextCall",
            contextId: this.contextId,
            method,
            args: serializeCanvasArgs(args),
            resultId,
        });

        if (resultId) {
            return new CanvasResource(this.canvas, resultId);
        }
    }
}

class WebGLExtensionProxy {
	constructor(context, name, extensionId, descriptor = {}) {
		this.context = context
		this.name = name
		this.__canvasResourceId = extensionId
		this.constants = descriptor.constants || {}

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					const value = target[prop]
					return typeof value === 'function' ? value.bind(target) : value
				}
				if (Object.prototype.hasOwnProperty.call(target.constants, prop)) {
					return target.constants[prop]
				}
				if (typeof prop === 'symbol') {
					return undefined
				}
				return (...args) => target.call(prop, args)
			},
		})
	}

	call(method, args) {
		let result
		let resultId
		if (method.startsWith('create')) {
			resultId = makeResourceId('webgl_extension_resource')
			result = new CanvasResource(this.context.canvas, resultId, `${this.name}:${method}`)
			this.context.resources.set(resultId, result)
		}
		else if (method.startsWith('delete') && args[0]?.markDeleted) {
			args[0].markDeleted()
		}
		else if (method.startsWith('is') && args[0] instanceof CanvasResource) {
			return !args[0].deleted
		}

		this.context.canvas.enqueueOperation({
			op: 'extensionCall',
			contextId: this.context.contextId,
			extensionId: this.__canvasResourceId,
			method,
			args: serializeCanvasArgs(args),
			resultId,
		})
		return result
	}
}

class WebGLRenderingContextProxy {
	constructor(canvas, contextId, contextType, attributes, capabilities) {
		this.canvas = canvas
		this.contextId = contextId
		this.contextType = contextType
		this.requestedAttributes = {
			...WEBGL_DEFAULT_CONTEXT_ATTRIBUTES,
			...(isPlainObject(attributes) ? attributes : {}),
		}
		this.capabilities = null
		this.resources = new Map()
		this.extensions = new Map()
		this.properties = new Map()
		this.state = new Map()
		this.enabledCapabilities = new Set()
		this.errors = []
		this.queryResults = new Map()
		this.contextLost = false
		this.creationFailed = false
		this.hasActualCapabilities = false
		this.initializeState()
		this.updateCapabilities(capabilities)

		return new Proxy(this, {
			get(target, prop) {
				if (prop in target) {
					const value = target[prop]
					return typeof value === 'function' ? value.bind(target) : value
				}
				if (target.properties.has(prop)) {
					return target.properties.get(prop)
				}
				if (Object.prototype.hasOwnProperty.call(target.capabilities?.constants || {}, prop)) {
					return target.capabilities.constants[prop]
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
			set(target, prop, value) {
				target.properties.set(prop, value)
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

	initializeState() {
		const { width, height } = this.canvas
		this.state.set(WEBGL_CONSTANTS.VIEWPORT, [0, 0, width, height])
		this.state.set(WEBGL_CONSTANTS.SCISSOR_BOX, [0, 0, width, height])
		this.state.set(WEBGL_CONSTANTS.COLOR_CLEAR_VALUE, new Float32Array([0, 0, 0, 0]))
		this.state.set(WEBGL_CONSTANTS.COLOR_WRITEMASK, [true, true, true, true])
		this.state.set(WEBGL_CONSTANTS.DEPTH_CLEAR_VALUE, 1)
		this.state.set(WEBGL_CONSTANTS.DEPTH_WRITEMASK, true)
		this.state.set(WEBGL_CONSTANTS.DEPTH_FUNC, WEBGL_CONSTANTS.LESS)
		this.state.set(WEBGL_CONSTANTS.STENCIL_CLEAR_VALUE, 0)
		this.state.set(WEBGL_CONSTANTS.LINE_WIDTH, 1)
		this.state.set(WEBGL_CONSTANTS.CULL_FACE_MODE, WEBGL_CONSTANTS.BACK)
		this.state.set(WEBGL_CONSTANTS.FRONT_FACE, WEBGL_CONSTANTS.CCW)
		this.state.set(WEBGL_CONSTANTS.ACTIVE_TEXTURE, WEBGL_CONSTANTS.TEXTURE0)
		this.state.set(WEBGL_CONSTANTS.PACK_ALIGNMENT, 4)
		this.state.set(WEBGL_CONSTANTS.UNPACK_ALIGNMENT, 4)
		this.state.set(WEBGL_CONSTANTS.CURRENT_PROGRAM, null)
		this.state.set(WEBGL_CONSTANTS.ARRAY_BUFFER_BINDING, null)
		this.state.set(WEBGL_CONSTANTS.ELEMENT_ARRAY_BUFFER_BINDING, null)
		this.state.set(WEBGL_CONSTANTS.TEXTURE_BINDING_2D, null)
		this.state.set(WEBGL_CONSTANTS.FRAMEBUFFER_BINDING, null)
		this.state.set(WEBGL_CONSTANTS.RENDERBUFFER_BINDING, null)
	}

	updateCapabilities(capabilities, actual = false) {
		if (!capabilities) {
			return
		}
		const next = deserializeCanvasValue(capabilities)
		const extensions = { ...(this.capabilities?.extensions || {}) }
		for (const [name, descriptor] of Object.entries(next.extensions || {})) {
			extensions[name] = {
				...(extensions[name] || {}),
				...descriptor,
				constants: {
					...(extensions[name]?.constants || {}),
					...(descriptor.constants || {}),
				},
			}
		}
		this.capabilities = {
			...(this.capabilities || {}),
			...next,
			constants: {
				...(this.capabilities?.constants || {}),
				...(next.constants || {}),
			},
			parameters: {
				...(this.capabilities?.parameters || {}),
				...(next.parameters || {}),
			},
			extensions,
			shaderPrecisionFormats: {
				...(this.capabilities?.shaderPrecisionFormats || {}),
				...(next.shaderPrecisionFormats || {}),
			},
		}
		this.hasActualCapabilities ||= actual
		if (typeof this.capabilities.contextLost === 'boolean') {
			this.contextLost = this.capabilities.contextLost
		}
	}

	applyFeedback(feedback = {}) {
		if (feedback.success === false) {
			this.creationFailed = true
			this.contextLost = true
			this.canvas.handleContextCreationFailure(this.contextId, this.contextType, feedback.statusMessage)
		}
		else if (feedback.capabilities) {
			this.updateCapabilities(feedback.capabilities, true)
		}
		if (typeof feedback.contextLost === 'boolean') {
			this.contextLost = feedback.contextLost
		}
		for (const error of feedback.errors || []) {
			this.queueError(error)
		}
		for (const update of feedback.resources || []) {
			this.resources.get(update.resourceId)?.updateMetadata(deserializeCanvasValue(update.metadata))
		}
		for (const query of feedback.queries || []) {
			this.queryResults.set(query.key, this.deserializeFeedbackValue(query.value))
		}
	}

	deserializeFeedbackValue(value) {
		if (value?.__canvasResourceId) {
			return this.resources.get(value.__canvasResourceId) || null
		}
		if (Array.isArray(value)) {
			return value.map(item => this.deserializeFeedbackValue(item))
		}
		if (value && typeof value === 'object' && !value.__canvasTypedArray) {
			const result = {}
			for (const [key, item] of Object.entries(value)) {
				result[key] = this.deserializeFeedbackValue(item)
			}
			return result
		}
		return deserializeCanvasValue(value)
	}

	queueError(error) {
		if (error && error !== WEBGL_CONSTANTS.NO_ERROR && !this.errors.includes(error)) {
			this.errors.push(error)
		}
	}

	queryKey(method, args) {
		return `${method}:${JSON.stringify(serializeCanvasArgs(args))}`
	}

	requestQuery(method, args, fallback = null) {
		const key = this.queryKey(method, args)
		this.canvas.enqueueOperation({
			op: 'contextQuery',
			contextId: this.contextId,
			method,
			args: serializeCanvasArgs(args),
			key,
		})
		return this.queryResults.has(key) ? this.queryResults.get(key) : fallback
	}

	createResource(method, args, resourceType) {
		const resultId = makeResourceId(`webgl_${resourceType}`)
		const metadata = {}
		if (resourceType === 'shader') {
			metadata.shaderType = args[0]
			metadata.source = ''
			metadata.compileStatus = false
			metadata.infoLog = ''
		}
		else if (resourceType === 'program') {
			metadata.attachedShaders = []
			metadata.linkStatus = false
			metadata.validateStatus = false
			metadata.infoLog = ''
		}
		const resource = new CanvasResource(this.canvas, resultId, resourceType, metadata)
		this.resources.set(resultId, resource)
		this.canvas.enqueueOperation({
			op: 'contextCall',
			contextId: this.contextId,
			method,
			args: serializeCanvasArgs(args),
			resultId,
		})
		return resource
	}

	call(method, args) {
		switch (method) {
			case 'getParameter':
				return this.getParameter(args[0])
			case 'getShaderParameter':
				return this.getShaderParameter(args[0], args[1])
			case 'getProgramParameter':
				return this.getProgramParameter(args[0], args[1])
			case 'getShaderInfoLog':
				return args[0]?.metadata?.infoLog || ''
			case 'getProgramInfoLog':
				return args[0]?.metadata?.infoLog || ''
			case 'getShaderSource':
				return args[0]?.metadata?.source || null
			case 'getAttachedShaders':
				return args[0]?.metadata?.attachedShaders?.slice() || []
			case 'getError': {
				const error = this.errors.shift()
				if (error) {
					return error
				}
				this.canvas.enqueueOperation({
					op: 'contextFeedback',
					contextId: this.contextId,
				})
				return WEBGL_CONSTANTS.NO_ERROR
			}
			case 'isContextLost':
				this.canvas.enqueueOperation({
					op: 'contextFeedback',
					contextId: this.contextId,
				})
				return this.contextLost
			case 'isEnabled':
				return this.enabledCapabilities.has(args[0])
			case 'checkFramebufferStatus':
				return this.requestQuery(method, args, WEBGL_CONSTANTS.FRAMEBUFFER_COMPLETE)
			case 'getContextAttributes':
				return {
					...(this.hasActualCapabilities && this.capabilities?.contextAttributes
						? this.capabilities.contextAttributes
						: this.requestedAttributes),
				}
			case 'getSupportedExtensions':
				return (this.capabilities?.supportedExtensions || []).slice()
			case 'getExtension':
				return this.getExtension(args[0])
			case 'getShaderPrecisionFormat':
				return this.getShaderPrecisionFormat(args[0], args[1])
			case 'getActiveAttrib':
			case 'getActiveUniform':
			case 'getBufferParameter':
			case 'getFramebufferAttachmentParameter':
			case 'getRenderbufferParameter':
			case 'getTexParameter':
			case 'getUniform':
			case 'getVertexAttrib':
			case 'getVertexAttribOffset':
				return this.requestQuery(method, args)
			default:
				break
		}

		const resourceType = WEBGL_RESOURCE_METHOD_TYPES.get(method) || WEBGL_LOCATION_METHOD_TYPES.get(method)
		if (resourceType) {
			return this.createResource(method, args, resourceType)
		}

		if (WEBGL_IS_METHOD_TYPES.has(method)) {
			const resource = args[0]
			return resource instanceof CanvasResource
				&& resource.resourceType === WEBGL_IS_METHOD_TYPES.get(method)
				&& !resource.deleted
		}

		if (WEBGL_DELETE_METHOD_TYPES.has(method) && args[0]?.markDeleted) {
			args[0].markDeleted()
		}

		this.updateState(method, args)
		const operation = {
			op: 'contextCall',
			contextId: this.contextId,
			method,
			args: serializeCanvasArgs(args),
		}
		if (method === 'compileShader') {
			args[0]?.updateMetadata({ compileStatus: true })
			operation.feedback = 'shader'
		}
		else if (method === 'linkProgram' || method === 'validateProgram') {
			args[0]?.updateMetadata(method === 'linkProgram' ? { linkStatus: true } : { validateStatus: true })
			operation.feedback = 'program'
		}
		else if (method === 'readPixels' && ArrayBuffer.isView(args[6])) {
			operation.typedArrayUpdateId = this.canvas.registerTypedArrayUpdate(args[6])
			operation.typedArrayArgIndex = 6
		}
		else if (method === 'getBufferSubData' && ArrayBuffer.isView(args[2])) {
			operation.typedArrayUpdateId = this.canvas.registerTypedArrayUpdate(args[2])
			operation.typedArrayArgIndex = 2
		}
		this.canvas.enqueueOperation(operation)
	}

	updateState(method, args) {
		switch (method) {
			case 'viewport':
				this.state.set(WEBGL_CONSTANTS.VIEWPORT, args.slice(0, 4))
				break
			case 'scissor':
				this.state.set(WEBGL_CONSTANTS.SCISSOR_BOX, args.slice(0, 4))
				break
			case 'clearColor':
				this.state.set(WEBGL_CONSTANTS.COLOR_CLEAR_VALUE, new Float32Array(args.slice(0, 4)))
				break
			case 'colorMask':
				this.state.set(WEBGL_CONSTANTS.COLOR_WRITEMASK, args.slice(0, 4).map(Boolean))
				break
			case 'clearDepth':
				this.state.set(WEBGL_CONSTANTS.DEPTH_CLEAR_VALUE, args[0])
				break
			case 'depthMask':
				this.state.set(WEBGL_CONSTANTS.DEPTH_WRITEMASK, Boolean(args[0]))
				break
			case 'depthFunc':
				this.state.set(WEBGL_CONSTANTS.DEPTH_FUNC, args[0])
				break
			case 'clearStencil':
				this.state.set(WEBGL_CONSTANTS.STENCIL_CLEAR_VALUE, args[0])
				break
			case 'lineWidth':
				this.state.set(WEBGL_CONSTANTS.LINE_WIDTH, args[0])
				break
			case 'cullFace':
				this.state.set(WEBGL_CONSTANTS.CULL_FACE_MODE, args[0])
				break
			case 'frontFace':
				this.state.set(WEBGL_CONSTANTS.FRONT_FACE, args[0])
				break
			case 'activeTexture':
				this.state.set(WEBGL_CONSTANTS.ACTIVE_TEXTURE, args[0])
				break
			case 'pixelStorei':
				this.state.set(args[0], args[1])
				break
			case 'enable':
				this.enabledCapabilities.add(args[0])
				break
			case 'disable':
				this.enabledCapabilities.delete(args[0])
				break
			case 'useProgram':
				this.state.set(WEBGL_CONSTANTS.CURRENT_PROGRAM, args[0] || null)
				break
			case 'bindBuffer':
				if (args[0] === WEBGL_CONSTANTS.ARRAY_BUFFER) {
					this.state.set(WEBGL_CONSTANTS.ARRAY_BUFFER_BINDING, args[1] || null)
				}
				else if (args[0] === WEBGL_CONSTANTS.ELEMENT_ARRAY_BUFFER) {
					this.state.set(WEBGL_CONSTANTS.ELEMENT_ARRAY_BUFFER_BINDING, args[1] || null)
				}
				break
			case 'bindTexture':
				if (args[0] === WEBGL_CONSTANTS.TEXTURE_2D) {
					this.state.set(WEBGL_CONSTANTS.TEXTURE_BINDING_2D, args[1] || null)
				}
				break
			case 'bindFramebuffer':
				this.state.set(WEBGL_CONSTANTS.FRAMEBUFFER_BINDING, args[1] || null)
				break
			case 'bindRenderbuffer':
				this.state.set(WEBGL_CONSTANTS.RENDERBUFFER_BINDING, args[1] || null)
				break
			case 'shaderSource':
				args[0]?.updateMetadata({ source: String(args[1] ?? '') })
				break
			case 'attachShader': {
				const attached = args[0]?.metadata?.attachedShaders
				if (attached && args[1] && !attached.includes(args[1])) {
					attached.push(args[1])
				}
				break
			}
			case 'detachShader': {
				const attached = args[0]?.metadata?.attachedShaders
				const index = attached?.indexOf(args[1]) ?? -1
				if (index >= 0) {
					attached.splice(index, 1)
				}
				break
			}
			default:
				break
		}
	}

	getParameter(pname) {
		if (this.state.has(pname)) {
			const value = this.state.get(pname)
			if (ArrayBuffer.isView(value)) {
				return value.slice()
			}
			return Array.isArray(value) ? value.slice() : value
		}
		const parameters = this.capabilities?.parameters || {}
		if (Object.prototype.hasOwnProperty.call(parameters, pname)) {
			return deserializeCanvasValue(parameters[pname])
		}
		return this.requestQuery('getParameter', [pname])
	}

	getShaderParameter(shader, pname) {
		if (!(shader instanceof CanvasResource) || shader.resourceType !== 'shader') {
			return null
		}
		switch (pname) {
			case WEBGL_CONSTANTS.DELETE_STATUS:
				return shader.deleted
			case WEBGL_CONSTANTS.SHADER_TYPE:
				return shader.metadata.shaderType
			case WEBGL_CONSTANTS.COMPILE_STATUS:
				return Boolean(shader.metadata.compileStatus)
			default:
				return this.requestQuery('getShaderParameter', [shader, pname])
		}
	}

	getProgramParameter(program, pname) {
		if (!(program instanceof CanvasResource) || program.resourceType !== 'program') {
			return null
		}
		switch (pname) {
			case WEBGL_CONSTANTS.DELETE_STATUS:
				return program.deleted
			case WEBGL_CONSTANTS.LINK_STATUS:
				return Boolean(program.metadata.linkStatus)
			case WEBGL_CONSTANTS.VALIDATE_STATUS:
				return Boolean(program.metadata.validateStatus)
			case WEBGL_CONSTANTS.ATTACHED_SHADERS:
				return program.metadata.attachedShaders.length
			default:
				return this.requestQuery('getProgramParameter', [program, pname])
		}
	}

	getShaderPrecisionFormat(shaderType, precisionType) {
		const key = `${shaderType}:${precisionType}`
		const value = this.capabilities?.shaderPrecisionFormats?.[key]
		return value ? { ...value } : this.requestQuery('getShaderPrecisionFormat', [shaderType, precisionType])
	}

	getExtension(requestedName) {
		const requested = String(requestedName || '')
		const supported = this.capabilities?.supportedExtensions || []
		const name = supported.find(item => item.toLowerCase() === requested.toLowerCase())
		if (!name) {
			return null
		}
		if (this.extensions.has(name)) {
			return this.extensions.get(name)
		}
		const extensionId = makeResourceId('webgl_extension')
		const descriptor = this.capabilities?.extensions?.[name] || {}
		const extension = new WebGLExtensionProxy(this, name, extensionId, descriptor)
		this.extensions.set(name, extension)
		this.canvas.enqueueOperation({
			op: 'getExtension',
			contextId: this.contextId,
			extensionId,
			name,
		})
		return extension
	}
}

export class CanvasNode {
	constructor({
		nodeId,
		bridgeId = getCurrentBridgeId(),
		width = 300,
		height = 150,
		type = '2d',
		offscreen = false,
		webglCapabilities,
	}) {
		this.__diminaCanvasNode = true
		this.nodeId = nodeId
		this.bridgeId = bridgeId
		this.type = type
		this.offscreen = offscreen
		this.webglCapabilities = webglCapabilities || getWebGLCapabilities(bridgeId)
		this.contexts = new Map()
		this.contextsById = new Map()
		this.activeContextType = null
		this.eventListeners = new Map()
		this.pendingTypedArrayUpdates = new Map()
		this.pendingOperations = []
		this.flushScheduled = false
		this._width = normalizeCanvasDimension(width, 300)
		this._height = normalizeCanvasDimension(height, 150)

		// Send initial dimensions to native so the bitmap context is created
		// before any drawing operations arrive.
		this.enqueueOperation({ op: 'setCanvasProperty', prop: 'width', value: this._width })
		this.enqueueOperation({ op: 'setCanvasProperty', prop: 'height', value: this._height })
	}

	get width() {
		return this._width
	}

	set width(value) {
		this._width = normalizeCanvasDimension(value, 300)
		this.enqueueOperation({
			op: 'setCanvasProperty',
			prop: 'width',
			value: this._width,
		})
	}

	get height() {
		return this._height
	}

	set height(value) {
		this._height = normalizeCanvasDimension(value, 150)
		this.enqueueOperation({
			op: 'setCanvasProperty',
			prop: 'height',
			value: this._height,
		})
	}

	getContext(type = '2d', attributes) {
		const requestedType = String(type).toLowerCase()
		const contextType = normalizeContextType(requestedType)
		const isWebGL = WEBGL_CONTEXT_TYPES.has(requestedType)
		if (!CONTEXT_2D_TYPES.has(contextType) && !isWebGL) {
			return null
		}

		if (this.activeContextType && this.activeContextType !== contextType) {
			return null
		}

		if (this.contexts.has(contextType)) {
			console.log('[canvas-node] getContext cache hit nodeId=' + this.nodeId + ' type=' + contextType)
			return this.contexts.get(contextType)
		}

		const capabilities = isWebGL
			? getContextCapabilities(this.webglCapabilities, contextType)
			: null
		if (isWebGL && capabilities?.supported === false) {
			return null
		}

		const contextId = makeResourceId('canvas_context')
		console.log('[canvas-node] getContext nodeId=' + this.nodeId + ' type=' + contextType + ' contextId=' + contextId)
		this.enqueueOperation({
			op: 'getContext',
			contextId,
			contextType: requestedType,
			attributes: serializeCanvasArg(attributes),
		})

		const context = isWebGL
			? new WebGLRenderingContextProxy(this, contextId, contextType, attributes, capabilities)
			: new CanvasRenderingContext2DProxy(this, contextId)
		this.activeContextType = contextType
		this.contexts.set(contextType, context)
		this.contextsById.set(contextId, context)
		return context
	}

	addEventListener(type, listener) {
		if (!isFunction(listener)) {
			return
		}
		if (!this.eventListeners.has(type)) {
			this.eventListeners.set(type, new Set())
		}
		this.eventListeners.get(type).add(listener)
	}

	removeEventListener(type, listener) {
		this.eventListeners.get(type)?.delete(listener)
	}

	dispatchEvent(event) {
		if (!event?.type) {
			return true
		}
		let defaultPrevented = false
		const normalizedEvent = {
			...event,
			target: this,
			currentTarget: this,
			preventDefault() {
				defaultPrevented = true
				this.defaultPrevented = true
			},
		}
		for (const listener of this.eventListeners.get(event.type) || []) {
			listener.call(this, normalizedEvent)
		}
		const propertyHandler = this[`on${event.type}`]
		if (isFunction(propertyHandler)) {
			propertyHandler.call(this, normalizedEvent)
		}
		return !defaultPrevented
	}

	notifyContextCreationError(statusMessage = 'WebGL context creation failed') {
		this.dispatchEvent({
			type: 'webglcontextcreationerror',
			statusMessage,
		})
	}

	handleContextCreationFailure(contextId, contextType, statusMessage) {
		const context = this.contextsById.get(contextId)
		if (this.contexts.get(contextType) === context) {
			this.contexts.delete(contextType)
			this.activeContextType = null
		}
		this.contextsById.delete(contextId)
		this.notifyContextCreationError(statusMessage)
	}

	registerTypedArrayUpdate(value) {
		const updateId = makeResourceId('canvas_typed_array_update')
		this.pendingTypedArrayUpdates.set(updateId, value)
		return updateId
	}

	applyFlushFeedback(feedback = {}) {
		for (const [contextId, contextFeedback] of Object.entries(feedback.contexts || {})) {
			this.contextsById.get(contextId)?.applyFeedback?.(contextFeedback)
		}
		for (const update of feedback.typedArrays || []) {
			const target = this.pendingTypedArrayUpdates.get(update.id)
			if (target && ArrayBuffer.isView(target)) {
				const data = deserializeCanvasValue(update.value)
				if (ArrayBuffer.isView(data)) {
					target.set(data.subarray(0, target.length))
				}
				else if (Array.isArray(data)) {
					target.set(data.slice(0, target.length))
				}
			}
			this.pendingTypedArrayUpdates.delete(update.id)
		}
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

	getImageData({ contextId, x, y, width, height }) {
		return new Promise((resolve, reject) => {
			const callbackId = callback.store((res) => {
                resolve(res);
			})
			this.enqueueOperation({
				op: 'getImageData',
				contextId,
				x,
				y,
				width,
				height,
				callback: callbackId,
			})
		})
	}

	toDataURL(type = 'image/png', quality) {
		return new Promise((resolve) => {
			const callbackId = callback.store((dataURL) => {
				resolve(dataURL)
			})
			this.enqueueOperation({
				op: 'toDataURL',
				mimeType: type,
				quality,
				callback: callbackId,
			})
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
			console.warn('[canvas-node] flush skipped: no pending operations for', this.nodeId)
			return
		}
		const operations = this.pendingOperations
		this.pendingOperations = []
		const needsFeedback = operations.some(operation => operation.op === 'getContext'
			|| operation.op === 'contextQuery'
			|| operation.op === 'contextFeedback'
			|| operation.feedback
			|| operation.typedArrayUpdateId)
		const feedback = needsFeedback
			? callback.store(result => this.applyFlushFeedback(result))
			: undefined
		sendCanvasMessage(this.bridgeId, 'canvasNodeFlush', {
			nodeId: this.nodeId,
			operations,
			feedback,
		})
	}
}

export function hydrateCanvasNode(node, bridgeId = getCurrentBridgeId()) {
	if (!node || node.__diminaNodeType !== CANVAS_NODE_TYPE) {
		return node
	}
	setWebGLCapabilities(bridgeId, node.webglCapabilities)
	return new CanvasNode({
		nodeId: node.nodeId,
		bridgeId,
		width: node.width,
		height: node.height,
		type: node.type,
		webglCapabilities: node.webglCapabilities,
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
	const width = normalizeCanvasDimension(options.width, 300)
	const height = normalizeCanvasDimension(options.height, 150)
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
		webglCapabilities: getWebGLCapabilities(bridgeId),
	})
}

/**
 * 创建小游戏画布。微信小游戏中第一次调用 wx.createCanvas() 得到上屏画布，
 * 后续调用得到离屏画布；入口 game.js 不依赖 Page/WXML。
 */
export function createCanvas(options = {}) {
	if (miniGameScreenCanvas) {
		return createOffscreenCanvas(options)
	}

	const systemInfo = hostEnv.getSystemInfo() || {}
	const width = normalizeCanvasDimension(options.width, systemInfo.windowWidth || 300)
	const height = normalizeCanvasDimension(options.height, systemInfo.windowHeight || 150)
	const type = options.type || '2d'
	const nodeId = makeResourceId('game_canvas')
	const bridgeId = getCurrentBridgeId()
	sendCanvasMessage(bridgeId, 'createGameCanvas', {
		nodeId,
		width,
		height,
		type,
	})
	miniGameScreenCanvas = new CanvasNode({
		nodeId,
		bridgeId,
		width,
		height,
		type,
		webglCapabilities: getWebGLCapabilities(bridgeId),
	})
	return miniGameScreenCanvas
}

export function createMiniGameImage() {
	// 图片资源存放在 Render 的全局 Canvas 资源表中，不需要占用小游戏的
	// 首个上屏 Canvas。这样业务即使先 wx.createImage()，第一次显式
	// wx.createCanvas() 仍严格得到上屏画布，符合微信小游戏语义。
	miniGameImageCanvas ||= createOffscreenCanvas({ width: 1, height: 1, type: '2d' })
	return miniGameImageCanvas.createImage()
}

export function installMiniGameGlobals() {
	globalThis.GameGlobal = globalThis
	globalThis.global = globalThis
	globalThis.requestAnimationFrame = (callback) => {
		if (!miniGameScreenCanvas) {
			throw new Error('requestAnimationFrame requires wx.createCanvas() first')
		}
		return miniGameScreenCanvas.requestAnimationFrame(callback)
	}
	globalThis.cancelAnimationFrame = (requestId) => {
		miniGameScreenCanvas?.cancelAnimationFrame(requestId)
	}
}

// 仅供 runtime 重建和单元测试清理同一个 service 上下文中的全局状态。
export function resetMiniGameCanvas() {
	miniGameScreenCanvas = null
	miniGameImageCanvas = null
}
