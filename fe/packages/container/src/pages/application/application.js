import { WAIT_TRANSITION_TIMEOUT_MS } from '@/constants/animation'
import './application.scss'

// 等待下一帧，确保 class 变化触发浏览器重新计算样式后再启动 transition
const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))

// 等待元素上指定 transition property 结束，带超时兜底防止动画未触发时永久阻塞
const waitTransitionEnd = (el, property, timeout = WAIT_TRANSITION_TIMEOUT_MS) =>
	new Promise(resolve => {
		const timer = setTimeout(resolve, timeout)
		const handler = (e) => {
			if (!property || e.propertyName === property) {
				clearTimeout(timer)
				el.removeEventListener('transitionend', handler)
				resolve()
			}
		}
		el.addEventListener('transitionend', handler)
	})

export class Application {
	constructor() {
		this.el = null
		this.window = null
		this.root = null
		this.views = []
		this.rootView = null
		this.parent = null
		this.done = true
		this.isSleeping = false
		this._queue = Promise.resolve() // 操作队列，保证动画串行
		this.init()
	}

	// 队列执行器，确保操作串行
	_enqueue(fn) {
		this._queue = this._queue.then(() => fn())
		return this._queue
	}

	init() {
		this.el = document.createElement('div')
		this.el.classList.add('dimina-application')
		this.window = document.createElement('div')
		this.window.classList.add('dimina-native-window')
		this.el.appendChild(this.window)
	}

	initRootView(view) {
		this.rootView = view
		view.parent = this
		view.el.classList.add('dimina-native-view--instage')
		view.el.style.zIndex = 1
		this.root = view
		this.window.appendChild(view.el)
		view.viewDidLoad()
	}

	async pushView(view) {
		// 防抖
		if (!this.done) {
			return
		}
		this.done = false

		// 在视图栈里找到上一个视图
		const preView = this.views[this.views.length - 1]

		// 当前视图入栈
		view.parent = this
		this.views.push(view)
		view.el.style.zIndex = this.views.length
		view.el.classList.add('dimina-native-view--before-enter')
		this.window.appendChild(view.el)
		view?.viewDidLoad()
		await nextFrame()

		// 上一个视图向左动画推出
		preView.el.classList.remove('dimina-native-view--instage')
		preView.el.classList.add('dimina-native-view--slide-out')
		preView.el.classList.add('dimina-native-view--linear-anima')

		// 当前视图向左动画推入
		view.el.classList.add('dimina-native-view--enter-anima')
		view.el.classList.add('dimina-native-view--instage')
		await waitTransitionEnd(view.el, 'transform')

		// 动画结束之后移出相关class
		preView.el.classList.remove('dimina-native-view--linear-anima')
		view.el.classList.remove('dimina-native-view--before-enter')
		view.el.classList.remove('dimina-native-view--enter-anima')
		view.el.classList.remove('dimina-native-view--instage')

		this.done = true
	}

	async popView() {
		if (this.views.length < 2) {
			return
		}

		if (!this.done) {
			return
		}

		this.done = false

		const preView = this.views[this.views.length - 2]
		const currentView = this.views[this.views.length - 1]

		preView.el.classList.remove('dimina-native-view--slide-out')
		preView.el.classList.add('dimina-native-view--instage')
		preView.el.classList.add('dimina-native-view--enter-anima')

		currentView.el.classList.remove('dimina-native-view--instage')
		currentView.el.classList.add('dimina-native-view--before-enter')
		currentView.el.classList.add('dimina-native-view--enter-anima')

		await waitTransitionEnd(currentView.el, 'transform')
		this.views.pop()
		this.window.removeChild(currentView.el)
		preView.el.classList.remove('dimina-native-view--enter-anima')

		this.done = true
	}

	presentView(view, useCache) {
		return this._enqueue(() => this._presentView(view, useCache))
	}

	async _presentView(view, useCache) {
		if (!this.done) {
			return
		}
		this.done = false

		const preView = this.views[this.views.length - 1]
		view.parent = this
		view.el.style.zIndex = this.views.length + 1
		view.el.classList.add('dimina-native-view--before-present')
		view.el.classList.add('dimina-native-view--enter-anima')
		preView?.el.classList.add('dimina-native-view--before-presenting')
		preView?.el.classList.remove('dimina-native-view--instage')
		preView?.el.classList.add('dimina-native-view--enter-anima')
		preView?.onPresentOut()
		view.onPresentIn()
		!useCache && this.el.appendChild(view.el)
		this.views.push(view)
		!useCache && view.viewDidLoad && view.viewDidLoad()
		if (useCache) {
			view.restoreColorStyle()
		}

		await nextFrame()
		preView?.el.classList.add('dimina-native-view--presenting')
		view.el.classList.add('dimina-native-view--instage')
		await waitTransitionEnd(view.el, 'transform')
		view.el.classList.remove('dimina-native-view--before-present')
		view.el.classList.remove('dimina-native-view--enter-anima')
		preView?.el.classList.remove('dimina-native-view--enter-anima')
		preView?.el.classList.remove('dimina-native-view--before-presenting')

		this.done = true
	}

	dismissView(opts = {}) {
		return this._enqueue(() => this._dismissView(opts))
	}

	async _dismissView(opts = {}) {
		if (!this.done) {
			return
		}
		this.done = false

		const preView = this.views[this.views.length - 2]
		const currentView = this.views[this.views.length - 1]
		// 是否销毁当前的容器
		const { destroy = true } = opts

		currentView.el.classList.add('dimina-native-view--enter-anima')
		preView?.el.classList.add('dimina-native-view--enter-anima')
		preView?.el.classList.add('dimina-native-view--before-presenting')
		await nextFrame()
		currentView.el.classList.add('dimina-native-view--before-present')
		currentView.el.classList.remove('dimina-native-view--instage')
		preView?.el.classList.remove('dimina-native-view--presenting')

		preView?.onPresentIn()
		currentView?.onPresentOut()

		await waitTransitionEnd(currentView.el, 'transform')

		if (destroy) {
			currentView.destroy()
			this.el.removeChild(currentView.el)
		}

		this.views.pop()
		preView?.el.classList.remove('dimina-native-view--enter-anima')
		preView?.el.classList.remove('dimina-native-view--before-presenting')

		this.done = true
	}

	async destroyRootView(view) {
		view.destroy()
		this.el.removeChild(view.el)
	}

	getStatusBarRect() {
		const statusBar = this.parent?.root?.querySelector('.iphone__status-bar')
		if (statusBar) {
			return statusBar.getBoundingClientRect()
		}
		return { height: 0 }
	}

	getActiveView() {
		return this.views[this.views.length - 1] || this.rootView
	}

	sleepActiveView() {
		if (this.isSleeping) {
			return
		}

		this.isSleeping = true
		this.getActiveView()?.onPresentOut?.()
	}

	wakeActiveView() {
		if (!this.isSleeping) {
			return
		}

		this.isSleeping = false
		const activeView = this.getActiveView()
		activeView?.restoreColorStyle?.()
		activeView?.onPresentIn?.()
	}

	updateStatusBarColor(color) {
		this.parent?.updateDeviceBarColor(color)
	}
}
