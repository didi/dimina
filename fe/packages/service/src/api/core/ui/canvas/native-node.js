import { callback, uuid } from '@dimina/common'
import router from '@/core/router'
import hostEnv from '@/core/host-env'
import {
	CanvasNode as CanvasNodeFallback,
	CANVAS_NODE_TYPE,
	hydrateCanvasNode as hydrateCanvasNodeFallback,
	hydrateSelectorQueryResult as hydrateSelectorQueryResultFallback,
	createOffscreenCanvas as createOffscreenCanvasFallback,
	createCanvas as createCanvasFallback,
	installMiniGameGlobals as installMiniGameGlobalsFallback,
	createMiniGameImage as createMiniGameImageFallback,
	resetMiniGameCanvas as resetMiniGameCanvasFallback,
} from './canvas-node'

const nativeGL = globalThis.__GLCanvas
const isGLAvailable = !!(nativeGL && nativeGL.available)
console.log('[native-node] init: __GLCanvas=' + (nativeGL ? JSON.stringify({ available: nativeGL.available }) : 'undefined') + ' isGLAvailable=' + isGLAvailable)

// Expose callback registry so C++ imageSetSrc handler can invoke onload/onerror
if (typeof globalThis.__dimina_callback_registry === 'undefined') {
	globalThis.__dimina_callback_registry = callback
}

export { CANVAS_NODE_TYPE }

// Registry of native canvas nodes by nodeId for canvasToTempFilePath etc.
const nativeCanvasNodes = new Map()

export function getNativeCanvasNode(nodeId) {
	return nativeCanvasNodes.get(nodeId) || null
}

export { isGLAvailable }

function getCurrentBridgeId() {
	const pageInfo = router.getPageInfo()
	return pageInfo?.bridgeId || pageInfo?.id || ''
}

// ─── Context ID counter ───
let ctxIdCounter = 0

// ─── GLContext2D: 2D drawing context backed by C bindings ───

class GLContext2D {
	constructor(nodeId) {
		this._nodeId = nodeId
		this._ctxId = 'ctx_' + (++ctxIdCounter)
		console.log('[GLContext2D] constructor: nodeId=' + nodeId + ' _bufferOp=' + typeof nativeGL._bufferOp + ' _flush=' + typeof nativeGL._flush + ' available=' + nativeGL.available)
		nativeGL._bufferOp(nodeId, { op: 'getContext', contextId: this._ctxId, contextType: '2d' })
	}

	// ─── Drawing methods ───

	fillRect(x, y, w, h) { this._call('fillRect', [x, y, w, h]) }
	strokeRect(x, y, w, h) { this._call('strokeRect', [x, y, w, h]) }
	clearRect(x, y, w, h) { this._call('clearRect', [x, y, w, h]) }
	beginPath() { this._call('beginPath', []) }
	moveTo(x, y) { this._call('moveTo', [x, y]) }
	lineTo(x, y) { this._call('lineTo', [x, y]) }
	closePath() { this._call('closePath', []) }
	arc(x, y, r, s, e, ccw) { this._call('arc', [x, y, r, s, e, ccw || false]) }
	arcTo(x1, y1, x2, y2, r) { this._call('arcTo', [x1, y1, x2, y2, r]) }
	bezierCurveTo(...a) { this._call('bezierCurveTo', a) }
	quadraticCurveTo(...a) { this._call('quadraticCurveTo', a) }
	ellipse(...a) { this._call('ellipse', a) }
	rect(x, y, w, h) { this._call('rect', [x, y, w, h]) }
	fill() { this._call('fill', []) }
	stroke() { this._call('stroke', []) }
	clip() { this._call('clip', []) }
	fillText(t, x, y, m) { this._call('fillText', m !== undefined ? [t, x, y, m] : [t, x, y]) }
	strokeText(t, x, y, m) { this._call('strokeText', m !== undefined ? [t, x, y, m] : [t, x, y]) }
	translate(x, y) { this._call('translate', [x, y]) }
	rotate(a) { this._call('rotate', [a]) }
	scale(x, y) { this._call('scale', [x, y]) }
	transform(...a) { this._call('transform', a) }
	setTransform(...a) { this._call('setTransform', a) }
	resetTransform() { this._call('resetTransform', []) }
	save() { this._call('save', []) }
	restore() { this._call('restore', []) }
	setLineDash(d) { this._call('setLineDash', [d]) }
	drawImage(img, ...a) { this._call('drawImage', [this._resolveImage(img), ...a]) }

