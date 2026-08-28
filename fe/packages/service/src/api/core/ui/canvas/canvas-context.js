import { invokeAPI } from '@/api/common'
import {
	createCircularGradient,
	createLinearGradient,
	createMeasureContext,
	createPattern,
	measureTextWidth,
	parseFont,
	replaceFontSize,
	resolveImageSource,
	serializeCanvasStyle,
} from './canvas-style'

const DEFAULT_FONT = '10px sans-serif'

function defaultState() {
	return {
		lineDash: [0, 0],
		lineDashOffset: 0,
		shadowOffsetX: 0,
		shadowOffsetY: 0,
		shadowBlur: 0,
		shadowColor: '#000000',
		font: DEFAULT_FONT,
		fontSize: 10,
		fontWeight: 'normal',
		fontStyle: 'normal',
		fontFamily: 'sans-serif',
	}
}


function cloneActionValue(value) {
	if (Array.isArray(value)) {
		return value.map(cloneActionValue)
	}
	if (value && typeof value === 'object') {
		const result = {}
		for (const key of Object.keys(value)) {
			result[key] = cloneActionValue(value[key])
		}
		return result
	}
	return value
}

/**
 * 有些值过不了 native 宿主那条通道：三端都用 JS 的 `JSON.stringify` 把消息序列化，
 * 按 ECMA-262，**非有限数（NaN / ±Infinity）和数组里的 `undefined` 都会被静默写成 `null`**，
 * 渲染层再拿它赋值时 `null` 折成 0。`globalAlpha` 这种「0 本身是合法值」的属性因此被钉死在
 * 全透明上——它不在每批的复位清单里，此后每一批都画不出任何东西；`fillRect(NaN, …)` 这类
 * 本该被忽略的调用也会变成真的画在坐标 0 上。W3C 对非有限参数的规定是整条调用忽略，
 * 所以录制时就按此丢弃，payload 里根本不出现这类值。
 *
 * `null` 不在此列：它经 JSON 与结构化克隆都保持 `null`，两端同样转成 0，行为一致，
 * 不构成跨端分裂，拦掉反而会误伤合法输入。
 */
function isJsonUnsafe(value) {
	if (Array.isArray(value)) {
		return value.some(isJsonUnsafe)
	}
	// 渐变、图案这些样式被序列化成普通对象，非有限数藏在 data / colorStop 里，不往下看就漏了
	if (value !== null && typeof value === 'object') {
		return Object.values(value).some(isJsonUnsafe)
	}
	return value === undefined || (typeof value === 'number' && !Number.isFinite(value))
}

export function hasJsonUnsafeValue(values) {
	return values.some(isJsonUnsafe)
}

/**
 * 旧版绘图上下文（wx.createCanvasContext）。
 *
 * 语义对齐微信官方基础库：逻辑层只把调用录成 action，`draw()` 时整批发给渲染层回放。
 * 与新版 `type="2d"` 不同，渲染层在 `draw()` 之前对这些调用一无所知，
 * 所以这里的 state / _transform 就是这套接口唯一的状态来源。
 */
export class CanvasContext {
	constructor(canvasId = '', moduleId = null) {
		this.canvasId = canvasId
		this.moduleId = moduleId
		this.actions = []
		this.path = []
		this.state = defaultState()
		this.drawingState = []
		this._transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
	}

	pushAction(type, ...args) {
		if (hasJsonUnsafeValue(args)) {
			return this
		}
		this.actions.push({ type, args })
		return this
	}

	getActions() {
		// 录制时的守卫拦不住返回之后的突变：setLineDash 按官方语义存的是调用方那个数组本身，
		// 调用方在 draw() 之前把它改成 NaN，就能让本该整条丢弃的调用走到 payload 里。
		// 快照之后在这个唯一出口再查一次，规则与手搓 actions 入口（drawCanvas）一致。
		const actions = this.actions
			.map(cloneActionValue)
			.filter(action => !hasJsonUnsafeValue(action.args))
		this.actions = []
		this.path = []
		return actions
	}

	clearActions() {
		this.actions = []
		this.path = []
	}

	pushPathAction(type, ...args) {
		if (hasJsonUnsafeValue(args)) {
			return this
		}
		this.path.push({ type, args })
		return this
	}

	pushPathSnapshot(type) {
		return this.pushAction(type, this.path.map(cloneActionValue))
	}

