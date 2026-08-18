import type { StatusBarRect } from './types.js'
import './defaultShell.scss'

export interface DefaultShellOptions {
	/** 提供则自动把状态栏元素 prepend 到该元素内；不传则宿主自行插入 el */
	mount?: HTMLElement
	/** 状态栏高度 px，默认 44 */
	height?: number
	/** 是否显示当前时间（HH:MM），默认 true */
	showTime?: boolean
}

export interface DefaultShell {
	/** 状态栏根元素 */
	el: HTMLElement
	getStatusBarRect: () => StatusBarRect
	updateStatusBarColor: (color: string) => void
	/** 从 DOM 移除 el 并停止内部计时器；幂等 */
	destroy: () => void
}

const BASE_CLASS = 'dimina-default-shell__status-bar'

function formatTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * SDK 自带的默认宿主壳：极简无品牌状态栏（时间 + 深浅色联动）的 ShellAdapter 实现。
 * 闭包实现，方法不依赖 this，解构成裸函数引用传递也安全。
 */
export function createDefaultShell(options: DefaultShellOptions = {}): DefaultShell {
	const { mount, height = 44, showTime = true } = options

	const el = document.createElement('div')
	el.className = BASE_CLASS
	el.style.height = `${height}px`

	let timer: ReturnType<typeof setInterval> | null = null
	if (showTime) {
		const timeEl = document.createElement('span')
		timeEl.className = 'dimina-default-shell__time'
		timeEl.textContent = formatTime(new Date())
		el.appendChild(timeEl)
		timer = setInterval(() => {
			timeEl.textContent = formatTime(new Date())
		}, 1000)
	}

	mount?.prepend(el)

	return {
		el,
		getStatusBarRect: (): StatusBarRect => {
			if (el.isConnected) {
				return el.getBoundingClientRect()
			}
			// 未挂载时的兜底：高度仍可用于布局预估，其余为 0
			return { top: 0, left: 0, right: 0, width: 0, height, bottom: height }
		},
		updateStatusBarColor: (color: string): void => {
			// 只认 black / white，其它忽略
			if (color === 'black') {
				el.classList.add(`${BASE_CLASS}--black`)
				el.classList.remove(`${BASE_CLASS}--white`)
			}
			else if (color === 'white') {
				el.classList.add(`${BASE_CLASS}--white`)
				el.classList.remove(`${BASE_CLASS}--black`)
			}
		},
		destroy: (): void => {
			if (timer !== null) {
				clearInterval(timer)
				timer = null
			}
			el.remove()
		},
	}
}
