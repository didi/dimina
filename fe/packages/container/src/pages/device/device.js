import tpl from './device.html?raw'
import './device.scss'
import diminaLogo from '@/assets/dimina-logo.png'

export class Device {
	constructor() {
		this.appContainer = null
		this.application = null
		this.isScreenSleeping = false
		this.root = document.querySelector('#root')
		this.init()
	}

	init() {
		this.root.innerHTML = tpl
		this.root.querySelector('.device-stage__logo')?.setAttribute('src', diminaLogo)

		this.appContainer = this.root.querySelector('.iphone__apps')
		this.updateStatusBarColor('black')
		this.updateStatusBarTime()
		this.bindDynamicIsland()
		this.bindStageGlow()
		this.bindPowerButton()
	}

	updateStatusBarTime() {
		const timeElement = this.root.querySelector('.status-bar__time')

		const updateTime = () => {
			const now = new Date()
			const hours = now.getHours().toString().padStart(2, '0')
			const minutes = now.getMinutes().toString().padStart(2, '0')
			timeElement.textContent = `${hours}:${minutes}`
		}

		// 立即更新一次
		updateTime()

		// 每分钟更新一次（60000毫秒 = 1分钟）
		setInterval(updateTime, 60000)
	}

	bindDynamicIsland() {
		const island = this.root.querySelector('.iphone__screen_dynamic-island')
		island.addEventListener('click', () => {
			window.open('https://github.com/didi/dimina', '_blank')
		})

		// 鼠标进入灵动岛时放大效果
		island.addEventListener('mouseenter', () => {
			// 使用CSS类来添加缩放效果，而不是直接设置transform
			island.classList.add('island-hover')
		})

		// 鼠标离开灵动岛时恢复大小
		island.addEventListener('mouseleave', () => {
			// 移除CSS类来恢复大小
			island.classList.remove('island-hover')
		})
	}

	bindStageGlow() {
		const stage = this.root.querySelector('.device-stage')
		let pendingPointer = null
		let pointerFrame = 0
		const syncPointer = ({ x: pointerX, y: pointerY }) => {
			pendingPointer = { pointerX, pointerY }
			if (pointerFrame) {
				return
			}

			pointerFrame = requestAnimationFrame(() => {
				const { pointerX, pointerY } = pendingPointer
				const x = pointerX.toFixed(2)
				const y = pointerY.toFixed(2)
				stage.style.setProperty('--x', x)
				stage.style.setProperty('--y', y)
				pointerFrame = 0
			})
		}
		this.root.addEventListener('pointermove', syncPointer)
	}

	bindPowerButton() {
		const powerButton = this.root.querySelector('.power-btn')

		powerButton?.addEventListener('pointerdown', (event) => {
			event.preventDefault()
			this.toggleScreen()
		})

		powerButton?.addEventListener('keydown', (event) => {
			if (event.repeat || (event.key !== 'Enter' && event.key !== ' ')) {
				return
			}

			event.preventDefault()
			this.toggleScreen()
		})
	}

	toggleScreen() {
		if (this.isScreenSleeping) {
			this.wakeScreen()
		}
		else {
			this.sleepScreen()
		}
	}

	sleepScreen() {
		if (this.isScreenSleeping) {
			return
		}

		this.isScreenSleeping = true
		this.root.querySelector('.iphone__screen')?.classList.add('iphone__screen--sleeping')
		this.root.querySelector('.power-btn')?.setAttribute('aria-pressed', 'true')
		this.application?.sleepActiveView?.()
	}

	wakeScreen() {
		if (!this.isScreenSleeping) {
			return
		}

		this.isScreenSleeping = false
		this.root.querySelector('.iphone__screen')?.classList.remove('iphone__screen--sleeping')
		this.root.querySelector('.power-btn')?.setAttribute('aria-pressed', 'false')
		this.application?.wakeActiveView?.()
	}

	// black white
	// 实现 container-sdk 的 shell.updateStatusBarColor 接口（见 createContainer 契约）
	updateStatusBarColor(color) {
		const statusBar = this.root.querySelector('.iphone__status-bar')

		if (color === 'black') {
			statusBar.classList.remove('iphone__status-bar--white')
			statusBar.classList.add('iphone__status-bar--black')
		}
		else if (color === 'white') {
			statusBar.classList.add('iphone__status-bar--white')
			statusBar.classList.remove('iphone__status-bar--black')
		}
	}

	// 实现 container-sdk 的 shell.getStatusBarRect 接口（见 createContainer 契约）
	getStatusBarRect() {
		return this.root.querySelector('.iphone__status-bar').getBoundingClientRect()
	}

	// 只记录当前承载的 Application 实例，供锁屏/亮屏时联动挂起/恢复视图使用；
	// DOM 挂载由 createContainer({ mount: device.appContainer }) 负责，这里不重复处理。
	open(app) {
		this.application = app
	}
}
