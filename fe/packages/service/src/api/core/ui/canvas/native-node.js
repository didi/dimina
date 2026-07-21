import { callback, uuid } from '@dimina/common'
import router from '@/core/router'
import {
	CanvasNode as CanvasNodeFallback,
	CANVAS_NODE_TYPE,
	hydrateCanvasNode as hydrateCanvasNodeFallback,
	hydrateSelectorQueryResult as hydrateSelectorQueryResultFallback,
	createOffscreenCanvas as createOffscreenCanvasFallback,
} from './canvas-node'

const skia = globalThis.__SkiaCanvas
const isSkiaAvailable = !!(skia && skia.available)
console.log('[native-node] init: __SkiaCanvas=' + (skia ? JSON.stringify({ available: skia.available }) : 'undefined') + ' isSkiaAvailable=' + isSkiaAvailable)

export { CANVAS_NODE_TYPE }

function getCurrentBridgeId() {
	const pageInfo = router.getPageInfo()
	return pageInfo?.bridgeId || pageInfo?.id || ''
}

// ─── Context ID counter ───
let ctxIdCounter = 0

// ─── Flush scheduling via Promise microtask ───
const pendingFlushNodes = new Set()
let flushScheduled = false

function scheduleFlush(nodeId) {
	pendingFlushNodes.add(nodeId)
	if (!flushScheduled) {
		flushScheduled = true
		Promise.resolve().then(flushAll)
	}
}

function flushAll() {
	flushScheduled = false
	const nodes = Array.from(pendingFlushNodes)
	pendingFlushNodes.clear()
	for (let i = 0; i < nodes.length; i++) {
		try {
			skia._flush(nodes[i])
		} catch (e) {
			console.error('[native-node] _flush error for nodeId=' + nodes[i] + ': ' + e)
		}
	}
}

// ─── SkiaContext2D: 2D drawing context backed by C bindings ───

class SkiaContext2D {
	constructor(nodeId) {
		this._nodeId = nodeId
		this._ctxId = 'ctx_' + (++ctxIdCounter)
		console.log('[SkiaContext2D] constructor: nodeId=' + nodeId + ' _bufferOp=' + typeof skia._bufferOp + ' _flush=' + typeof skia._flush + ' available=' + skia.available)
		skia._bufferOp(nodeId, { op: 'getContext', contextId: this._ctxId, contextType: '2d' })
		scheduleFlush(nodeId)
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
		skia._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method: 'createPattern',
			args: [this._resolveImage(image), repetition || 'repeat'], resultId,
		})
		scheduleFlush(this._nodeId)
		return new NativePattern(resultId)
	}

	// ─── Synchronous methods ───

	getImageData(sx, sy, sw, sh) {
		const result = skia._syncOp(this._nodeId, {
			name: 'canvasGetImageData', x: sx, y: sy, width: sw, height: sh,
		})
		return { data: new Uint8ClampedArray(result.data), width: sw, height: sh }
	}

	measureText(text) {
		const str = String(text ?? '')
		const result = skia._syncOp(this._nodeId, {
			name: 'canvasMeasureText', text: str, font: this._font || '10px sans-serif',
		})
		if (result && typeof result.width === 'number') {
			return result
		}
		// Approximate measurement (same as fallback)
		return { width: str.length * 10 }
	}

	isPointInPath(x, y) {
		const result = skia._syncOp(this._nodeId, {
			name: 'canvasIsPointInPath', contextId: this._ctxId, x, y,
		})
		return !!(result && result.value === true)
	}

	isPointInStroke(x, y) {
		const result = skia._syncOp(this._nodeId, {
			name: 'canvasIsPointInStroke', contextId: this._ctxId, x, y,
		})
		return !!(result && result.value === true)
	}

	// ─── Internal ───

	_call(method, args) {
		skia._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method, args,
		})
		scheduleFlush(this._nodeId)
	}

	_callResult(method, args) {
		const resultId = 'res_' + (++ctxIdCounter)
		skia._bufferOp(this._nodeId, {
			op: 'contextCall', contextId: this._ctxId, method, args, resultId,
		})
		scheduleFlush(this._nodeId)
		return new NativeGradient(this._nodeId, resultId)
	}

	_resolveImage(img) {
		if (img && img.__canvasImageId) return { __canvasResourceId: img.__canvasImageId }
		return img
	}
}