	draw(reserve = false, callback) {
		let done = callback
		if (done !== undefined && done !== null && typeof done !== 'function') {
			console.warn(`CanvasContext.draw callback is not a function, got ${typeof done}`)
			done = undefined
		}
		// 无条件先取走 actions，官方也是在任何分支之前就清的：
		// 否则 createContext() 那种没有 canvasId 的游离 context 每次 draw 都只是空转，录的东西一条不掉。
		const actions = this.getActions()
		if (!this.canvasId) {
			return
		}
		// 回调走 complete 而不是 success：官方就是这么挂的，而且渲染层失败时只发 fail 和 complete，
		// 挂在 success 上会让失败的 draw 永远不回调，回调表里的闭包也就永远释放不掉。
		invokeAPI('drawCanvas', {
			canvasId: this.canvasId,
			moduleId: this.moduleId,
			actions,
			reserve,
			complete: done,
		}, 'render')
	}

	// 路径

	beginPath() {
		this.path = []
		return this
	}

	closePath() { return this.pushPathAction('closePath') }
	moveTo(x, y) { return this.pushPathAction('moveTo', x, y) }
	lineTo(x, y) {
		return this.pushPathAction(this.path.length === 0 ? 'moveTo' : 'lineTo', x, y)
	}

	rect(x, y, width, height) { return this.pushPathAction('rect', x, y, width, height) }
	arcTo(x1, y1, x2, y2, radius) { return this.pushPathAction('arcTo', x1, y1, x2, y2, radius) }
	quadraticCurveTo(cpx, cpy, x, y) { return this.pushPathAction('quadraticCurveTo', cpx, cpy, x, y) }
	bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) { return this.pushPathAction('bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y) }

	arc(x, y, r, sAngle, eAngle, counterclockwise = false) {
		return this.pushPathAction('arc', x, y, r, sAngle, eAngle, counterclockwise)
	}

	// 绘制

	fill() { return this.pushPathSnapshot('fillPath') }
	stroke() { return this.pushPathSnapshot('strokePath') }
	clip() { return this.pushPathSnapshot('clip') }
	clearRect(x, y, width, height) { return this.pushAction('clearRect', x, y, width, height) }
	fillRect(x, y, width, height) {
		return this.pushAction('fillPath', [{ type: 'rect', args: [x, y, width, height] }])
	}

	strokeRect(x, y, width, height) {
		return this.pushAction('strokePath', [{ type: 'rect', args: [x, y, width, height] }])
	}

	fillText(text, x, y, maxWidth) {
		return this._pushText('fillText', text, x, y, maxWidth)
	}

	strokeText(text, x, y, maxWidth) {
		return this._pushText('strokeText', text, x, y, maxWidth)
	}

	_pushText(type, text, x, y, maxWidth) {
		// NaN / Infinity 传给真实 canvas 会让整段文字一个像素都不画，
		// 而 '100' 这种数字字符串真实 canvas 是认的——所以判据是"能不能归一化成有限数"，不是 typeof。
		if (maxWidth !== undefined && maxWidth !== null) {
			const limit = Number(maxWidth)
			if (Number.isFinite(limit)) {
				return this.pushAction(type, String(text), x, y, limit)
			}
		}
		return this.pushAction(type, String(text), x, y)
	}

	/**
	 * 按尾部参数是不是有限数来选重载形式，而不是按传了几个参数。
	 * `drawImage(path, x, y, w, h)` 里的 w/h 因数据缺失变成 undefined 是常见情况，
	 * 原样透传的话真实 canvas 遇到非有限值会直接 return——整张图一个像素都不画；
	 * 退化成 3 参则按图片原始尺寸画出来。
	 */
	drawImage(imageResource, ...rest) {
		const src = resolveImageSource(imageResource)
		let [sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight] = rest
		if (dHeight === undefined) {
			// 不足 9 个参数时，前四个位置本来就是目标矩形
			;[dx, dy, dWidth, dHeight] = [sx, sy, sWidth, sHeight]
			sx = undefined
			sy = undefined
			sWidth = undefined
			sHeight = undefined
		}
		const finite = value => Number.isFinite(value)
		if (finite(sx) && finite(sy) && finite(sWidth) && finite(sHeight)) {
			return this.pushAction('drawImage', src, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
		}
		if (finite(dWidth) && finite(dHeight)) {
			return this.pushAction('drawImage', src, dx, dy, dWidth, dHeight)
		}
		return this.pushAction('drawImage', src, dx, dy)
	}

	// 变换
	//
	// 只有 transform / setTransform / scale 会更新 _transform，
	// rotate 和 translate 不更新——这是微信官方实现的实际行为，getTransform() 与之保持一致。

	rotate(angle) { return this.pushAction('rotate', angle) }
	translate(x, y) { return this.pushAction('translate', x, y) }

	scale(scaleWidth, scaleHeight) {
		// 矩阵计算必须排在拦截之后：先算再补救的话，被丢弃的这次调用已经把 _transform 污染了，
		// getTransform() 和后续所有变换都跟着错下去。transform / setTransform 同理。
		if (hasJsonUnsafeValue([scaleWidth, scaleHeight])) {
			return this
		}
		const m = this._transform
		this._transform = {
			a: m.a * scaleWidth,
			b: m.b * scaleWidth,
			c: m.c * scaleHeight,
			d: m.d * scaleHeight,
			e: m.e,
			f: m.f,
		}
		return this.pushAction('scale', scaleWidth, scaleHeight)
	}

	transform(scaleX, skewX, skewY, scaleY, translateX, translateY) {
		if (hasJsonUnsafeValue([scaleX, skewX, skewY, scaleY, translateX, translateY])) {
			return this
		}
		const m = this._transform
		this._transform = {
			a: scaleX * m.a + skewX * m.c,
			b: scaleX * m.b + skewX * m.d,
			c: skewY * m.a + scaleY * m.c,
			d: skewY * m.b + scaleY * m.d,
			e: translateX * m.a + translateY * m.c + m.e,
			f: translateX * m.b + translateY * m.d + m.f,
		}
		return this.pushAction('transform', scaleX, skewX, skewY, scaleY, translateX, translateY)
	}

	setTransform(scaleX, skewX, skewY, scaleY, translateX, translateY) {
		if (hasJsonUnsafeValue([scaleX, skewX, skewY, scaleY, translateX, translateY])) {
			return this
		}
		this._transform = { a: scaleX, b: skewX, c: skewY, d: scaleY, e: translateX, f: translateY }
		return this.pushAction('setTransform', scaleX, skewX, skewY, scaleY, translateX, translateY)
	}

	getTransform() {
		return this._transform
	}

	// 状态

	// 入栈的是 state 本身而不是快照：save 之后的 setter 都在原地改这个对象，所以 restore 弹回来的
	// 还是同一个对象，font / getLineDash() / measureText() 都不会回滚。真正被回滚的是渲染层那份
	// 2D 上下文状态——它由录进 actions 的 save / restore 驱动，与这里的逻辑状态是两套东西。
	save() {
		this.drawingState.push(this.state)
		return this.pushAction('save')
	}

	restore() {
		this.state = this.drawingState.pop() || defaultState()
		return this.pushAction('restore')
	}

	setFillStyle(color) { return this.pushAction('setFillStyle', serializeCanvasStyle(color)) }
	setStrokeStyle(color) { return this.pushAction('setStrokeStyle', serializeCanvasStyle(color)) }
	setGlobalAlpha(alpha) { return this.pushAction('setGlobalAlpha', alpha) }
	setLineCap(lineCap) { return this.pushAction('setLineCap', lineCap) }
	setLineJoin(lineJoin) { return this.pushAction('setLineJoin', lineJoin) }
	setLineWidth(lineWidth) { return this.pushAction('setLineWidth', lineWidth) }
	setMiterLimit(miterLimit) { return this.pushAction('setMiterLimit', miterLimit) }
	setTextAlign(align) { return this.pushAction('setTextAlign', align) }
	setTextBaseline(textBaseline) { return this.pushAction('setTextBaseline', textBaseline) }

	setShadow(offsetX, offsetY, blur, color) {
		if (hasJsonUnsafeValue([offsetX, offsetY, blur])) {
			return this
		}
		this.state.shadowOffsetX = offsetX
		this.state.shadowOffsetY = offsetY
		this.state.shadowBlur = blur
		this.state.shadowColor = color
		return this.pushAction('setShadow', offsetX, offsetY, blur, color)
	}

	setFontSize(fontSize) {
		// 非数字会把 state.font 写成 '20pxpx sans-serif' 这类非法串，而真实 canvas 对非法 font
		// 是静默拒绝赋值的——之后每次测量和绘制都还在用旧字体，且再调一次 setFontSize 也修不回来。
		const size = Number(fontSize)
		if (!Number.isFinite(size)) {
			return this
		}
		this.state.font = replaceFontSize(this.state.font, size)
		this.state.fontSize = size
		return this.pushAction('setFontSize', size)
	}

	setLineDash(pattern, offset) {
		// 官方 `[].slice.apply(arguments,[0,2])` 拷的是实参表而不是数组，`state.lineDash` 拿到的就是
		// 调用方那个数组本身：调用之后再改它，getLineDash() 与还没提交的 action 都会跟着变。这里保持同一引用。
		const dash = Array.isArray(pattern) && pattern.length ? pattern : [0, 0]
		// 相位省略时按 0 处理；但显式传进来的非有限数要整条丢弃，不能被 `offset || 0` 悄悄吞成 0
		// ——那样 NaN 会变成"实线"、Infinity 却原样漏过去，两种非有限值待遇还不一致。
		const phase = offset === undefined || offset === null ? 0 : offset
		if (hasJsonUnsafeValue([dash, phase])) {
			return this
		}
		this.state.lineDash = dash
		this.state.lineDashOffset = phase
		return this.pushAction('setLineDash', dash, phase)
	}

	getLineDash() {
		return this.state.lineDash
	}

	// 属性
	//
	// 官方这批属性只有 setter（font 例外），读取得到 undefined，这里保持一致。

	set fillStyle(value) { this.setFillStyle(value) }
	set strokeStyle(value) { this.setStrokeStyle(value) }
	set globalAlpha(value) { this.setGlobalAlpha(value) }
	set lineCap(value) { this.setLineCap(value) }
	set lineJoin(value) { this.setLineJoin(value) }
	set lineWidth(value) { this.setLineWidth(value) }
	set miterLimit(value) { this.setMiterLimit(value) }
	set textAlign(value) { this.setTextAlign(value) }
	set textBaseline(value) { this.setTextBaseline(value) }
	set globalCompositeOperation(value) { this.pushAction('setGlobalCompositeOperation', value) }
	set lineDashOffset(value) {
		if (hasJsonUnsafeValue([value])) {
			return
		}
		this.state.lineDashOffset = value
		this.pushAction('setLineDashOffset', value)
	}

	set shadowBlur(value) {
		if (hasJsonUnsafeValue([value])) {
			return
		}
		this.state.shadowBlur = value
		this.pushAction('setShadowBlur', value)
	}

	set shadowColor(value) {
		this.state.shadowColor = value
		this.pushAction('setShadowColor', value)
	}

	set shadowOffsetX(value) {
		if (hasJsonUnsafeValue([value])) {
			return
		}
		this.state.shadowOffsetX = value
		this.pushAction('setShadowOffsetX', value)
	}

	set shadowOffsetY(value) {
		if (hasJsonUnsafeValue([value])) {
			return
		}
		this.state.shadowOffsetY = value
		this.pushAction('setShadowOffsetY', value)
	}

	set font(value) {
		// 基础库是先无条件存下原始串再去解析的，所以解析失败时 getter 仍然回读刚写进去的值，
		// 只是不派发动作、也不更新拆出来的字号字族——渲染层因此还停在上一次的字体上。
		this.state.font = value
		const parsed = parseFont(value)
		if (!parsed) {
			console.warn(`Failed to set 'font' on 'CanvasContext': invalid format.`)
			return
		}
		this.state.fontStyle = parsed.fontStyle
		this.state.fontWeight = parsed.fontWeight
		this.state.fontSize = parsed.fontSize
		this.state.fontFamily = parsed.fontFamily
		this.pushAction('setFont', parsed.font)
	}

	get font() {
		return this.state.font
	}

	// 渐变、图案与文字度量

	createLinearGradient(x0, y0, x1, y1) {
		return createLinearGradient(x0, y0, x1, y1)
	}

	createCircularGradient(x, y, r) {
		return createCircularGradient(x, y, r)
	}

	createPattern(image, repetition) {
		return createPattern(image, repetition)
	}

	measureText(text) {
		if (this._measureContext === undefined) {
			this._measureContext = createMeasureContext()
		}
		return { width: measureTextWidth(this._measureContext, text, this.state.font, this.state.fontSize) }
	}
}
