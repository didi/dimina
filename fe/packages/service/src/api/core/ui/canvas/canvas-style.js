const PATTERN_REPETITIONS = ['repeat', 'repeat-x', 'repeat-y', 'no-repeat']
const FONT_PATTERN = /^(([\w-]+\s)*)(\d+r?px)(\/(\d+\.?\d*(r?px)?))?\s+(.*)/
const FONT_SIZE_PATTERN = /\d+\.?\d*px/
// 东亚宽字符（含 CJK 表意文字、假名、谚文、全角标点），字宽约等于字号，
// 与 ASCII 的约半个字号差一倍——回退估算必须区分，否则中文换行/居中会明显错位。
const WIDE_CHAR_PATTERN = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︐-︙︰-﹯＀-｠￠-￦]/

/**
 * 旧版 canvas 的渐变对象。逻辑层只记录描述，真正的渐变在渲染层还原。
 */
export class CanvasGradient {
	constructor(type, data) {
		this.type = type
		this.data = data
		this.colorStop = []
	}

	addColorStop(stop, color) {
		this.colorStop.push([stop, color])
	}
}

/**
 * 旧版 canvas 的图案对象，同样只在逻辑层记录描述。
 */
export class CanvasPattern {
	constructor(image, repetition) {
		this.image = image
		this.repetition = repetition
	}
}

/**
 * 图片参数既可能是路径字符串，也可能是渲染层回传的图片对象。
 */
export function resolveImageSource(image) {
	if (typeof image === 'string') {
		return image
	}
	return image?.src ?? image?._src ?? image
}

export function createLinearGradient(x0, y0, x1, y1) {
	return new CanvasGradient('linear', [x0, y0, x1, y1])
}

export function createCircularGradient(x, y, r) {
	return new CanvasGradient('radial', [x, y, r])
}

export function createPattern(image, repetition) {
	if (repetition === undefined) {
		console.error(`Failed to execute 'createPattern' on 'CanvasContext': 2 arguments required, but only 1 present.`)
		return undefined
	}
	if (!PATTERN_REPETITIONS.includes(repetition)) {
		console.error(`Failed to execute 'createPattern' on 'CanvasContext': The provided type ('${repetition}') is not one of 'repeat', 'no-repeat', 'repeat-x', or 'repeat-y'.`)
		return undefined
	}
	return new CanvasPattern(resolveImageSource(image), repetition)
}

/**
 * fillStyle / strokeStyle 的取值有三种：颜色字符串、渐变、图案。
 * 后两者要转成可结构化传输的描述，渲染层按 __canvasStyle 分派还原。
 */
export function serializeCanvasStyle(value) {
	if (value instanceof CanvasGradient) {
		return {
			__canvasStyle: 'gradient',
			type: value.type,
			data: [...value.data],
			colorStop: value.colorStop.map(([stop, color]) => [stop, color]),
		}
	}
	if (value instanceof CanvasPattern) {
		return {
			__canvasStyle: 'pattern',
			image: value.image,
			repetition: value.repetition,
		}
	}
	return value
}

/**
 * 解析 CSS font 简写，对齐微信官方的分支顺序：
 * style 分支先于 weight 分支判定，所以单独一个 `normal` 归 fontStyle。
 * 返回 null 表示格式不合法（例如用了 px 以外的单位）。
 */
export function parseFont(input) {
	const matched = String(input).match(FONT_PATTERN)
	if (!matched) {
		return null
	}

	const tokens = matched[1].trim().split(/\s/)
	const fontSize = Number.parseFloat(matched[3])
	const fontFamily = matched[7]
	const parts = []
	let fontStyle = 'normal'
	let fontWeight = 'normal'

	const pushNormalWeight = () => {
		parts.push('normal')
		fontWeight = 'normal'
	}

	tokens.forEach((token, index) => {
		if (['italic', 'oblique', 'normal'].includes(token)) {
			parts.push(token)
			fontStyle = token
		}
		else if (['bold', 'normal'].includes(token)) {
			parts.push(token)
			fontWeight = token
		}
		else if (index === 0) {
			parts.push('normal')
			fontStyle = 'normal'
		}
		else if (index === 1) {
			pushNormalWeight()
		}
	})
	if (tokens.length === 1) {
		pushNormalWeight()
	}

	return {
		font: `${parts.join(' ')} ${fontSize}px ${fontFamily}`,
		fontStyle,
		fontWeight,
		fontSize,
		fontFamily,
	}
}

export function replaceFontSize(font, fontSize) {
	return String(font).replace(FONT_SIZE_PATTERN, `${fontSize}px`)
}

/**
 * 逻辑层没有真实画布，量文字宽度靠一块自持的离屏画布——
 * 与微信官方逻辑层的做法一致，每个绘图上下文各持一块，量之前把 font 设成当前状态即可。
 */
export function createMeasureContext() {
	try {
		if (typeof OffscreenCanvas === 'function') {
			return new OffscreenCanvas(0, 0).getContext('2d')
		}
		if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
			return document.createElement('canvas').getContext('2d')
		}
	}
	catch {
		// 环境不支持离屏画布，落到按字号估算
	}
	return null
}

/**
 * measureText 必须同步返回，所以拿不到离屏画布时按字号粗略估算，而不是抛错。
 */
export function measureTextWidth(context, text, font, fontSize) {
	// 与 fillText 一致地用 String(text)：真实 canvas 的 measureText(null) 量的是 'null' 这四个字符，
	// 两个入口口径不同的话，靠 measureText 做居中的代码会偏
	const content = String(text)
	if (context) {
		try {
			context.font = font
			const width = context.measureText(content)?.width
			if (typeof width === 'number' && !Number.isNaN(width)) {
				return width
			}
		}
		catch {
			// 离屏画布不可用时落到下面的估算
		}
	}
	const size = typeof fontSize === 'number' && fontSize > 0 ? fontSize : 10
	let units = 0
	for (const char of content) {
		units += WIDE_CHAR_PATTERN.test(char) ? 1 : 0.5
	}
	return units * size
}
