import { invokeAPI } from '@/api/common'
import router from '@/core/router'

/**
 * 创建绘图上下文
 * 兼容旧版 wx.createContext。
 */
export function createContext() {
	return new CanvasContext()
}

/**
 * 创建 canvas 的绘图上下文
 * https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.createCanvasContext.html
 */
export function createCanvasContext(canvasId, component) {
	return new CanvasContext(canvasId, resolveModuleId(component))
}

/**
 * 兼容旧版 wx.drawCanvas。
 */
export function drawCanvas(opts = {}) {
	const params = {
		...opts,
		moduleId: opts.moduleId || resolveModuleId(opts.component),
	}
	delete params.component
	invokeAPI('drawCanvas', params, 'render')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html
 */
export function canvasToTempFilePath(opts = {}, component) {
	const params = {
		...opts,
		moduleId: opts.moduleId || resolveModuleId(component || opts.component),
	}
	delete params.component
	invokeAPI('canvasToTempFilePath', params, 'render')
}

function resolveModuleId(component) {
	return component?.__id__ || router.getPageInfo()?.id
}

class CanvasContext {
	constructor(canvasId = '', moduleId = null) {
		this.canvasId = canvasId
		this.moduleId = moduleId
		this.actions = []
	}

	pushAction(type, ...args) {
		this.actions.push({ type, args })
		return this
	}

	getActions() {
		return this.actions.slice()
	}

	draw(reserve = false, callback) {
		if (!this.canvasId) {
			return
		}
		drawCanvas({
			canvasId: this.canvasId,
			moduleId: this.moduleId,
			actions: this.getActions(),
			reserve,
			success: callback,
		})
		this.actions = []
	}

	beginPath() { return this.pushAction('beginPath') }
	closePath() { return this.pushAction('closePath') }
	moveTo(x, y) { return this.pushAction('moveTo', x, y) }
	lineTo(x, y) { return this.pushAction('lineTo', x, y) }
	rect(x, y, width, height) { return this.pushAction('rect', x, y, width, height) }
	arc(x, y, radius, startAngle, endAngle, counterclockwise = false) { return this.pushAction('arc', x, y, radius, startAngle, endAngle, counterclockwise) }
	quadraticCurveTo(cpx, cpy, x, y) { return this.pushAction('quadraticCurveTo', cpx, cpy, x, y) }
	bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) { return this.pushAction('bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y) }
	fill() { return this.pushAction('fill') }
	stroke() { return this.pushAction('stroke') }
	clearRect(x, y, width, height) { return this.pushAction('clearRect', x, y, width, height) }
	fillText(text, x, y, maxWidth) { return this.pushAction('fillText', text, x, y, maxWidth) }
	drawImage(src, ...rest) { return this.pushAction('drawImage', src, ...rest) }
	save() { return this.pushAction('save') }
	restore() { return this.pushAction('restore') }
	translate(x, y) { return this.pushAction('translate', x, y) }
	rotate(angle) { return this.pushAction('rotate', angle) }
	scale(x, y) { return this.pushAction('scale', x, y) }
	setShadow(offsetX, offsetY, blur, color) { return this.pushAction('setShadow', offsetX, offsetY, blur, color) }

	setFillStyle(value) { return this.pushAction('setFillStyle', value) }
	setStrokeStyle(value) { return this.pushAction('setStrokeStyle', value) }
	setGlobalAlpha(value) { return this.pushAction('setGlobalAlpha', value) }
	setLineCap(value) { return this.pushAction('setLineCap', value) }
	setLineJoin(value) { return this.pushAction('setLineJoin', value) }
	setLineWidth(value) { return this.pushAction('setLineWidth', value) }
	setMiterLimit(value) { return this.pushAction('setMiterLimit', value) }
	setFontSize(value) { return this.pushAction('setFontSize', value) }
}
