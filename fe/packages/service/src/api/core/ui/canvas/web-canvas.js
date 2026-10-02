import { canvasPixelBudgetError, normalizeCanvasBitmapDimension } from '@dimina/common'
import { getFileSystemManager } from '@/api/core/file'
import message from '@/core/message'
import { dispatchBackgroundWork } from '@/core/background-scheduler'

const nodes = new Map()
const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis)
const cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis)

// Keep the actual OffscreenCanvas identity: WebGL, ImageBitmap and libraries
// that inspect context.canvas must all see the same browser-owned object.
export function adoptWebCanvas(canvas, nodeId, bridgeId) {
	const budgetError = canvasPixelBudgetError(canvas.width, canvas.height, { allowZero: true })
	if (budgetError) throw new RangeError(budgetError)
	const contexts = new Map()
	const frames = new Set()
	const images = new Set()
	let disposed = false
	const getContext = canvas.getContext.bind(canvas)
	const prototype = Object.getPrototypeOf(canvas)
	for (const dimension of ['width', 'height']) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, dimension)
		Object.defineProperty(canvas, dimension, {
			get: () => descriptor.get.call(canvas),
			set(value) {
				if (disposed) throw new Error('Canvas has been disposed')
				const size = normalizeCanvasBitmapDimension(value, dimension === 'width' ? 300 : 150)
				const error = canvasPixelBudgetError(dimension === 'width' ? size : canvas.width, dimension === 'height' ? size : canvas.height, { allowZero: true })
				if (error) throw new RangeError(error)
				descriptor.set.call(canvas, size)
			},
		})
	}
	canvas.getContext = (type, attributes) => {
		if (disposed) return null
		if (contexts.has(type)) return contexts.get(type)
		const context = getContext(type, attributes)
		if (!context) return null
		const methods = new Map()
		const proxy = new Proxy(context, {
			get(target, key) {
				const value = Reflect.get(target, key, target)
				if (typeof value !== 'function') return value
				if (!methods.has(key)) methods.set(key, (...args) => {
					if (disposed) throw new Error('Canvas has been disposed')
					return value.apply(target, args.map(arg => arg instanceof WebCanvasImage ? arg.bitmap : arg))
				})
				return methods.get(key)
			},
			set(target, key, value) { return Reflect.set(target, key, value, target) },
		})
		contexts.set(type, proxy)
		return proxy
	}
	canvas.requestAnimationFrame = (callback) => {
		if (disposed) throw new Error('Canvas has been disposed')
		if (!requestFrame) throw new Error('Worker requestAnimationFrame is not supported in this browser')
		const id = requestFrame(time => {
			dispatchBackgroundWork(() => {
				if (disposed || !frames.delete(id)) return
				callback(time)
			})
		})
		frames.add(id)
		return id
	}
	canvas.cancelAnimationFrame = (id) => {
		frames.delete(id)
		cancelFrame(id)
	}
	canvas.createImage = () => {
		if (disposed) throw new Error('Canvas has been disposed')
		const image = new WebCanvasImage()
		images.add(image)
		return image
	}
	canvas.dispose = () => {
		if (disposed) return
		for (const id of frames) cancelFrame(id)
		for (const image of images) image.dispose()
		for (const context of contexts.values()) context.getExtension?.('WEBGL_lose_context')?.loseContext()
		canvas.width = 0
		canvas.height = 0
		disposed = true
		frames.clear()
		images.clear()
		contexts.clear()
		if (nodes.get(nodeId)?.canvas === canvas) nodes.delete(nodeId)
	}
	nodes.set(nodeId, { canvas, bridgeId })
	return canvas
}

class WebCanvasImage {
	constructor() { this.width = 0; this.height = 0; this.generation = 0 }
	get src() { return this.source || '' }
	set src(source) {
		if (this.disposed) return
		this.source = source
		const generation = ++this.generation
		this.abort?.abort()
		this.abort = new AbortController()
		this.bitmap?.close()
		this.bitmap = null
		const bytes = /^(https?:|blob:|data:)/.test(source)
			? fetch(source, { signal: this.abort.signal }).then(response => { if (!response.ok) throw new Error(`Image HTTP ${response.status}`); return response.blob() })
			: new Promise((resolve, reject) => getFileSystemManager().readFile({ filePath: source, success: result => resolve(new Blob([result.data])), fail: reject }))
		bytes.then(blob => createImageBitmap(blob)).then(bitmap => {
			if (this.disposed || this.generation !== generation) { bitmap.close(); return }
			this.bitmap = bitmap
			this.width = bitmap.width
			this.height = bitmap.height
			this.onload?.()
		}).catch(error => { if (!this.disposed && this.generation === generation) this.onerror?.(error) })
	}
	dispose() { this.abort?.abort(); this.disposed = true; this.generation++; this.bitmap?.close(); this.bitmap = null; this.onload = null; this.onerror = null }
}

export function getTransferredCanvas(nodeId, bridgeId) {
	const node = nodes.get(nodeId)
	if (!node || node.bridgeId !== bridgeId) throw new Error('Canvas transfer has not arrived for this page')
	return node.canvas
}

message.on('canvasTransfer', ({ canvas, nodeId, bridgeId }) => adoptWebCanvas(canvas, nodeId, bridgeId))
message.on('canvasTransferredDispose', ({ nodeId, bridgeId }) => nodes.get(nodeId)?.bridgeId === bridgeId && nodes.get(nodeId).canvas.dispose())
message.on('pageUnload', ({ bridgeId }) => {
	for (const node of [...nodes.values()]) if (node.bridgeId === bridgeId) node.canvas.dispose()
})
