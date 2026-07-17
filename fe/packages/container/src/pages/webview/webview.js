import mitt from 'mitt'
import { uuid } from '@/utils/util'
import tpl from './webview.html?raw'
import './webview.scss'

export class WebView {
	constructor(opts) {
		this.opts = opts
		this.id = `webview_${uuid()}`
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
		this.el.innerHTML = tpl
		this.setInitialStyle()
		this.iframe = this.el.querySelector('.dimina-native-webview__window')
		const vConsoleQuery = import.meta.env.DEV ? '?vconsole=1' : ''
		this.iframe.src = `${import.meta.env.BASE_URL}pageFrame.html${vConsoleQuery}`
		this.iframe.name = this.id
		this.event = mitt()
		this.bindBackEvent()
		this.bindHomeEvent()
	}

	async init(callback) {
		await this.frameLoaded()
		const iframeWindow = window.frames[this.iframe.name]

		// 监听渲染线程的消息
		iframeWindow.DiminaRenderBridge.invoke = (msg) => {
			this.event.emit('invoke', msg)
		}

		iframeWindow.DiminaRenderBridge.publish = (msg) => {
			this.event.emit('publish', msg)
		}

		callback?.()
	}

	invoke(handler) {
		this.event.on('invoke', handler)
	}

	publish(handler) {
		this.event.on('publish', handler)
	}

	/**
	 * 容器层向渲染线程发送消息
	 * @param {*} msg
	 */
	postMessage(msg) {
		const iframeWindow = window.frames[this.iframe.name]
		iframeWindow.DiminaRenderBridge.onMessage(msg)
	}

	bindBackEvent() {
		const backBtn = this.el.querySelector('.dimina-native-webview__navigation-left-btn')

		backBtn.onclick = () => {
			this.parent.parent.navigateBack()
		}
	}

	bindHomeEvent() {
		const homeBtn = this.el.querySelector('.dimina-native-webview__navigation-home-btn')

		homeBtn.onclick = () => {
			this.parent.parent.navigateHome()
		}
	}

	/**
	 * 返回首页按钮的显隐。显示判据由 MiniApp.shouldShowHomeButton 统一给出，
	 * wx.hideHomeButton 也经这里隐藏调用页自己的按钮
	 */
	setHomeButtonVisible(visible) {
		const homeBtn = this.el.querySelector('.dimina-native-webview__navigation-home-btn')
		homeBtn.style.display = visible ? 'block' : 'none'
	}

	frameLoaded() {
		return new Promise((resolve) => {
			this.iframe.onload = () => {
				resolve()
			}
		})
	}

	/**
	 * 设置初始化样式: 导航栏、背景色、标题栏
	 */
	setInitialStyle() {
		this.applyPageStyle(this.opts.configInfo, {
			isRoot: this.opts.isRoot,
			showHomeButton: this.opts.showHomeButton === true,
		})
	}

	/**
	 * 应用页面级导航栏/背景样式。幂等：redirectTo 复用当前 webview 承载新页面时
	 * 会用新页面的配置重新调用（同时按新页面身份重算返回首页按钮的显隐）
	 */
	applyPageStyle(config, { isRoot, showHomeButton }) {
		const webview = this.el.querySelector('.dimina-native-webview')
		const pageName = this.el.querySelector('.dimina-native-webview__navigation-title')
		const navigationBar = this.el.querySelector('.dimina-native-webview__navigation')
		const leftBtn = this.el.querySelector('.dimina-native-webview__navigation-left-btn')
		const root = this.el.querySelector('.dimina-native-webview__root')

		// 返回箭头只出现在非栈底页面；返回首页按钮独立判定（homeButton: true 的
		// 内页两者并存，home 键让出左槽紧随箭头之后）
		leftBtn.style.display = isRoot ? 'none' : 'block'
		this.setHomeButtonVisible(showHomeButton === true)
		const homeBtn = this.el.querySelector('.dimina-native-webview__navigation-home-btn')
		homeBtn.classList.toggle(
			'dimina-native-webview__navigation-home-btn--after-back',
			!isRoot && showHomeButton === true,
		)

		navigationBar.classList.remove(
			'dimina-native-webview__navigation--white',
			'dimina-native-webview__navigation--black',
		)
		navigationBar.classList.add(
			config.navigationBarTextStyle === 'white'
				? 'dimina-native-webview__navigation--white'
				: 'dimina-native-webview__navigation--black',
		)

		webview.classList.toggle('dimina-native-webview--custom-nav', config.navigationStyle === 'custom')

		root.style.backgroundColor = config.backgroundColor
		navigationBar.style.backgroundColor = config.navigationBarBackgroundColor
		pageName.textContent = config.navigationBarTitleText
	}
}
