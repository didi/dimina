function memoize(func) {
	const cache = new Map()

	return function (...args) {
		const key = args.length === 1 ? args[0] : JSON.stringify(args)
		if (cache.has(key)) {
			return cache.get(key)
		}
		const result = func.apply(this, args)
		cache.set(key, result)
		return result
	}
}

export const getAppList = memoize(async () => {
	const appList = await fetch(`${import.meta.env.BASE_URL}appList.json`).then(res => res.json())
	appList.forEach((appInfo) => {
		const key = JSON.stringify(appInfo)
		const logo = sessionStorage.getItem(key)
		if (logo) {
			appInfo.logo = logo
		}
		else {
			const result = generateLogo(appInfo)
			sessionStorage.setItem(key, result)
			appInfo.logo = result
		}
	})
	return appList
})

// 模拟调用开放平台接口，获取应用信息
export async function getMiniAppInfo(appId) {
	const appList = await getAppList()
	for (const app of appList) {
		if (app.appId === appId) {
			return app
		}
	}
}

/**
 * Generates a consistent color based on the name's hash code
 * @param {string} name - The name to generate a color from
 * @returns {string} - A hex color code
 */
function generateColorFromName(name) {
	// If name is empty, return a default color (Material Blue)
	if (!name || name.length === 0) {
		return '#2196F3'
	}

	// Use the hash code of the name as a seed for color generation
	let hash = 0
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) - hash) + name.charCodeAt(i)
		hash |= 0 // Convert to 32bit integer
	}

	// Generate HSV color with consistent hue based on name
	// Use a limited range of saturation and value for visually pleasing colors
	const hue = Math.abs(hash % 360)
	const saturation = 0.7 + (Math.abs(hash % 3000) / 10000) // Range: 0.7-1.0
	const value = 0.8 + (Math.abs(hash % 2000) / 10000) // Range: 0.8-1.0

	// Convert HSV to RGB
	const rgbColor = hsvToRgb(hue, saturation, value)

	// Convert RGB to hex
	return rgbToHex(rgbColor[0], rgbColor[1], rgbColor[2])
}

/**
 * Converts HSV color values to RGB
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-1)
 * @param {number} v - Value (0-1)
 * @returns {number[]} - Array of [r, g, b] values (0-255)
 */
function hsvToRgb(h, s, v) {
	let r, g, b
	const i = Math.floor(h / 60)
	const f = h / 60 - i
	const p = v * (1 - s)
	const q = v * (1 - f * s)
	const t = v * (1 - (1 - f) * s)

	/* eslint-disable style/max-statements-per-line */
	switch (i % 6) {
		case 0: r = v; g = t; b = p; break
		case 1: r = q; g = v; b = p; break
		case 2: r = p; g = v; b = t; break
		case 3: r = p; g = q; b = v; break
		case 4: r = t; g = p; b = v; break
		case 5: r = v; g = p; b = q; break
	}
	/* eslint-enable style/max-statements-per-line */

	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

/**
 * Converts RGB values to a hex color string
 * @param {number} r - Red (0-255)
 * @param {number} g - Green (0-255)
 * @param {number} b - Blue (0-255)
 * @returns {string} - Hex color code
 */
function rgbToHex(r, g, b) {
	return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

function generateLogo(app) {
	const size = [60, 60]
	const pixelRatio = window.devicePixelRatio || 1
	
	const cvs = document.createElement('canvas')
	// 设置实际显示尺寸
	cvs.style.width = size[0] + 'px'
	cvs.style.height = size[1] + 'px'
	// 设置内部画布尺寸（考虑设备像素比）
	cvs.width = size[0] * pixelRatio
	cvs.height = size[1] * pixelRatio
	
	const ctx = cvs.getContext('2d')
	// 缩放画布以匹配设备像素比
	ctx.scale(pixelRatio, pixelRatio)
	
	// 启用抗锯齿和文字渲染优化
	ctx.imageSmoothingEnabled = true
	ctx.imageSmoothingQuality = 'high'
	ctx.textRenderingOptimization = 'optimizeQuality'

	// Use the new color generation function instead of random colors
	ctx.fillStyle = generateColorFromName(app.name)
	ctx.fillRect(0, 0, size[0], size[1])
	ctx.fillStyle = 'rgb(255,255,255)'
	
	const fontSize = size[0] * 0.6
	ctx.font = `${fontSize}px Arial`
	
	const text = app.name.charAt(0)
	const textMetrics = ctx.measureText(text)
	
	// 计算精确的居中位置
	const x = size[0] / 2
	// 使用字体度量信息计算更精确的垂直居中位置
	const y = size[1] / 2 + (textMetrics.actualBoundingBoxAscent - textMetrics.actualBoundingBoxDescent) / 2
	
	ctx.textAlign = 'center'
	ctx.fillText(text, x, y)
	return cvs.toDataURL('image/png', 1)
}