	// ─── Methods that return resources ───

	createLinearGradient(x0, y0, x1, y1) { return this._callResult('createLinearGradient', [x0, y0, x1, y1]) }
	createRadialGradient(...a) { return this._callResult('createRadialGradient', a) }

	createPattern(image, repetition) {
		const resultId = 'res_' + (++ctxIdCounter)
		nativeGL._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method: 'createPattern',
			args: [this._resolveImage(image), repetition || 'repeat'], resultId,
		})

		return new NativePattern(resultId)
	}

	// ─── Synchronous methods ───

	getImageData(sx, sy, sw, sh) {
		const result = nativeGL._syncOp(this._nodeId, {
			name: 'canvasGetImageData', x: sx, y: sy, width: sw, height: sh,
		})
		return { data: new Uint8ClampedArray(result.data), width: sw, height: sh }
	}

	measureText(text) {
		const str = String(text ?? '')
		const result = nativeGL._syncOp(this._nodeId, {
			name: 'canvasMeasureText', text: str, font: this._font || '10px sans-serif',
		})
		if (result && typeof result.width === 'number') {
			return result
		}
		// Approximate measurement (same as fallback)
		return { width: str.length * 10 }
	}

	createImageData(sw, sh) {
		if (sw && typeof sw === 'object' && sw.data) {
			// createImageData(imageData) — clone dimensions
			return { data: new Uint8ClampedArray(sw.width * sw.height * 4), width: sw.width, height: sw.height }
		}
		return { data: new Uint8ClampedArray(sw * sh * 4), width: sw, height: sh }
	}

	putImageData(imageData, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH) {
		if (!imageData || !imageData.data) return
		const w = imageData.width
		const h = imageData.height
		if (dirtyX !== undefined) {
			nativeGL._putImageData(this._nodeId, imageData.data, w, h, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)
		} else {
			nativeGL._putImageData(this._nodeId, imageData.data, w, h, dx, dy)
		}
	}

	isPointInPath(x, y) {
		const result = nativeGL._syncOp(this._nodeId, {
			name: 'canvasIsPointInPath', contextId: this._ctxId, x, y,
		})
		return !!(result && result.value === true)
	}

	isPointInStroke(x, y) {
		const result = nativeGL._syncOp(this._nodeId, {
			name: 'canvasIsPointInStroke', contextId: this._ctxId, x, y,
		})
		return !!(result && result.value === true)
	}

	// ─── Internal ───

	_call(method, args) {
		nativeGL._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method, args,
		})

	}

	_callResult(method, args) {
		const resultId = 'res_' + (++ctxIdCounter)
		nativeGL._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method, args, resultId,
		})

		return new NativeGradient(this._nodeId, resultId)
	}

	_resolveImage(img) {
		if (img && img.__canvasImageId) return { __canvasResourceId: img.__canvasImageId }
		return img
	}
}

// ─── Property getter/setter for GLContext2D ───

const PROPS = [
	'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
	'font', 'textAlign', 'textBaseline', 'globalAlpha', 'globalCompositeOperation',
	'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
	'lineDashOffset', 'imageSmoothingEnabled', 'imageSmoothingQuality',
]

for (const prop of PROPS) {
	Object.defineProperty(GLContext2D.prototype, prop, {
		set(value) {
			this['_' + prop] = value
			nativeGL._bufferOp(this._nodeId, {
				op: 'contextSetProperty', contextId: this._ctxId, prop, value,
			})
	
		},
		get() { return this['_' + prop] },
		configurable: true,
	})
}