// ─── Property getter/setter for SkiaContext2D ───

const PROPS = [
	'fillStyle', 'strokeStyle', 'lineWidth', 'lineCap', 'lineJoin', 'miterLimit',
	'font', 'textAlign', 'textBaseline', 'globalAlpha', 'globalCompositeOperation',
	'shadowBlur', 'shadowColor', 'shadowOffsetX', 'shadowOffsetY',
	'lineDashOffset', 'imageSmoothingEnabled', 'imageSmoothingQuality',
]

for (const prop of PROPS) {
	Object.defineProperty(SkiaContext2D.prototype, prop, {
		set(value) {
			this['_' + prop] = value
			skia._bufferOp(this._nodeId, {
				op: 'contextSetProperty', contextId: this._ctxId, prop, value,
			})
			scheduleFlush(this._nodeId)
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
		skia._bufferOp(this._nodeId, {
			op: 'resourceCall', resourceId: this.__canvasResourceId,
			method: 'addColorStop', args: [offset, color],
		})
		scheduleFlush(this._nodeId)
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
		skia._bufferOp(this._nodeId, {
			op: 'imageSetSrc', imageId: this.__canvasImageId,
			src: value, onload: onloadId, onerror: onerrorId,
		})
		scheduleFlush(this._nodeId)
	}

	get src() { return this._src }
}

// ─── SkiaCanvasNode: canvas node backed by C bindings ───

class SkiaCanvasNode {
	constructor({ nodeId, bridgeId, width = 300, height = 150, type = '2d' }) {
		this.__diminaCanvasNode = true
		this.nodeId = nodeId
		this.bridgeId = bridgeId
		this.type = type
		this._width = width
		this._height = height
		this._ctx = null
		console.log('[SkiaCanvasNode] constructor: nodeId=' + nodeId + ' _createCanvas=' + typeof skia._createCanvas)
		skia._createCanvas(nodeId, width, height)
	}

	get width() { return this._width }

	set width(v) {
		this._width = v
		skia._bufferOp(this.nodeId, { op: 'setCanvasProperty', prop: 'width', value: v })
		scheduleFlush(this.nodeId)
	}

	get height() { return this._height }

	set height(v) {
		this._height = v
		skia._bufferOp(this.nodeId, { op: 'setCanvasProperty', prop: 'height', value: v })
		scheduleFlush(this.nodeId)
	}

	getContext(type) {
		if (!this._ctx) this._ctx = new SkiaContext2D(this.nodeId)
		return this._ctx
	}

	createImage() { return new NativeImage(this.nodeId) }

	requestAnimationFrame(fn) { return setTimeout(() => fn(Date.now()), 16) }

	cancelAnimationFrame(id) { clearTimeout(id) }

	toDataURL(type, quality) {
		const result = skia._syncOp(this.nodeId, {
			name: 'canvasToDataURLSync', type: type || 'image/png', quality,
		})
		return (result && result.dataUrl) || ''
	}

	destroy() {
		skia._destroyCanvas(this.nodeId)
		this._ctx = null
	}
}

// ─── Exports ───

export class CanvasNode {
	constructor(options) {
		if (isSkiaAvailable) {
			return new SkiaCanvasNode(options)
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
	console.log('[native-node] hydrateSelectorQueryResult: isSkiaAvailable=' + isSkiaAvailable + ' value=', value ? (Array.isArray(value) ? 'Array(' + value.length + ')' : typeof value) : 'null')
	if (!isSkiaAvailable) {
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
	if (!isSkiaAvailable) {
		return createOffscreenCanvasFallback(options)
	}

	const width = Number(options.width) || 300
	const height = Number(options.height) || 150
	const type = options.type || '2d'
	const nodeId = `offscreen_canvas_${uuid()}`
	const bridgeId = getCurrentBridgeId()

	return new SkiaCanvasNode({
		nodeId,
		bridgeId,
		width,
		height,
		type,
	})
}
