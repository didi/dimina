import type { Emitter } from 'mitt'
import type { Bridge } from '../../core/bridge.js'
import type { BridgeMessage, RenderFrameWindow } from '../../types.js'
import type { MergedPageConfig } from '../../utils/util.js'
import mitt from 'mitt'
import { uuid } from '../../utils/util.js'
import tpl from './webview.html?raw'
import './webview.scss'

export interface WebViewOptions {
	configInfo: MergedPageConfig
	isRoot: boolean
	pageFrameUrl?: string
	/** 逐 app 覆盖的资源基路径；页面相对路径资源需要相对它而不是容器自身部署路径解析时才传。 */
	resourceBaseUrl?: string
	showHomeButton?: boolean
}

type WebViewEvents = {
	invoke: BridgeMessage
	publish: BridgeMessage
}

export class WebView {
	opts: WebViewOptions
	id: string
	el: HTMLElement
	iframe: HTMLIFrameElement
	event: Emitter<WebViewEvents>
	/** createWebview() 里赋值为发起创建的 Bridge 实例。 */
	parent!: Bridge

	constructor(opts: WebViewOptions) {
		this.opts = opts
		this.id = `webview_${uuid()}`
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
		this.el.innerHTML = tpl
		this.iframe = this.el.querySelector<HTMLIFrameElement>('.dimina-native-webview__window')!
		// 用 URL API 组装而不是裸字符串拼接：传入的 pageFrameUrl 可能自带 query，
		// 裸拼 `?vconsole=1` 会产出双 '?' 的畸形地址；searchParams 追加天然走 '&'。
		const pageFrameUrl = new URL(this.opts.pageFrameUrl ?? '/pageFrame.html', window.location.href)
		if (import.meta.env.DEV) {
			pageFrameUrl.searchParams.set('vconsole', '1')
		}
		this.iframe.src = pageFrameUrl.toString()
		this.iframe.name = this.id
		this.event = mitt<WebViewEvents>()
		this.bindBackEvent()
		this.bindHomeEvent()
		this.applyPageStyle(this.opts.configInfo, {
			isRoot: this.opts.isRoot,
			showHomeButton: this.opts.showHomeButton === true,
		})
	}

	async init(callback?: () => void, signal?: AbortSignal): Promise<void> {
		await this.frameLoaded(signal)
		// window.frames 按名取子窗口是浏览器真实支持的行为，但 lib.dom 只声明了数字索引签名，
		// 这里用 unknown 收窄成按名索引后再断言渲染层挂出的 DiminaRenderBridge 契约。
		const iframeWindow = (window.frames as unknown as Record<string, RenderFrameWindow>)[this.iframe.name]
		this.applyResourceBaseUrl(iframeWindow.document)

		// 监听渲染线程的消息
		iframeWindow.DiminaRenderBridge.invoke = (msg) => {
			this.event.emit('invoke', msg)
		}

		iframeWindow.DiminaRenderBridge.publish = (msg) => {
			this.event.emit('publish', msg)
		}

		callback?.()
	}

	/**
	 * 逐 app 覆盖 resourceBaseUrl 时，靠 <base href> 让渲染 iframe 里的相对路径资源跟着走。
	 * doc.head 理论上总是存在（任何 Document 隐式都有），这里仍判空——测试环境里桩出来的
	 * iframe 文档不走完整 HTML 解析，可能没有 head。
	 */
	applyResourceBaseUrl(doc: Document): void {
		if (!this.opts.resourceBaseUrl || !doc.head) {
			return
		}
		const base = doc.createElement('base')
		base.href = this.opts.resourceBaseUrl
		doc.head.prepend(base)
	}

	invoke(handler: (msg: BridgeMessage) => void): void {
		this.event.on('invoke', handler)
	}

	publish(handler: (msg: BridgeMessage) => void): void {
		this.event.on('publish', handler)
	}

	/**
	 * 容器层向渲染线程发送消息
	 * @param {*} msg
	 */
	postMessage(msg: BridgeMessage): void {
		const iframeWindow = (window.frames as unknown as Record<string, RenderFrameWindow>)[this.iframe.name]
		iframeWindow.DiminaRenderBridge.onMessage(msg)
	}

	bindBackEvent(): void {
		const backBtn = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-left-btn')!

		backBtn.onclick = () => {
			this.parent.parent!.navigateBack()
		}
	}

	bindHomeEvent(): void {
		const homeBtn = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-home-btn')!

		homeBtn.onclick = () => {
			this.parent.parent!.navigateHome()
		}
	}

	/**
	 * 返回首页按钮的显隐。显示判据由 MiniApp.shouldShowHomeButton 统一给出，
	 * wx.hideHomeButton 也经这里隐藏调用页自己的按钮
	 */
	setHomeButtonVisible(visible: boolean): void {
		const homeBtn = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-home-btn')!
		homeBtn.style.display = visible ? 'block' : 'none'
	}

	/**
	 * 等待渲染层 iframe 加载完成。signal 被 abort 时 reject AbortError——
	 * iframe 已经/即将被拆掉，onload 不会再触发，不能让调用方无限期挂起。
	 */
	frameLoaded(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
		}
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				this.iframe.onload = null
				reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'))
			}
			this.iframe.onload = () => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}
			signal?.addEventListener('abort', onAbort, { once: true })
		})
	}

	/**
	 * 应用页面级导航栏/背景样式。幂等：redirectTo 复用当前 webview 时会以新页面配置重新调用。
	 */
	applyPageStyle(config: MergedPageConfig, { isRoot, showHomeButton }: { isRoot: boolean, showHomeButton: boolean }): void {
		const webview = this.el.querySelector<HTMLElement>('.dimina-native-webview')!
		const pageName = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-title')!
		const navigationBar = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation')!
		const leftBtn = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-left-btn')!
		const root = this.el.querySelector<HTMLElement>('.dimina-native-webview__root')!

		// 返回箭头只出现在非栈底页面；返回首页按钮独立判定（homeButton: true 的
		// 内页两者并存，home 键让出左槽紧随箭头之后）
		leftBtn.style.display = isRoot ? 'none' : 'block'
		this.setHomeButtonVisible(showHomeButton === true)
		const homeBtn = this.el.querySelector<HTMLElement>('.dimina-native-webview__navigation-home-btn')!
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
