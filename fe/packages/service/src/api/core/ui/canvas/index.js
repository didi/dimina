import { invokeAPI } from '@/api/common'
import hostEnv from '@/core/host-env'
import router from '@/core/router'
import { canvasPixelBudgetError } from '@dimina/common'
import { CanvasContext, hasJsonUnsafeValue } from './canvas-context'

export { createCanvas, createOffscreenCanvas } from './canvas-node'

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
	// 这个入口收的是调用方手搓的 actions，绕过了 CanvasContext 的录制，
	// 逻辑层「发出去的 payload 里不出现 JSON 会折成 null 的值」这条不变量要在这里也守住。
	// 形状本身就不对的条目（不是对象、args 不是数组）同样整条丢弃：它已经不可信了，
	// 留着只会让渲染层回放到一半才崩，连累同批次里其余合法的 action。
	if (Array.isArray(params.actions)) {
		params.actions = params.actions.filter((action) => {
			if (!action || typeof action !== 'object') {
				return false
			}
			if (action.args === undefined) {
				return true
			}
			return Array.isArray(action.args) && !hasJsonUnsafeValue(action.args)
		})
	}
	invokeAPI('drawCanvas', params, 'render')
}

/**
 * https://developers.weixin.qq.com/miniprogram/dev/api/canvas/wx.canvasToTempFilePath.html
 */
export function canvasToTempFilePath(opts = {}, component) {
	const params = canvasApiParams(opts, component)
	delete params.pixelRatio
	const pixelRatio = Number(hostEnv.getSystemInfo()?.pixelRatio)
	if (Number.isFinite(pixelRatio) && pixelRatio > 0) {
		params.pixelRatio = pixelRatio
	}
	// JSON.stringify 会把 NaN/Infinity 折成 null。源裁剪参数按微信旧版的假值规则回到
	// 省略值；输出尺寸没有可安全推导的目标，保留明确失败而不是静默生成 0 尺寸图片。
	for (const key of ['x', 'y', 'width', 'height']) {
		if (typeof params[key] === 'number' && !Number.isFinite(params[key])) {
			delete params[key]
		}
	}
	for (const key of ['destWidth', 'destHeight']) {
		if (typeof params[key] === 'number' && !Number.isFinite(params[key])) {
			delete params[key]
			setCanvasValidationError(params, `${key} must be finite`)
		}
	}
	return invokeAPI('canvasToTempFilePath', params, 'render')
}

/**
 * 获取旧版 canvas 的像素数据。该 API 自身是异步 API，适合沿用 service/render 回调通道；
 * 回到逻辑层时再恢复官方要求的 Uint8ClampedArray。
 */
export function canvasGetImageData(opts = {}, component) {
	const success = opts.success
	const complete = opts.complete
	const params = canvasApiParams(opts, component)
	normalizePixelCoordinate(params, 'x')
	normalizePixelCoordinate(params, 'y')
	normalizePixelExtent(params, 'width')
	normalizePixelExtent(params, 'height')
	const budgetError = canvasPixelBudgetError(params.width, params.height, { transferable: true })
	if (budgetError) {
		setCanvasValidationError(params, budgetError)
	}
	if (typeof success === 'function') {
		params.success = result => success(normalizeImageDataResult(result))
	}
	if (typeof complete === 'function') {
		params.complete = result => complete(normalizeImageDataResult(result))
	}
	const result = invokeAPI('canvasGetImageData', params, 'render')
	return result?.then ? result.then(normalizeImageDataResult) : result
}

/**
 * Uint8ClampedArray 不能依赖各 native JSON bridge 原样保存类型，发送前统一转成普通数组。
 */
export function canvasPutImageData(opts = {}, component) {
	const params = canvasApiParams(opts, component)
	normalizePixelCoordinate(params, 'x')
	normalizePixelCoordinate(params, 'y')
	if (typeof params.width !== 'number' || !Number.isFinite(params.width)) {
		setCanvasValidationError(params, 'invalid width argument')
	}
	if (Object.prototype.toString.call(params.data) !== '[object Uint8ClampedArray]') {
		setCanvasValidationError(params, 'data argument must be an Uint8ClampedArray')
	}
	const dataLength = params.data?.length
	const height = typeof params.height === 'number'
		? params.height
		: Math.floor(dataLength / params.width / 4)
	params.height = height
	if (!Number.isFinite(height) || params.width * height * 4 !== dataLength) {
		setCanvasValidationError(params, 'invalid data format')
	}
	const budgetError = canvasPixelBudgetError(params.width, height, { transferable: true })
	if (budgetError) {
		setCanvasValidationError(params, budgetError)
	}
	if (!params.canvasValidationError) {
		params.data = Array.from(params.data)
	}
	return invokeAPI('canvasPutImageData', params, 'render')
}

function canvasApiParams(opts, component) {
	const params = {
		...opts,
		moduleId: opts.moduleId || resolveModuleId(component || opts.component),
	}
	delete params.component
	return params
}

function normalizePixelCoordinate(params, key) {
	const value = Number(params[key]) || 0
	if (!Number.isFinite(value)) {
		setCanvasValidationError(params, `${key} must be finite`)
		params[key] = 0
		return
	}
	params[key] = value
}

function normalizePixelExtent(params, key) {
	const value = Number(params[key]) || 0
	if (!Number.isFinite(value)) {
		setCanvasValidationError(params, `${key} must be finite`)
		params[key] = 0
		return
	}
	params[key] = value
	if (value === 0) {
		setCanvasValidationError(params, `the source ${key} is 0`)
	}
}

function setCanvasValidationError(params, message) {
	if (!params.canvasValidationError) {
		params.canvasValidationError = message
	}
}

function normalizeImageDataResult(result) {
	const payload = Array.isArray(result) && result.length === 1 ? result[0] : result
	if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data') || payload.data instanceof Uint8ClampedArray) {
		return payload
	}
	return {
		...payload,
		data: new Uint8ClampedArray(payload.data),
	}
}

function resolveModuleId(component) {
	return component?.__id__ || router.getPageInfo()?.id
}
