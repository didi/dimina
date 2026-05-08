import tpl from './device.html?raw'
import './device.scss'

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

		this.appContainer = this.root.querySelector('.iphone__apps')
		this.updateDeviceBarColor('black')
		this.updateStatusBarTime()
		this.outerGlow()
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

	outerGlow() {
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

		const syncPointer = ({ x: pointerX, y: pointerY }) => {
			const x = pointerX.toFixed(2)
			const y = pointerY.toFixed(2)
			const xp = (pointerX / window.innerWidth).toFixed(2)
			const yp = (pointerY / window.innerHeight).toFixed(2)
			document.documentElement.style.setProperty('--x', x)
			document.documentElement.style.setProperty('--xp', xp)
			document.documentElement.style.setProperty('--y', y)
			document.documentElement.style.setProperty('--yp', yp)
		}
		document.body.addEventListener('pointermove', syncPointer)
	}

	bindPowerButton() {
		const powerButton = this.root.querySelector('.power-btn')

		powerButton?.addEventListener('click', () => {
			if (this.isScreenSleeping) {
				this.wakeScreen()
			}
			else {
				this.sleepScreen()
			}
		})
	}

	sleepScreen() {
		if (this.isScreenSleeping) {
			return
		}

		this.isScreenSleeping = true
		this.root.querySelector('.iphone__screen')?.classList.add('iphone__screen--sleeping')
		this.application?.sleepActiveView?.()
	}

	wakeScreen() {
		if (!this.isScreenSleeping) {
			return
		}

		this.isScreenSleeping = false
		this.root.querySelector('.iphone__screen')?.classList.remove('iphone__screen--sleeping')
		this.application?.wakeActiveView?.()
	}

	// black white
	updateDeviceBarColor(color) {
		const statusBar = this.root.querySelector('.iphone__status-bar')
		const homeBar = this.root.querySelector('.iphone__home-touch-bar')

		if (color === 'black') {
			statusBar.classList.remove('iphone__status-bar--white')
			statusBar.classList.add('iphone__status-bar--black')

			homeBar.classList.remove('iphone__home-touch-bar--white')
			homeBar.classList.add('iphone__home-touch-bar--black')
		}
		else if (color === 'white') {
			statusBar.classList.add('iphone__status-bar--white')
			statusBar.classList.remove('iphone__status-bar--black')

			homeBar.classList.add('iphone__home-touch-bar--white')
			homeBar.classList.remove('iphone__home-touch-bar--black')
		}
	}

	open(app) {
		this.application = app
		app.parent = this
		this.appContainer.appendChild(app.el)
	}
}