// ─── NativeGradient: proxy for gradient resources ───

class NativeGradient {
	constructor(nodeId, resourceId) {
		this._nodeId = nodeId
		this.__canvasResourceId = resourceId
	}

	addColorStop(offset, color) {
		nativeGL._bufferOp(this._nodeId, {
			op: 'resourceCall', resourceId: this.__canvasResourceId,
			method: 'addColorStop', args: [offset, color],
		})

	}
}

// ─── NativePattern: proxy for pattern resources ───

class NativePattern {
	constructor(resourceId) {
		this.__canvasResourceId = resourceId
	}
}

// ─── NativeImage: proxy for image loading ───

class NativeImage {
	constructor(nodeId) {
		this._nodeId = nodeId
		this.__canvasImageId = 'img_' + (++ctxIdCounter)
		this.__canvasResourceId = this.__canvasImageId
		this.width = 0
		this.height = 0
		this.onload = null
		this.onerror = null
	}

	set src(value) {
		this._src = value
		const onloadId = callback.store((event = {}) => {
			this.width = event.width || this.width
			this.height = event.height || this.height
			if (typeof this.onload === 'function') {
				this.onload(event)
			}
		})
		const onerrorId = callback.store((event = {}) => {
			if (typeof this.onerror === 'function') {
				this.onerror(event)
			}
		})
		nativeGL._bufferOp(this._nodeId, {
			op: 'imageSetSrc', imageId: this.__canvasImageId,
			src: value, onload: onloadId, onerror: onerrorId,
		})

	}

	get src() { return this._src }
}

// ─── GLCanvasNode: canvas node backed by C bindings ───

class GLCanvasNode {
	constructor({ nodeId, bridgeId, width = 300, height = 150, type = '2d', offscreen = false }) {
		this.__diminaCanvasNode = true
		this.nodeId = nodeId
		this.bridgeId = bridgeId
		this.type = type
		this._width = width
		this._height = height
		this._ctx = null
		this._offscreen = offscreen
		console.log('[GLCanvasNode] constructor: nodeId=' + nodeId + ' _createCanvas=' + typeof nativeGL._createCanvas + ' offscreen=' + offscreen)
		nativeGL._createCanvas(nodeId, width, height, offscreen)
		nativeCanvasNodes.set(nodeId, this)
	}

	get width() { return this._width }

	set width(v) {
		this._width = v
		nativeGL._bufferOp(this.nodeId, { op: 'setCanvasProperty', prop: 'width', value: v })
	}

	get height() { return this._height }

	set height(v) {
		this._height = v
		nativeGL._bufferOp(this.nodeId, { op: 'setCanvasProperty', prop: 'height', value: v })
	}

	getContext(type) {
		if (!this._ctx) this._ctx = new GLContext2D(this.nodeId)
		return this._ctx
	}

	createImage() { return new NativeImage(this.nodeId) }

	requestAnimationFrame(fn) { return setTimeout(() => fn(Date.now()), 16) }

	cancelAnimationFrame(id) { clearTimeout(id) }

	toDataURL(type, quality) {
		const result = nativeGL._syncOp(this.nodeId, {
			name: 'canvasToDataURLSync', type: type || 'image/png', quality,
		})
		return (result && result.dataUrl) || ''
	}

	destroy() {
		nativeCanvasNodes.delete(this.nodeId)
		nativeGL._destroyCanvas(this.nodeId)
		this._ctx = null
	}
}

// ─── Exports ───

export class CanvasNode {
	constructor(options) {
		if (isGLAvailable) {
			return new GLCanvasNode(options)
		}
		return new CanvasNodeFallback(options)
	}
}

