import { uuid } from '@dimina/common'
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

class SkiaCanvasNode {
	constructor({ nodeId, bridgeId, width = 300, height = 150, type = '2d' }) {
		this.__diminaCanvasNode = true
		this.nodeId = nodeId
		this.bridgeId = bridgeId
		this.type = type
		this._nativeCanvas = skia.createCanvas(nodeId, width, height)
	}

	get width() {
		return this._nativeCanvas.width
	}

	set width(value) {
		this._nativeCanvas.width = value
	}

	get height() {
		return this._nativeCanvas.height
	}

	set height(value) {
		this._nativeCanvas.height = value
	}

	getContext(type, attributes) {
		return this._nativeCanvas.getContext(type, attributes)
	}

	createImage() {
		return this._nativeCanvas.createImage()
	}

	requestAnimationFrame(fn) {
		return this._nativeCanvas.requestAnimationFrame(fn)
	}

	cancelAnimationFrame(id) {
		return this._nativeCanvas.cancelAnimationFrame(id)
	}

	toDataURL(type, quality) {
		return this._nativeCanvas.toDataURL(type, quality)
	}

	destroy() {
		if (this._nativeCanvas) {
			skia.destroyCanvas(this.nodeId)
			this._nativeCanvas = null
		}
	}
}

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
