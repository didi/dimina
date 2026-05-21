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
		// Web container enables vConsole before the render runtime starts.
		this.iframe.src = `${import.meta.env.BASE_URL}pageFrame.html?vconsole=1`
		this.iframe.name = this.id
		this.event = mitt()
		this.bindBackEvent()
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
		const config = this.opts.configInfo
		const webview = this.el.querySelector('.dimina-native-webview')
		const pageName = this.el.querySelector('.dimina-native-webview__navigation-title')
		const navigationBar = this.el.querySelector('.dimina-native-webview__navigation')
		const leftBtn = this.el.querySelector('.dimina-native-webview__navigation-left-btn')
		const root = this.el.querySelector('.dimina-native-webview__root')

		// 小程序首页没有返回按钮
		if (this.opts.isRoot) {
			leftBtn.style.display = 'none'
		}
		else {
			leftBtn.style.display = 'block'
		}

		if (config.navigationBarTextStyle === 'white') {
			navigationBar.classList.add('dimina-native-webview__navigation--white')
		}
		else {
			navigationBar.classList.add('dimina-native-webview__navigation--black')
		}

		if (config.navigationStyle === 'custom') {
			webview.classList.add('dimina-native-webview--custom-nav')
		}

		root.style.backgroundColor = config.backgroundColor
		navigationBar.style.backgroundColor = config.navigationBarBackgroundColor
		pageName.textContent = config.navigationBarTitleText
	}
}