export function hydrateCanvasNode(node, bridgeId = getCurrentBridgeId()) {
	if (!node || node.__diminaNodeType !== CANVAS_NODE_TYPE) {
		console.warn('[native-node] hydrateCanvasNode: skip, not a canvas node. node=', node ? JSON.stringify({ type: node.__diminaNodeType, nodeId: node.nodeId }) : 'null')
		return node
	}
	console.log('[native-node] hydrateCanvasNode: nodeId=' + node.nodeId + ' size=' + node.width + 'x' + node.height + ' type=' + node.type)
	return new CanvasNode({
		nodeId: node.nodeId,
		bridgeId,
		width: node.width,
		height: node.height,
		type: node.type,
	})
}

export function hydrateSelectorQueryResult(value, bridgeId = getCurrentBridgeId()) {
	console.log('[native-node] hydrateSelectorQueryResult: isGLAvailable=' + isGLAvailable + ' value=', value ? (Array.isArray(value) ? 'Array(' + value.length + ')' : typeof value) : 'null')
	if (!isGLAvailable) {
		return hydrateSelectorQueryResultFallback(value, bridgeId)
	}

	if (Array.isArray(value)) {
		return value.map(item => hydrateSelectorQueryResult(item, bridgeId))
	}

	if (!value || typeof value !== 'object') {
		return value
	}

	if (value.node) {
		console.log('[native-node] hydrateSelectorQueryResult: found node field, hydrating')
		return {
			...value,
			node: hydrateCanvasNode(value.node, bridgeId),
		}
	}

	return value
}

export function createOffscreenCanvas(options = {}) {
	if (!isGLAvailable) {
		return createOffscreenCanvasFallback(options)
	}

	const width = Number(options.width) || 300
	const height = Number(options.height) || 150
	const type = options.type || '2d'
	const nodeId = `offscreen_canvas_${uuid()}`
	const bridgeId = getCurrentBridgeId()

	return new GLCanvasNode({
		nodeId,
		bridgeId,
		width,
		height,
		type,
		offscreen: true,
	})
}

// ─── Mini-game canvas wrappers ───
// When __GLCanvas is available, mini-game canvas uses native-node (GLCanvasNode).
// Otherwise falls back to canvas-node (WebView render-side <canvas>).

let nativeScreenCanvas = null
let nativeImageCanvas = null

export function createCanvas(options = {}) {
	if (!isGLAvailable) {
		return createCanvasFallback(options)
	}

	if (nativeScreenCanvas) {
		return createOffscreenCanvas(options)
	}

	const systemInfo = hostEnv.getSystemInfo() || {}
	const width = Number(options.width) || systemInfo.windowWidth || 300
	const height = Number(options.height) || systemInfo.windowHeight || 150
	const type = options.type || '2d'
	const nodeId = `game_canvas_${uuid()}`
	const bridgeId = getCurrentBridgeId()

	nativeScreenCanvas = new GLCanvasNode({
		nodeId, bridgeId, width, height, type,
	})
	return nativeScreenCanvas
}

export function createMiniGameImage() {
	if (!isGLAvailable) {
		return createMiniGameImageFallback()
	}
	nativeImageCanvas ||= createOffscreenCanvas({ width: 1, height: 1, type: '2d' })
	return nativeImageCanvas.createImage()
}

export function installMiniGameGlobals() {
	if (!isGLAvailable) {
		return installMiniGameGlobalsFallback()
	}
	globalThis.GameGlobal = globalThis
	globalThis.global = globalThis
	globalThis.requestAnimationFrame = (cb) => {
		if (!nativeScreenCanvas) {
			throw new Error('requestAnimationFrame requires wx.createCanvas() first')
		}
		return nativeScreenCanvas.requestAnimationFrame(cb)
	}
	globalThis.cancelAnimationFrame = (id) => {
		nativeScreenCanvas?.cancelAnimationFrame(id)
	}
}

export function resetMiniGameCanvas() {
	resetMiniGameCanvasFallback()
	nativeScreenCanvas = null
	nativeImageCanvas = null
}
