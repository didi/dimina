import { LAUNCH_SCREEN_MIN_MS, MODAL_GUARD_MS, WAIT_TRANSITION_TIMEOUT_MS } from '@/constants/animation'
import { AppManager } from '@/core/appManager'
import { Bridge } from '@/core/bridge'
import { JSCore } from '@/core/jscore'
import { HashRouter } from '@/utils/hashRouter'
import { mergePageConfig, queryPath, readFile, sleep, uuid } from '@/utils/util'

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
import tpl from './miniApp.html?raw'
import './miniApp.scss'

export class MiniApp {
	constructor(opts) {
		this.appInfo = opts
		this.id = `mini_app_${uuid()}`
		this.parent = null
		this.appId = opts.appId
		this.appConfig = null
		this.bridgeList = []
		this.jscore = new JSCore(this)
		this.webviewsContainer = null
		this.webviewAnimaEnd = true
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
		this.toastInfo = {
			dom: null,
			timer: null,
		}
		this.color = null
		this.apiRegistry = {}
		// 维护第三方扩展的持续订阅，key: `${module}_${event}`，value: unsubscribe 函数
		this._extSubscriptions = new Map();
		this.tabBarConfig = null            // app.tabBar 配置
		this.tabBarPaths = []               // 与 list 等长，pagePath 数组（已规范化、无前导 /）
		this.tabBarBridges = new Map()      // pagePath -> Bridge：懒加载的持久 tab 池
		this.currentTabPath = null          // 当前激活的 tab 路径；null 表示当前不在任何 tab 页
		this.tabBarEl = null                // .dimina-mini-app__tabbar 根节点
		this.tabBarHeight = 0               // TabBar 实际高度，用于给 tab 页 webview 单独预留底部空间
		// showModal 用 LIFO stack：后来的 modal 压在前一个之上（z-index 递增），
		// 关闭顶上 modal 露出下方；前后 modal 互不干扰，各自 success/complete 独立。
		this._modalStack = []
		this._modalPendingTimers = new Set()
		this._destroyed = false
	}

	/**
	 * 规范化 pagePath：去除前导 /，与 app.tabBar.list 中声明的格式对齐。
	 */
	_normalizePagePath(path) {
		if (!path) return ''
		return path.startsWith('/') ? path.slice(1) : path
	}

	/**
	 * 判断给定路径是否为 tabBar 页面。
	 */
	_isTabBarPage(pagePath) {
		return this.tabBarPaths.includes(this._normalizePagePath(pagePath))
	}

	getCurrentPagePath() {
		const currentBridge = this.bridgeList[this.bridgeList.length - 1]
		return currentBridge?.opts?.pagePath || this.appInfo.pagePath || this.appConfig?.app?.entryPagePath || ''
	}

	getCurrentPageQuery() {
		const currentBridge = this.bridgeList[this.bridgeList.length - 1]
		return currentBridge?.opts?.query || this.appInfo.query || {}
	}

	getEntryPagePath() {
		return this.appInfo.pagePath || this.appConfig?.app?.entryPagePath || ''
	}

	async copyText(text, successText) {
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text)
			}
			else {
				const textarea = document.createElement('textarea')
				textarea.value = text
				textarea.setAttribute('readonly', 'readonly')
				textarea.style.position = 'fixed'
				textarea.style.opacity = '0'
				document.body.appendChild(textarea)
				textarea.select()
				document.execCommand('copy')
				document.body.removeChild(textarea)
			}
			this.showToast({
				title: successText,
				icon: 'success',
			})
		}
		catch {
			this.showToast({
				title: '复制失败',
				icon: 'none',
			})
		}
	}

	closeMiniProgram() {
		HashRouter.clear()
		this.closeMiniAppMenu()
		AppManager.closeApp(this)
	}

	renderMiniAppMenu() {
		const name = this.el.querySelector('.dimina-mini-app-menu__app-name')
		const appId = this.el.querySelector('.dimina-mini-app-menu__app-id')
		const desc = this.el.querySelector('.dimina-mini-app-menu__app-desc')
		const logo = this.el.querySelector('.dimina-mini-app-menu__app-logo-img')
		const quickActions = this.el.querySelector('.dimina-mini-app-menu__quick-actions')
		const currentPagePath = this.getCurrentPagePath()
		const entryPagePath = this.getEntryPagePath()
		const currentPageQuery = this.getCurrentPageQuery()
		const pagePath = currentPagePath || entryPagePath || ''
		const addressUrl = HashRouter.buildRouteURL(this.appId, [
			{ pagePath: entryPagePath, query: this.appInfo.query || {} },
			{ pagePath, query: currentPageQuery },
		])

		name.textContent = this.appInfo.name || '未命名小程序'
		appId.textContent = `AppID：${this.appId || '--'}`
		desc.textContent = `当前页面：${pagePath || '--'}`
		logo.src = this.appInfo.logo || ''

		const quickActionItems = [
			{
				label: '复制链接',
				icon: '↗',
				handler: () => this.copyText(addressUrl, '链接已复制'),
			},
			{
				label: '重新进入',
				icon: '↻',
				handler: () => {
					this.closeMiniAppMenu()
					this.reLaunch({
						url: entryPagePath || currentPagePath,
					})
				},
			},
			{
				label: '关闭小程序',
				icon: '×',
				danger: true,
				handler: () => this.closeMiniProgram(),
			},
		]

		quickActions.innerHTML = quickActionItems
			.map((item, index) => `
				<button type="button" class="dimina-mini-app-menu__quick-action${item.danger ? ' is-danger' : ''}" data-quick-index="${index}">
					<span class="dimina-mini-app-menu__quick-action-icon">${item.icon}</span>
					<span class="dimina-mini-app-menu__quick-action-label">${item.label}</span>
				</button>
			`)
			.join('')

		quickActions.querySelectorAll('[data-quick-index]').forEach((node, index) => {
			node.onclick = () => quickActionItems[index].handler()
		})
	}

	openMiniAppMenu() {
		const overlay = this.el.querySelector('.dimina-mini-app-menu__mask')
		const menu = this.el.querySelector('.dimina-mini-app-menu')
		this.renderMiniAppMenu()
		overlay.style.display = 'block'
		requestAnimationFrame(() => {
			overlay.classList.add('show')
			menu.classList.add('show')
		})
	}

	closeMiniAppMenu() {
		const overlay = this.el.querySelector('.dimina-mini-app-menu__mask')
		const menu = this.el.querySelector('.dimina-mini-app-menu')
		overlay.classList.remove('show')
		menu.classList.remove('show')
	}

	/**
	 * 注册自定义 API 处理函数
	 * @param {string} name API 名称
	 * @param {function} handler 处理函数，接收 (params)
	 */
	registerApi(name, handler) {
		this.apiRegistry[name] = handler
	}

	/**
	 * 按名称调用 API，优先查找自定义注册 → 内置方法 → 第三方扩展路由
	 * @param {string} name API 名称
	 * @param {object} params API 参数
	 */
	invokeApi(name, params) {
		const handler = this.apiRegistry[name]
		if (handler) {
			handler.call(this, params)
		}
		else if (typeof this[name] === 'function') {
			this[name](params)
		}
		else {
			// 未命中已知方法，转发给第三方扩展路由处理
			this._handleExtCall(name, params)
		}
	}

	viewDidLoad() {
		this.initPageFrame()
		this.webviewsContainer = this.el.querySelector('.dimina-mini-app__webviews')
		this.showLaunchScreen()
		this.bindMoreEvent()
		this.bindCloseEvent()
		this.initApp()
	}

	async initApp() {
		// 1. 等待逻辑线程初始化
		await this.jscore.init()

		// 2. 读取配置文件，同时保证 LaunchScreen 最少展示一个略长于 present 的时长
		const root = 'main'
		const configPath = `${this.appInfo.appId}/${root}/app-config.json`
		const [configContent] = await Promise.all([
			readFile(`${import.meta.env.BASE_URL}${configPath}`),
			sleep(LAUNCH_SCREEN_MIN_MS),
		])

		if (!configContent) {
			return
		}

		this.appConfig = JSON.parse(configContent)

		// 缓存 tabBar 配置（list、color 等），并渲染 tabBar 容器；后续仅做选中态/可见性切换
		this._initTabBar()

		const entryPagePath = this.appInfo.pagePath || this.appConfig.app.entryPagePath

		// 4. 读取页面配置
		const pageConfig = this.appConfig.modules[entryPagePath]
		const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)

		// 5. 设置状态栏的颜色模式
		this.updateTargetPageColorStyle(mergeConfig)

		// 6. 创建通信 bridge
		const entryPageBridge = await this.createBridge({
			pagePath: entryPagePath,
			query: this.appInfo.query,
			scene: this.appInfo.scene,
			jscore: this.jscore,
			isRoot: true,
			root,
			appId: this.appInfo.appId,
			pages: this.appConfig.app.pages,
			configInfo: mergeConfig,
		})

		this.bridgeList.push(entryPageBridge)

		// 入口若是 tab 页：登记到 tab 池并设为当前 tab、显示 TabBar
		if (this._isTabBarPage(entryPagePath)) {
			const normalizedPath = this._normalizePagePath(entryPagePath)
			this.tabBarBridges.set(normalizedPath, entryPageBridge)
			this.currentTabPath = normalizedPath
			this._setTabBarVisible(true)
			this._updateTabBarSelection(normalizedPath)
		}

		entryPageBridge.start()

		// 7. 若携带额外的恢复栈（刷新后恢复场景），静默重建后续页面
		if (this.appInfo.restoreStack && this.appInfo.restoreStack.length > 1) {
			await this.restorePageStack(this.appInfo.restoreStack.slice(1))
		}

		this._syncHash()

		// 8. 隐藏 loading
		this.hideLaunchScreen()
	}

	/**
	 * 静默恢复页面栈中根页之后的页面。
	 * 这些页面的 bridge 会被初始化并推入 bridgeList，但不播放入场动画，
	 * 当前页显示在最顶层，之前的页面以 slide-out 状态保留在 DOM 中，
	 * 使后退按钮可以正常工作。
	 * @param {Array<{pagePath: string, query: object}>} pages
	 */
	async restorePageStack(pages) {
		for (let i = 0; i < pages.length; i++) {
			const { pagePath: rawPagePath, query } = pages[i]
			const isTop = i === pages.length - 1

			// 规范化路径：去掉前导 /，与 app-config.json modules key 保持一致
			const pagePath = rawPagePath.startsWith('/') ? rawPagePath.slice(1) : rawPagePath
			// pageConfig 可能为空（该小程序所有页面共用 app.window 默认配置），
			// mergePageConfig 支持 pageConfig 为 undefined，直接降级到 app 全局配置
			const pageConfig = this.appConfig.modules[pagePath]
			const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)

			const bridge = await this.createBridge({
				pagePath,
				query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: false,
				root: pageConfig?.root || 'main',
				appId: this.appInfo.appId,
				pages: this.appConfig.app.pages,
				configInfo: mergeConfig,
			})

			// 将上一个页面移到 slide-out 状态（不可见但保留在栈中，支持后退）
			const prevBridge = this.bridgeList[this.bridgeList.length - 1]
			prevBridge.webview.el.classList.remove('dimina-native-view--instage')
			prevBridge.webview.el.classList.add('dimina-native-view--slide-out')

			this.bridgeList.push(bridge)
			bridge.webview.el.style.zIndex = this.bridgeList.length + 1

			// 移除 before-enter（translateX 100%），让页面回到正常位置
			bridge.webview.el.classList.remove('dimina-native-view--before-enter')
			if (!isTop) {
				// 中间页面再叠加 slide-out，被上层页面覆盖
				bridge.webview.el.classList.add('dimina-native-view--slide-out')
			}

			bridge.start()
		}

		if (pages.length > 0) {
			// 最顶层页面更新状态栏颜色
			const topBridge = this.bridgeList[this.bridgeList.length - 1]
			const topPageConfig = this.appConfig.modules[topBridge.opts.pagePath]
			const topMergeConfig = mergePageConfig(this.appConfig.app, topPageConfig)
			this.updateTargetPageColorStyle(topMergeConfig)

			// 恢复后栈顶为非 tab 页：隐藏 TabBar（tab bridge 仍保留在 pool 中以备后退恢复）
			if (!this._isTabBarPage(topBridge.opts.pagePath)) {
				this._setTabBarVisible(false)
			}
		}
	}

	/**
	 * 将当前 bridgeList 序列化到 URL query，用于刷新后恢复入口页与当前页。
	 * pagePath 统一去掉前导 /，与 app-config.json modules key 保持一致。
	 */
	_syncHash() {
		const stack = this.bridgeList.map((b) => {
			const pagePath = b.opts.pagePath.startsWith('/') ? b.opts.pagePath.slice(1) : b.opts.pagePath
			return { pagePath, query: b.opts.query || {} }
		})
		HashRouter.syncStack(this.appId, stack)
	}

	// 创建一个bridge对象
	async createBridge(opts) {
		const { jscore, configInfo, isRoot, appId, pagePath, query, scene, pages, root } = opts
		const bridge = new Bridge({
			jscore,
			configInfo,
			isRoot,
			appId,
			pagePath,
			query,
			scene,
			pages,
			root,
		})

		bridge.parent = this
		await bridge.init()
		return bridge
	}

	onPresentIn() {
		const currentBridge = this.bridgeList[this.bridgeList.length - 1]
		// 首次异步创建时， bridge 不存在，会在[Service]自行调用 invokeInitLifecycle
		currentBridge?.appShow()
		currentBridge?.pageShow()
	}

	onPresentOut() {
		const currentBridge = this.bridgeList[this.bridgeList.length - 1]

		currentBridge?.appHide()
		currentBridge?.pageHide()
	}

	initPageFrame() {
		this.el.innerHTML = tpl
	}

	// 设置指定页面状态栏的颜色模式
	updateTargetPageColorStyle(mergeConfig) {
		const { navigationBarTextStyle } = mergeConfig
		this.updateActionColorStyle(navigationBarTextStyle)
	}

	showLaunchScreen() {
		const launchScreen = this.el.querySelector('.dimina-mini-app__launch-screen')
		const name = this.el.querySelector('.dimina-mini-app__name')
		const logo = this.el.querySelector('.dimina-mini-app__logo-img-url')

		this.updateActionColorStyle('black')
		name.innerHTML = this.appInfo.name
		logo.src = this.appInfo.logo
		launchScreen.style.display = 'block'
	}

	hideLaunchScreen() {
		const startPage = this.el.querySelector('.dimina-mini-app__launch-screen')
		startPage.style.display = 'none'
	}

	updateActionColorStyle(color) {
		this.color = color
		const action = this.el.querySelector('.dimina-mini-app-navigation__actions')

		if (color === 'white') {
			action.classList.remove('dimina-mini-app-navigation__actions--black')
			action.classList.add('dimina-mini-app-navigation__actions--white')
		}
		else if (color === 'black') {
			action.classList.remove('dimina-mini-app-navigation__actions--white')
			action.classList.add('dimina-mini-app-navigation__actions--black')
		}

		this.parent.updateStatusBarColor(color)
	}

	restoreColorStyle() {
		this.updateActionColorStyle(this.color)
	}

	createCallbackFunction(funcId) {
		if (funcId) {
			return (args) => {
				this.jscore.postMessage({
					type: 'triggerCallback',
					body: {
						id: funcId,
						args,
					},
				})
			}
		}
	}

	async navigateTo(opts) {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		// 微信规范：navigateTo 不允许跳转到 tabBar 页面
		if (this._isTabBarPage(pagePath)) {
			onFail?.({ errMsg: `navigateTo:fail can not navigateTo a tabbar page` })
			onComplete?.()
			return
		}

		// 防抖处理
		if (!this.webviewAnimaEnd) {
			return
		}
		this.webviewAnimaEnd = false

		const pageConfig = this.appConfig.modules[pagePath]
		const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)
		// 更新状态栏颜色模式
		this.updateTargetPageColorStyle(mergeConfig)

		// 创建新的入口页面的 bridge
		const bridge = await this.createBridge({
			pagePath,
			query,
			scene: this.appInfo.scene,
			jscore: this.jscore,
			isRoot: false,
			root: pageConfig?.root || 'main',
			appId: this.appInfo.appId,
			pages: this.appConfig.app.pages,
			configInfo: mergeConfig,
		})

		// 获取前一个bridge
		const preBridge = this.bridgeList[this.bridgeList.length - 1]
		const preWebview = preBridge.webview

		this.bridgeList.push(bridge)

		// 触发新页面的初始化逻辑
		bridge.start()
		this._syncHash()

		// 上一个页面推出
		preWebview.el.classList.remove('dimina-native-view--instage')
		preWebview.el.classList.add('dimina-native-view--slide-out')
		preWebview.el.classList.add('dimina-native-view--linear-anima')
		preBridge?.pageHide()

		this._setTabBarVisible(false)

		// 新页面推入
		bridge.webview.el.style.zIndex = this.bridgeList.length + 1
		bridge.webview.el.classList.add('dimina-native-view--enter-anima')
		bridge.webview.el.classList.add('dimina-native-view--instage')
		await waitTransitionEnd(bridge.webview.el, 'transform')

		// 页面进入后移出动画相关class
		this.webviewAnimaEnd = true
		preWebview.el.classList.remove('dimina-native-view--linear-anima')
		bridge.webview.el.classList.remove('dimina-native-view--before-enter')
		bridge.webview.el.classList.remove('dimina-native-view--enter-anima')
		bridge.webview.el.classList.remove('dimina-native-view--instage')

		onSuccess?.({ errMsg: 'navigateTo:ok' })
		onComplete?.()
	}

	reLaunch(opts) {
		// 防抖处理
		if (!this.webviewAnimaEnd) {
			return
		}
		this.webviewAnimaEnd = false

		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			// 检查页面路径是否存在
			const pageConfig = this.appConfig.modules[pagePath]
			// 合并页面配置
			const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)

			// 更新状态栏颜色模式
			this.updateTargetPageColorStyle(mergeConfig)

			// 销毁所有现有的 bridge：合并 stack 与 tab 池（用 Set 去重）
			const allBridges = new Set([...this.bridgeList, ...this.tabBarBridges.values()])
			for (const bridge of allBridges) {
				bridge.destroy()
				bridge.webview?.el?.remove()
			}
			this.bridgeList.length = 0
			this.tabBarBridges.clear()
			this.currentTabPath = null

			// 清空 webviews 容器
			if (this.webviewsContainer) {
				this.webviewsContainer.innerHTML = ''
			}

			// 创建新的入口页面的 bridge
			this.createBridge({
				pagePath,
				query,
				scene: this.appInfo.scene,
				jscore: this.jscore,
				isRoot: true, // 作为根页面
				root: pageConfig?.root || 'main',
				appId: this.appInfo.appId,
				pages: this.appConfig.app.pages,
				configInfo: mergeConfig,
			}).then((bridge) => {
				// 添加到 bridgeList
				this.bridgeList.push(bridge)

				// 入口若是 tab 页：登记到 pool 并显示 TabBar
				if (this._isTabBarPage(pagePath)) {
					const normalizedPath = this._normalizePagePath(pagePath)
					this.tabBarBridges.set(normalizedPath, bridge)
					this.currentTabPath = normalizedPath
					this._setTabBarVisible(true)
					this._updateTabBarSelection(normalizedPath)
				}
				else {
					this._setTabBarVisible(false)
				}

				// 启动新页面
				bridge.start()
				this._syncHash()

				// 设置 z-index
				bridge.webview.el.style.zIndex = 1

				// 恢复动画状态
				this.webviewAnimaEnd = true

				// 调用成功回调
				onSuccess?.({ errMsg: 'reLaunch:ok' })
				onComplete?.()
			}).catch((error) => {
				onFail?.({ errMsg: `reLaunch:fail ${error.message}` })
				onComplete?.()
				this.webviewAnimaEnd = true
			})
		}
		catch (error) {
			onFail?.({ errMsg: `reLaunch:fail ${error.message}` })
			onComplete?.()
			this.webviewAnimaEnd = true
		}
	}

	applyUpdate() {
		this.reLaunch({
			url: this.getEntryPagePath(),
		})
	}

	redirectTo(opts) {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		// 微信规范：redirectTo 不允许跳转到 tabBar 页面
		if (this._isTabBarPage(pagePath)) {
			onFail?.({ errMsg: `redirectTo:fail can not redirectTo a tabbar page` })
			onComplete?.()
			return
		}

		// 防抖处理
		if (!this.webviewAnimaEnd) {
			return
		}
		this.webviewAnimaEnd = false

		// 获取当前 bridge
		const curBridge = this.bridgeList[this.bridgeList.length - 1]
		const prevPath = this._normalizePagePath(curBridge.opts.pagePath)
		const pageConfig = this.appConfig.modules[pagePath]
		const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)

		this.updateTargetPageColorStyle(mergeConfig)
		// 更新 bridge
		curBridge.destroy()
		curBridge.opts = {
			...curBridge.opts,
			pagePath,
			query,
			configInfo: mergeConfig,
		}
		curBridge.resetStatus()
		curBridge.start()
		this._syncHash()

		// redirectTo 的目标按规范不能是 tab 页：若被替换的是当前 tab 页，需从 pool 中移除并隐藏 TabBar
		if (this.tabBarBridges.get(prevPath) === curBridge) {
			this.tabBarBridges.delete(prevPath)
			if (this.currentTabPath === prevPath) {
				this.currentTabPath = null
			}
		}
		this._setBridgeTabBarInset(curBridge, false)
		this._setTabBarVisible(false)

		this.webviewAnimaEnd = true
		onSuccess?.({ errMsg: 'redirectTo:ok' })
		onComplete?.()
	}

	async navigateBack() {
		if (this.bridgeList.length < 2) {
			return
		}

		if (!this.webviewAnimaEnd) {
			return
		}

		this.webviewAnimaEnd = false

		const currentBridge = this.bridgeList.pop()
		const preBridge = this.bridgeList[this.bridgeList.length - 1]

		const pageConfig = this.appConfig.modules[preBridge.opts.pagePath]
		const mergeConfig = mergePageConfig(this.appConfig.app, pageConfig)

		// 更新状态栏颜色模式
		this.updateTargetPageColorStyle(mergeConfig)

		// 当前页面推出
		currentBridge.webview.el.classList.add('dimina-native-view--before-enter')
		currentBridge.webview.el.classList.add('dimina-native-view--enter-anima')

		// 触发当前页面的生命周期函数
		currentBridge?.destroy()

		// 上一个页面推入
		preBridge.webview.el.classList.remove('dimina-native-view--slide-out')
		preBridge.webview.el.classList.add('dimina-native-view--instage')
		preBridge.webview.el.classList.add('dimina-native-view--enter-anima')

		// 触发上一个页面的生命周期函数
		preBridge?.pageShow()
		this._syncHash()

		// 后退到 tab 页：恢复 TabBar 可见 + 选中态
		if (this._isTabBarPage(preBridge.opts.pagePath)) {
			const path = this._normalizePagePath(preBridge.opts.pagePath)
			this.currentTabPath = path
			this._setTabBarVisible(true)
			this._updateTabBarSelection(path)
		}

		await waitTransitionEnd(preBridge.webview.el, 'transform')
		this.webviewAnimaEnd = true

		// 页面进入后移出动画相关class
		preBridge.webview.el.classList.remove('dimina-native-view--enter-anima')
		preBridge.webview.el.classList.remove('dimina-native-view--instage')
		currentBridge.webview.el.parentNode.removeChild(currentBridge.webview.el)
	}

	/**
	 * 跳转到 tabBar 页面，并关闭其他所有非 tabBar 页面。
	 * 参考鸿蒙 DMPNavigator.switchTab + DMPTabBarContainerView 的“按需创建 + 持久缓存”模型：
	 *   1. 弹出并销毁所有非 tab 页面
	 *   2. 隐藏旧 tab 的 iframe（保留在 pool 中）
	 *   3. 目标 tab 已在 pool → 复用；否则懒加载新建并入池
	 *   4. 切换生命周期：旧 pageHide / 新 pageShow
	 *   5. 更新 TabBar 选中态、状态栏颜色、URL hash
	 */
	async switchTab(opts) {
		const { url, success, fail, complete } = opts
		const { query, pagePath } = queryPath(url)
		const targetPath = this._normalizePagePath(pagePath)
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		if (!this._isTabBarPage(targetPath)) {
			onFail?.({ errMsg: `switchTab:fail not a tabBar page: ${targetPath}` })
			onComplete?.()
			return
		}

		// 防抖处理：避免与 navigateTo / navigateBack 动画并发
		if (!this.webviewAnimaEnd) {
			onFail?.({ errMsg: 'switchTab:fail busy' })
			onComplete?.()
			return
		}

		// 命中当前 tab：仅更新选中态 + 显示
		if (this.currentTabPath === targetPath && this.bridgeList.length === 1) {
			this._setTabBarVisible(true)
			this._updateTabBarSelection(targetPath)
			onSuccess?.({ errMsg: 'switchTab:ok' })
			onComplete?.()
			return
		}

		this.webviewAnimaEnd = false

		try {
			const prevPath = this.currentTabPath;
            const prevTabBridge = prevPath
                ? this.tabBarBridges.get(prevPath)
                : null;
            const wasPrevTabVisible =
                !!prevTabBridge &&
                this.bridgeList.length === 1 &&
                this.bridgeList[0] === prevTabBridge;

            // 1. 隐藏 / 卸载非 tab 页面（从栈顶往下，遇到 tab 页停止）
            while (this.bridgeList.length > 0) {
                const top = this.bridgeList[this.bridgeList.length - 1];
                if (this._isTabBarPage(top.opts.pagePath)) {
                    break;
                }
                top.pageHide();
                top.destroy();
                top.webview?.el?.remove();
                this.bridgeList.pop();
            }

            // 2. 隐藏旧 tab 的 iframe（保留在 pool 中），栈顶若是旧 tab 则弹出（不销毁）
            if (
                prevTabBridge &&
                prevTabBridge !== this.tabBarBridges.get(targetPath)
            ) {
                if (wasPrevTabVisible) {
                    prevTabBridge.pageHide();
                }
                if (prevTabBridge.webview?.el) {
                    prevTabBridge.webview.el.style.display = "none";
                }
                const idx = this.bridgeList.indexOf(prevTabBridge);
                if (idx >= 0) {
                    this.bridgeList.splice(idx, 1);
                }
            }

			// 3. 取出 / 懒加载目标 tab
			let targetBridge = this.tabBarBridges.get(targetPath)
			const targetPageConfig = this.appConfig.modules[targetPath]
			const targetMergeConfig = mergePageConfig(this.appConfig.app, targetPageConfig)
			this.updateTargetPageColorStyle(targetMergeConfig)

			if (!targetBridge) {
				targetBridge = await this.createBridge({
					pagePath: targetPath,
					query,
					scene: this.appInfo.scene,
					jscore: this.jscore,
					isRoot: true,
					root: targetPageConfig?.root || 'main',
					appId: this.appInfo.appId,
					pages: this.appConfig.app.pages,
					configInfo: targetMergeConfig,
				})
				this.tabBarBridges.set(targetPath, targetBridge)
				targetBridge.start()
			}

			// 4. 显示目标 tab：清理动画类、重置 z-index、display
			const targetEl = targetBridge.webview.el
			this._setBridgeTabBarInset(targetBridge, true)
			targetEl.classList.remove(
				'dimina-native-view--before-enter',
				'dimina-native-view--slide-out',
				'dimina-native-view--enter-anima',
				'dimina-native-view--linear-anima',
				'dimina-native-view--instage',
			)
			targetEl.style.display = ''
			targetEl.style.zIndex = 1

			// 5. 入栈（若不在），更新当前 tab，触发 pageShow
			if (!this.bridgeList.includes(targetBridge)) {
				this.bridgeList.push(targetBridge)
			}
			this.currentTabPath = targetPath
			targetBridge.pageShow()

			// 6. UI / 状态同步
			this._setTabBarVisible(true)
			this._updateTabBarSelection(targetPath)
			this._syncHash()

			onSuccess?.({ errMsg: 'switchTab:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `switchTab:fail ${error.message}` })
		}
		finally {
			this.webviewAnimaEnd = true
			onComplete?.()
		}
	}

	/**
	 * 解析并缓存 tabBar 配置；首次渲染 TabBar DOM（默认隐藏）。
	 * 后续切换仅通过 _setTabBarVisible / _updateTabBarSelection 调整，不重渲染。
	 */
	_initTabBar() {
		const tabBar = this.appConfig?.app?.tabBar
		if (!tabBar || !Array.isArray(tabBar.list) || tabBar.list.length === 0) {
			return
		}
		this.tabBarConfig = tabBar
		this.tabBarPaths = tabBar.list.map(item => this._normalizePagePath(item.pagePath))
		this._renderTabBar()
	}

	/**
	 * 一次性渲染 TabBar DOM，使用事件委托处理点击。
	 */
	_renderTabBar() {
		this.tabBarEl = this.el.querySelector('.dimina-mini-app__tabbar')
		if (!this.tabBarEl) return

		const { color, backgroundColor, borderStyle, list } = this.tabBarConfig
		const normalColor = this._sanitizeCssColor(color) || '#999999'
		const bg = this._sanitizeCssColor(backgroundColor) || '#ffffff'
		const borderColor = borderStyle === 'white' ? '#FFFFFF' : '#E0E0E0'

		// 用 DOM API 构建，避免 innerHTML 拼接被配置中的引号 / HTML 片段污染宿主 DOM
		this.tabBarEl.textContent = ''
		const tabbar = document.createElement('div')
		tabbar.className = 'dimina-tabbar'
		tabbar.style.backgroundColor = bg
		tabbar.style.borderTop = `0.5px solid ${borderColor}`

		list.forEach((item, index) => {
			const path = this._normalizePagePath(item.pagePath)

			const itemEl = document.createElement('div')
			itemEl.className = 'dimina-tabbar-item'
			itemEl.dataset.path = path
			itemEl.dataset.index = String(index)

			const defaultIconUrl = this._resolveTabBarIcon(item.iconPath)
			if (defaultIconUrl) {
				itemEl.appendChild(this._createTabBarIcon(defaultIconUrl, 'dimina-tabbar-icon-default'))
			}
			const selectedIconUrl = this._resolveTabBarIcon(item.selectedIconPath)
			if (selectedIconUrl) {
				itemEl.appendChild(this._createTabBarIcon(selectedIconUrl, 'dimina-tabbar-icon-selected'))
			}

			const text = document.createElement('span')
			text.className = 'dimina-tabbar-text'
			text.style.color = normalColor
			text.textContent = item.text || ''
			itemEl.appendChild(text)

			tabbar.appendChild(itemEl)
		})

		this.tabBarEl.appendChild(tabbar)

		// 事件委托：单一监听器处理所有 tab 项点击
		this.tabBarEl.addEventListener('click', (e) => {
			const item = e.target.closest('.dimina-tabbar-item')
			if (!item) return
			const path = item.dataset.path
			if (path && path !== this.currentTabPath) {
				this.switchTab({ url: `/${path}` })
			}
		})

		// 监听 TabBar 实际高度（含 safe-area-inset-bottom）变化，
		// 并同步到所有 tab 页 webview，避免硬编码与样式漂移
		if (typeof ResizeObserver !== 'undefined') {
			this._tabBarResizeObserver?.disconnect()
			this._tabBarResizeObserver = new ResizeObserver(() => this._syncTabBarHeightVar())
			this._tabBarResizeObserver.observe(this.tabBarEl)
		}
	}

	/**
	 * 创建一张 tabBar 图标 <img>，带加载失败兜底（隐藏，避免破图占位）。
	 */
	_createTabBarIcon(src, modifierClass) {
		const img = document.createElement('img')
		img.className = `dimina-tabbar-icon ${modifierClass}`
		img.src = src
		img.alt = ''
		img.addEventListener('error', () => {
			img.style.display = 'none'
		})
		return img
	}

	/**
	 * 简单 CSS 颜色白名单：#hex / rgb(a)/hsl(a)/常见关键字。
	 * 拒绝包含尖括号、引号、分号、url() 等可能逃逸 style 上下文的字符；
	 * 不命中白名单时返回空串，让调用方走默认色。
	 */
	_sanitizeCssColor(value) {
		if (!value || typeof value !== 'string') return ''
		const v = value.trim()
		if (v.length === 0 || v.length > 64) return ''
		// 任意 url()/expression()/HTML 注入尝试都会包含下面的字符
		if (/[<>"';{}()\\]/.test(v)) {
			// 兼容 rgb(a)/hsl(a) 函数：仅放行严格匹配的形态
			if (/^(?:rgb|rgba|hsl|hsla)\(\s*[\d.,%\s/-]+\)$/i.test(v)) {
				return v
			}
			return ''
		}
		return v
	}

	/**
	 * 获取 TabBar 实际高度。隐藏状态下临时不可见测量一次，避免首次 switchTab
	 * 到 tab 页时缺少底部留白。
	 */
	_getTabBarHeight() {
		if (!this.tabBarEl) return this.tabBarHeight

		let height = this.tabBarEl.getBoundingClientRect().height
		if (!height && this.tabBarEl.style.display === 'none') {
			const oldDisplay = this.tabBarEl.style.display
			const oldVisibility = this.tabBarEl.style.visibility

			this.tabBarEl.style.visibility = 'hidden'
			this.tabBarEl.style.display = 'block'
			height = this.tabBarEl.getBoundingClientRect().height
			this.tabBarEl.style.display = oldDisplay
			this.tabBarEl.style.visibility = oldVisibility
		}

		if (height > 0) {
			this.tabBarHeight = height
		}
		return this.tabBarHeight
	}

	/**
	 * 把 TabBar 当前实际高度同步到 CSS 变量和 tab 页 webview。
	 * webviews 容器保持全屏，只有 tab 页自身预留底部空间；这样隐藏
	 * tabbar 跳转到非 tab 页时，不会触发所有页面整体重排。
	 */
	_syncTabBarHeightVar() {
		const height = this._getTabBarHeight()
		this.el.style.setProperty('--dimina-tabbar-height', `${height}px`)
		this._syncTabBarBridgeInsets()
	}

	_setBridgeTabBarInset(bridge, enabled) {
		const webviewEl = bridge?.webview?.el
		if (!webviewEl) return

		if (!enabled) {
			webviewEl.style.removeProperty('bottom')
			return
		}

		webviewEl.style.bottom = `${this._getTabBarHeight()}px`
	}

	_syncTabBarBridgeInsets() {
		for (const bridge of this.tabBarBridges.values()) {
			this._setBridgeTabBarInset(bridge, true)
		}
	}

	_joinBaseUrl(...segments) {
		const baseUrl = import.meta.env.BASE_URL || '/'
		const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
		const path = segments
			.map(segment => String(segment).trim().replace(/^\/+|\/+$/g, ''))
			.filter(Boolean)
			.join('/')
		return `${normalizedBaseUrl}${path}`
	}

	/**
	 * 解析 tabBar 图标路径。
	 * 编译期 collectAssets 会输出 appId/main/static/...，本地源路径则按小程序
	 * 根目录兜底到 appId/main/...，两类路径都统一挂到 Vite BASE_URL 下。
	 */
	_resolveTabBarIcon(iconPath) {
		if (!iconPath || typeof iconPath !== 'string') return null

		const rawPath = iconPath.trim()
		if (!rawPath) return null

		// 已是完整 URL / data 协议 / 协议无关路径：保持原值
		if (/^(?:data:|blob:|https?:|\/\/)/i.test(rawPath)) {
			return rawPath
		}

		const localPath = rawPath.replace(/^\/+/, '').replace(/^\.\//, '')
		const appRootPrefix = `${this.appId}/`
		if (localPath.startsWith(appRootPrefix)) {
			return this._joinBaseUrl(localPath)
		}

		// 兜底：用户配置里仍是包内相对路径（未走 collectAssets 改写或拷贝失败）
		return this._joinBaseUrl(this.appId, 'main', localPath)
	}

	/**
	 * 控制 TabBar 容器的显示/隐藏。底部留白只作用在 tab 页 webview 上，
	 * 避免非 tab 跳转过程中改变 webviews 容器高度。
	 */
	_setTabBarVisible(visible) {
		if (!this.tabBarEl) return
		this.tabBarEl.style.display = visible ? 'block' : 'none'
		// display 切换通常不会触发 ResizeObserver，主动同步一次
		this._syncTabBarHeightVar()
	}

	/**
	 * 仅更新 TabBar 选中态（颜色 / 图标 / class），不重渲染。
	 */
	_updateTabBarSelection(currentPath) {
		if (!this.tabBarEl || !this.tabBarConfig) return
		const normalColor = this.tabBarConfig.color || '#999999'
		const selectedColor = this.tabBarConfig.selectedColor || '#1890ff'

		this.tabBarEl.querySelectorAll('.dimina-tabbar-item').forEach((item) => {
			const path = item.getAttribute('data-path')
			const isSelected = path === currentPath
			const text = item.querySelector('.dimina-tabbar-text')
			const defaultIcon = item.querySelector('.dimina-tabbar-icon-default')
			const selectedIcon = item.querySelector('.dimina-tabbar-icon-selected')

			if (text) text.style.color = isSelected ? selectedColor : normalColor
			if (defaultIcon) defaultIcon.style.display = isSelected ? 'none' : 'block'
			if (selectedIcon) selectedIcon.style.display = isSelected ? 'block' : 'none'
			item.classList.toggle('dimina-tabbar-item--selected', isSelected)
		})
	}

	/**
	 * wx.setTabBarStyle：动态修改 TabBar 整体样式
	 * https://developers.weixin.qq.com/miniprogram/dev/api/ui/tab-bar/wx.setTabBarStyle.html
	 *
	 * 入参：
	 *   color: string           — tab 上文字默认颜色（HexColor）
	 *   selectedColor: string   — tab 上文字选中颜色（HexColor）
	 *   backgroundColor: string — tab 背景色（HexColor）
	 *   borderStyle: 'black' | 'white' — 上边框颜色
	 *   success / fail / complete: 回调
	 *
	 * 行为：原地更新 this.tabBarConfig 和已渲染的 DOM（背景、上边框、所有 tab 文字颜色），
	 * 不重新构建 tabbar，保留事件绑定 / 图标 / 选中态。
	 */
	setTabBarStyle(opts = {}) {
		const { color, selectedColor, backgroundColor, borderStyle, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		if (!this.tabBarConfig || !this.tabBarEl) {
			onFail?.({ errMsg: 'setTabBarStyle:fail tabBar not configured' })
			onComplete?.()
			return
		}

		// 仅认 wechat 文档支持的 borderStyle 值
		const validBorderStyle = borderStyle === 'black' || borderStyle === 'white' ? borderStyle : null

		// 用 _sanitizeCssColor 校验颜色，命中黑名单的字符（注入风险）直接丢弃
		const safeColor = color !== undefined ? this._sanitizeCssColor(color) : null
		const safeSelectedColor = selectedColor !== undefined ? this._sanitizeCssColor(selectedColor) : null
		const safeBg = backgroundColor !== undefined ? this._sanitizeCssColor(backgroundColor) : null

		// 1. 更新缓存 config —— 后续 _updateTabBarSelection / _renderTabBar 都依赖它
		if (safeColor) this.tabBarConfig.color = safeColor
		if (safeSelectedColor) this.tabBarConfig.selectedColor = safeSelectedColor
		if (safeBg) this.tabBarConfig.backgroundColor = safeBg
		if (validBorderStyle) this.tabBarConfig.borderStyle = validBorderStyle

		// 2. 更新已渲染的 tabbar DOM（背景 / 边框）
		const tabbar = this.tabBarEl.querySelector('.dimina-tabbar')
		if (tabbar) {
			if (safeBg) tabbar.style.backgroundColor = safeBg
			if (validBorderStyle) {
				const borderColor = validBorderStyle === 'white' ? '#FFFFFF' : '#E0E0E0'
				tabbar.style.borderTop = `0.5px solid ${borderColor}`
			}
		}

		// 3. 文字颜色按当前选中态重新刷一遍（同时处理 color 和 selectedColor）
		this._updateTabBarSelection(this.currentTabPath)

		onSuccess?.({ errMsg: 'setTabBarStyle:ok' })
		onComplete?.()
	}

	navigateToMiniProgram(opts) {
		const { appId, path } = opts
		AppManager.openApp(
			{
				appId,
				path,
				scene: 1037, // 打开小程序
			},
			this.parent,
		)
	}

	bindMoreEvent() {
		const moreBtn = this.el.querySelector('.dimina-mini-app-navigation__actions-variable')
		const overlay = this.el.querySelector('.dimina-mini-app-menu__mask')
		const menu = this.el.querySelector('.dimina-mini-app-menu')
		const cancelBtn = this.el.querySelector('.dimina-mini-app-menu__footer-btn--cancel')

		overlay.addEventListener('transitionend', () => {
			if (!overlay.classList.contains('show')) {
				overlay.style.display = 'none'
			}
		})

		moreBtn.onclick = () => this.openMiniAppMenu()
		overlay.onclick = () => this.closeMiniAppMenu()
		cancelBtn.onclick = () => this.closeMiniAppMenu()
		menu.onclick = e => e.stopPropagation()
	}

	bindCloseEvent() {
		const closeBtn = this.el.querySelector('.dimina-mini-app-navigation__actions-close')

		closeBtn.onclick = () => {
			this.closeMiniProgram()
		}
	}

	destroy() {
		// 标记 destroyed，所有异步回调据此短路（modal 100ms mount、toast timer 等）
		this._destroyed = true

		// 清理所有第三方扩展订阅
		for (const unsubscribe of this._extSubscriptions.values()) {
			unsubscribe?.()
		}
		this._extSubscriptions.clear()

		// 释放 TabBar 高度观察器
		this._tabBarResizeObserver?.disconnect()
		this._tabBarResizeObserver = null

		// 清掉所有 showModal pending 的 100ms 计时器
		for (const t of this._modalPendingTimers) clearTimeout(t)
		this._modalPendingTimers.clear()

		// 清空 modal stack（避免泄漏 DOM）
		for (const entry of this._modalStack) {
			entry.mask?.remove()
			entry.dialog?.remove()
		}
		this._modalStack.length = 0

		// 清掉残留 toast
		this.hideToast({})

		AppManager.popView()
		this.jscore.destroy()
	}

	/**
	 * 获取网络类型
	 * https://developers.weixin.qq.com/miniprogram/dev/api/device/network/wx.getNetworkType.html
	 */
	getNetworkType(opts) {
		const { success } = opts
		const onSuccess = this.createCallbackFunction(success)
		onSuccess?.({
			networkType: 'wifi',
		})
	}

	/**
	 * 发起 HTTPS 网络请求
	 * https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html
	 * @param {*} param0
	 */
	request({
		url,
		data,
		header = {}, // 默认为空对象
		timeout = 0, // 默认为0，表示没有超时
		method = 'GET', // 默认为GET方法
		dataType = 'json', // 默认为json类型
		responseType = 'text', // 响应的数据类型，默认为 text
		success,
		fail,
		complete,
	}) {
		// 创建一个AbortController实例
		// const controller = new AbortController();
		// const { signal } = controller;

		// 创建fetch请求的init对象
		const init = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				url,
				data,
				header,
				timeout,
				method,
				dataType,
				responseType,
			}),
		}

		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		fetch('http://localhost:7788/proxy', init)
			.then((response) => {
				if (!response.ok) {
					const error = new Error(response.statusText)
					error.code = response.status
					throw error
				}

				// Convert the Headers object to a plain object
				const headers = {}
				response.headers.forEach((value, key) => {
					headers[key] = value
				})

				switch (dataType) {
					case 'json':
						return response.json().then(data => ({ data: JSON.parse(data), header: headers, statusCode: response.status }))
					case 'arraybuffer':
						return response.arrayBuffer().then(data => ({ data, header: headers, statusCode: response.status }))
					default:
						return response.text().then(data => ({ data, header: headers, statusCode: response.status }))
				}
			})
			.then((data) => {
				onSuccess?.(data)
			})
			.catch((error) => {
				onFail?.({ errMsg: error.message, errno: error.code })
			})
			.finally(() => {
				onComplete?.()
			})

		// return { abort: controller.abort };
	}

	getSystemInfoAsync(opts) {
		const bar = this.parent.parent.root.querySelector('.iphone__status-bar').getBoundingClientRect()
		const wb = this.parent.el.querySelector('.dimina-native-webview__root').getBoundingClientRect()

		const { success, complete } = opts

		const onSuccess = this.createCallbackFunction(success)
		const onComplete = this.createCallbackFunction(complete)

		onSuccess?.({
			statusBarHeight: bar.height,
			brand: 'devtools',
			mode: 'default',
			model: 'web',
			platform: 'devtools',
			system: 'web',
			deviceOrientation: 'portrait',
			SDKVersion: '3.0.0',
			language: 'zh_CN',
			wifiEnabled: true,
			safeArea: {
				width: wb.width,
				height: wb.height,
				top: wb.top,
				bottom: wb.bottom,
				left: wb.left,
				right: wb.right,
			},
		})
		onComplete?.()
	}

	getMenuButtonBoundingClientRect() {
		const rect = this.el.querySelector('.dimina-mini-app-navigation__actions').getBoundingClientRect()
		const statusBar = this.parent.parent.root.querySelector('.iphone__status-bar')
		const statusBarHeight = statusBar?.getBoundingClientRect().height || 20
		// 对齐到小程序导航栏的几何模型：
		// navbar 总高约等于 statusBarHeight + 40px，胶囊在内容区内垂直居中
		const normalizedTop = statusBarHeight + 4
		const normalizedBottom = normalizedTop + rect.height
		return {
			top: normalizedTop,
			right: rect.right,
			bottom: normalizedBottom,
			left: rect.left,
			width: rect.width,
			height: rect.height,
			x: rect.x,
			y: normalizedTop,
		}
	}

	getHostEnvSnapshot() {
		return {
			menuRect: this.getMenuButtonBoundingClientRect(),
			systemInfo: this.getSystemInfoSync(),
		}
	}

	getSystemInfoSync() {
		const statusBar = this.parent.parent.root.querySelector('.iphone__status-bar')
		const viewport = this.parent.el.querySelector('.dimina-native-webview__root')
		const viewportRect = viewport?.getBoundingClientRect()
		const width = viewportRect?.width || this.el.clientWidth || 375
		const height = viewportRect?.height || this.el.clientHeight || 667
		const statusBarHeight = statusBar?.getBoundingClientRect().height || 20

		return {
			brand: 'devtools',
			model: 'web',
			platform: 'devtools',
			system: 'web',
			SDKVersion: '3.0.0', // vant组件库 判断  canIUseModel version 需要大于 2.9.3
			pixelRatio: globalThis.devicePixelRatio || 1,
			screenWidth: width,
			screenHeight: height,
			windowWidth: width,
			windowHeight: height,
			statusBarHeight,
			safeArea: {
				left: 0,
				right: width,
				top: statusBarHeight,
				bottom: height,
				width,
				height: Math.max(height - statusBarHeight, 0),
			},
		}
	}

	showToast(opts = {}) {
		const { title = '', duration = 1500, icon = 'success', mask = false, success, complete } = opts

		if (!title) {
			return
		}

		this.hideToast({})

		const onSuccess = this.createCallbackFunction(success)
		const onComplete = this.createCallbackFunction(complete)

		// 可选遮罩层：mask:true 时阻止用户点击下层内容（对齐 wx.showToast）
		let maskEl = null
		if (mask) {
			maskEl = document.createElement('div')
			maskEl.className = 'dimina-toast-mask'
			this.el.appendChild(maskEl)
		}

		const dom = document.createElement('div')
		dom.className = `dimina-toast dimina-toast--${icon}`
		// 没图标的 toast（icon: 'none'）：只渲染文本，不再占 120x120 大方块
		if (icon === 'none') {
			dom.classList.add('dimina-toast--text-only')
		}
		const p = document.createElement('p')
		p.textContent = String(title)
		dom.appendChild(p)

		// 挂到 mini-app 根节点，避免被 webviewsContainer 的页面层级裁剪 / 遮挡
		this.el.appendChild(dom)
		this.toastInfo.dom = dom
		this.toastInfo.maskEl = maskEl

		this.toastInfo.timer = setTimeout(() => {
			dom.remove()
			maskEl?.remove()
			if (this.toastInfo.dom === dom) {
				this.toastInfo.dom = null
				this.toastInfo.maskEl = null
				this.toastInfo.timer = null
			}
		}, duration)

		onSuccess?.()
		onComplete?.()
	}

	hideToast(opts = {}) {
		const { success, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onComplete = this.createCallbackFunction(complete)

		if (this.toastInfo.dom) {
			this.toastInfo.dom.remove()
			this.toastInfo.dom = null
		}
		if (this.toastInfo.maskEl) {
			this.toastInfo.maskEl.remove()
			this.toastInfo.maskEl = null
		}
		if (this.toastInfo.timer) {
			clearTimeout(this.toastInfo.timer)
			this.toastInfo.timer = null
		}
		onSuccess?.()
		onComplete?.()
	}

	showLoading(opts = {}) {
		this.showToast({ ...opts, icon: 'loading' })
	}

	hideLoading(opts = {}) {
		// 修复：之前是 this.hideLoading(opts)，无限递归
		this.hideToast(opts)
	}


	showModal(opts) {
		if (this._destroyed) return
		// 同步 mount + push：栈状态立即生效（destroy / 栈深查询都能看到这条 entry）
		const entry = this._mountModal(opts || {})
		this._modalStack.push(entry)
		// push 后触发一次视图更新：只展示栈顶，其它全部隐藏（不再叠加渲染）
		this._updateModalView()

		// mask 同步加 .show：立即变黑遮罩，吸收触发 showModal 那次 click 链路的 mouseup
		// （dialog 仍 pointer-events:none 不接收点击 → click 落到 mask 被吸收，不穿透到按钮）
		entry.mask.classList.add('show')

		const timer = setTimeout(() => {
			this._modalPendingTimers.delete(timer)
			if (this._destroyed) return
			// 已被外部 close 出栈了就不再 show
			if (!this._modalStack.includes(entry)) return
			entry.dialog.classList.add('show')
		}, MODAL_GUARD_MS)
		this._modalPendingTimers.add(timer)
	}

	/**
	 * 根据 _modalStack 当前状态更新视图：仅栈顶 modal 可见，其余 mask + dialog 都 display:none。
	 * 任何改变栈结构的操作（push / pop）之后都该调一次。
	 */
	_updateModalView() {
		const topIdx = this._modalStack.length - 1
		for (let i = 0; i < this._modalStack.length; i++) {
			const e = this._modalStack[i]
			if (i === topIdx) {
				e.mask.classList.remove('dimina-modal--occluded')
				e.dialog.classList.remove('dimina-modal--occluded')
			}
			else {
				e.mask.classList.add('dimina-modal--occluded')
				e.dialog.classList.add('dimina-modal--occluded')
			}
		}
	}

	_mountModal(opts) {
        const {
            title = "",
            content = "",
            showCancel = true,
            cancelText = "取消",
            cancelColor = "#000",
            confirmText = "确定",
            confirmColor = "#576b95",
            success,
            complete,
        } = opts;
        const onSuccess = this.createCallbackFunction(success);
        const onComplete = this.createCallbackFunction(complete);

        const mask = document.createElement("div");
        mask.className = "dimina-dialog-mask";

        const dialog = document.createElement("div");
        dialog.className = "dimina-dialog";

        const depth = this._modalStack.length;
        mask.style.zIndex = String(1100 + depth * 20);
        dialog.style.zIndex = String(1110 + depth * 20);

        if (title) {
            const titleEl = document.createElement("h2");
            titleEl.className = "dimina-dialog__title";
            titleEl.textContent = String(title);
            dialog.appendChild(titleEl);
        }

        // content 为空就不渲染——避免空的 padding 占位
        if (content) {
            const contentEl = document.createElement("p");
            contentEl.className = "dimina-dialog__content";
            contentEl.textContent = String(content);
            dialog.appendChild(contentEl);
        }

        const btnRow = document.createElement("div");
        btnRow.className = "dimina-dialog__buttons";

        let closed = false;
        const entry = { mask, dialog, close: null };
        const close = (result) => {
            if (closed) return;
            closed = true;
            // 从 stack 中弹掉自己（可能不是栈顶，例如外部 destroy 提前关掉了下层 modal）
            const idx = this._modalStack.indexOf(entry);
            if (idx >= 0) this._modalStack.splice(idx, 1);

            // 栈空 → 这是最后一个 modal，播放收缩淡出动画再移除
            // 栈非空 → 下面还有 modal 要露出，直接移除当前 DOM 不播动画，让下一个立刻可见
            if (this._modalStack.length === 0) {
                mask.classList.remove("show");
                dialog.classList.remove("show");
                setTimeout(() => {
                    mask.remove();
                    dialog.remove();
                }, 200);
            } else {
                mask.remove();
                dialog.remove();
            }

            // pop 后触发视图更新：之前的下一层（新栈顶）显示出来
            this._updateModalView();
            onSuccess?.(result);
            onComplete?.();
        };
        entry.close = close;

        if (showCancel) {
            const cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "dimina-dialog__button";
            cancelBtn.style.color = cancelColor;
            cancelBtn.textContent = String(cancelText);
            cancelBtn.addEventListener("click", () => {
                close({ cancel: true, confirm: false, errMsg: "showModal:ok" });
            });
            btnRow.appendChild(cancelBtn);
        }

        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "dimina-dialog__button";
        confirmBtn.style.color = confirmColor;
        confirmBtn.textContent = String(confirmText);
        confirmBtn.addEventListener("click", () => {
            close({ cancel: false, confirm: true, errMsg: "showModal:ok" });
        });
        btnRow.appendChild(confirmBtn);

        dialog.appendChild(btnRow);

        this.el.appendChild(mask);
        this.el.appendChild(dialog);

        // .show 由 showModal 在 100ms 后统一加，触发 transition + 打开 pointer-events
        // （这里不再 rAF 自动加 show——展示和挂载已分离）

        return entry;
    }

	showActionSheet(opts) {
		const { itemList = [], itemColor = '#000', success, fail, complete } = opts || {}
		if (!Array.isArray(itemList) || itemList.length === 0) {
			fail && this.createCallbackFunction(fail)({ errMsg: 'showActionSheet:fail' })
			complete && this.createCallbackFunction(complete)()
			return
		}
		// 创建遮罩层
		const mask = document.createElement('div')
		mask.className = 'dimina-action-sheet-mask'
		// 创建 action sheet 容器
		const sheet = document.createElement('div')
		sheet.className = 'dimina-action-sheet'

		// 清理方法
		const cleanup = () => {
			mask.remove()
			sheet.remove()
		}
		// 选项
		itemList.forEach((item, idx) => {
			const btn = document.createElement('div')
			btn.className = 'dimina-action-sheet-item'
			btn.style.color = itemColor
			btn.textContent = item
			btn.onclick = () => {
				cleanup()
				success && this.createCallbackFunction(success)({ tapIndex: idx })
				complete && this.createCallbackFunction(complete)()
			}
			sheet.appendChild(btn)
		})
		// 取消按钮
		const cancelBtn = document.createElement('div')
		cancelBtn.className = 'dimina-action-sheet-cancel'
		cancelBtn.textContent = '取消'
		cancelBtn.onclick = () => {
			cleanup()
			fail && this.createCallbackFunction(fail)({ errMsg: 'showActionSheet:fail cancel' })
			complete && this.createCallbackFunction(complete)()
		}
		sheet.appendChild(cancelBtn)

		mask.onclick = cleanup
		// 挂载到 mini-app 根，避免被 webviewsContainer 的页面层级影响
		this.el.appendChild(mask)
		this.el.appendChild(sheet)
		// 动画效果：等浏览器 paint 后再加 show class，触发 CSS transition
		requestAnimationFrame(() => requestAnimationFrame(() => {
			sheet.classList.add('show')
			mask.classList.add('show')
		}))
	}

	setNavigationBarTitle(opts) {
		const { title, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)
		try {
			const currentBridge = this.bridgeList[this.bridgeList.length - 1]
			const navigationTitle = currentBridge.webview.el.querySelector('.dimina-native-webview__navigation-title')
			if (navigationTitle) {
				navigationTitle.textContent = title || ''
				onSuccess?.({ errMsg: 'setNavigationBarTitle:ok' })
			}
			else {
				onFail?.({ errMsg: `setNavigationBarTitle:fail Navigation title element not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `setNavigationBarTitle:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	setNavigationBarColor(opts) {
		const { frontColor, backgroundColor, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			const currentBridge = this.bridgeList[this.bridgeList.length - 1]
			const navigation = currentBridge.webview.el.querySelector('.dimina-native-webview__navigation')
			if (navigation) {
				// 设置前景色（文字颜色）
				if (frontColor) {
					navigation.querySelector('.dimina-native-webview__navigation-title').style.color = frontColor
				}
				// 设置背景色
				if (backgroundColor) {
					navigation.style.backgroundColor = backgroundColor
				}
				onSuccess?.({ errMsg: 'setNavigationBarColor:ok' })
			}
			else {
				onFail?.({ errMsg: `setNavigationBarColor:fail Navigation element not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `setNavigationBarColor:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	/**
	 * 页面滚动到指定位置
	 */
	pageScrollTo(opts) {
		const { scrollTop, duration = 300, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			const currentBridge = this.bridgeList[this.bridgeList.length - 1]
			const webviewRoot = currentBridge.webview.iframe.contentWindow.document.documentElement
			if (webviewRoot) {
				webviewRoot.scrollTo({
					top: scrollTop,
					behavior: duration > 0 ? 'smooth' : 'auto',
				})

				// 模拟滚动动画时间
				setTimeout(() => {
					onSuccess?.({ errMsg: 'pageScrollTo:ok' })
					onComplete?.()
				}, duration)
			}
			else {
				onFail?.({ errMsg: `pageScrollTo:fail Webview root element not found` })
				onComplete?.()
			}
		}
		catch (error) {
			onFail?.({ errMsg: `pageScrollTo:fail ${error.message}` })
			onComplete?.()
		}
	}

	/**
	 * 设置剪贴板数据
	 */
	setClipboardData(opts) {
		const { data, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			navigator.clipboard.writeText(data).then(() => {
				onSuccess?.({ errMsg: 'setClipboardData:ok' })
				onComplete?.()
			}).catch((error) => {
				onFail?.({ errMsg: `setClipboardData:fail ${error.message}` })
				onComplete?.()
			})
		}
		catch (error) {
			onFail?.({ errMsg: `setClipboardData:fail ${error.message}` })
			onComplete?.()
		}
	}

	/**
	 * 获取剪贴板数据
	 */
	getClipboardData(opts) {
		const { success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			navigator.clipboard.readText().then((data) => {
				onSuccess?.({ data, errMsg: 'getClipboardData:ok' })
				onComplete?.()
			}).catch((error) => {
				onFail?.({ errMsg: `getClipboardData:fail ${error.message}` })
				onComplete?.()
			})
		}
		catch (error) {
			onFail?.({ errMsg: `getClipboardData:fail ${error.message}` })
			onComplete?.()
		}
	}

	setStorage(opts) {
		const { key, data, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			// 按appId区分存储数据
			const storageKey = `${this.appId}_${key}`
			// 将数据转为字符串存储
			const dataString = typeof data === 'object' ? JSON.stringify(data) : String(data)
			localStorage.setItem(storageKey, dataString)
			onSuccess?.({ errMsg: 'setStorage:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `setStorage:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	getStorage(opts) {
		const { key, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			// 按appId区分存储数据
			const storageKey = `${this.appId}_${key}`
			const data = localStorage.getItem(storageKey)
			if (data !== null) {
				// 尝试解析JSON数据
				let parsedData = data
				try {
					parsedData = JSON.parse(data)
				}
				catch {
					// 如果解析失败，保持原始字符串
				}
				onSuccess?.({ data: parsedData, errMsg: 'getStorage:ok' })
			}
			else {
				onFail?.({ errMsg: `getStorage:fail data not found` })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `getStorage:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	removeStorage(opts) {
		const { key, success, fail, complete } = opts
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			// 按appId区分存储数据
			const storageKey = `${this.appId}_${key}`
			if (localStorage.getItem(storageKey) !== null) {
				localStorage.removeItem(storageKey)
				onSuccess?.({ errMsg: 'removeStorage:ok' })
			}
			else {
				// 即使key不存在也返回成功
				onSuccess?.({ errMsg: 'removeStorage:ok' })
			}
		}
		catch (error) {
			onFail?.({ errMsg: `removeStorage:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	clearStorage(opts) {
		const { success, fail, complete } = opts || {}
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			// 只清除当前appId的存储数据
			const appIdPrefix = `${this.appId}_`
			const keysToRemove = []

			// 找出所有属于当前appId的keys
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i)
				if (key.startsWith(appIdPrefix)) {
					keysToRemove.push(key)
				}
			}

			// 删除所有找到的keys
			keysToRemove.forEach(key => localStorage.removeItem(key))

			onSuccess?.({ errMsg: 'clearStorage:ok' })
		}
		catch (error) {
			onFail?.({ errMsg: `clearStorage:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	getStorageInfo(opts) {
		const { success, fail, complete } = opts || {}
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		try {
			const keys = []
			let currentSize = 0
			const limitSize = 10 * 1024 * 1024 // 假设限制为10MB
			const appIdPrefix = `${this.appId}_`

			// 只获取当前appId的存储信息
			for (let i = 0; i < localStorage.length; i++) {
				const fullKey = localStorage.key(i)

				// 只处理当前appId的keys
				if (fullKey.startsWith(appIdPrefix)) {
					// 移除appId前缀，返回原始key给小程序
					const originalKey = fullKey.substring(appIdPrefix.length)
					keys.push(originalKey)

					const item = localStorage.getItem(fullKey)
					currentSize += item ? item.length * 2 : 0 // 估算字符串大小（UTF-16编码每个字符2字节）
				}
			}

			onSuccess?.({
				keys,
				currentSize, // 当前占用空间，单位为字节
				limitSize, // 存储限制，单位为字节
				errMsg: 'getStorageInfo:ok',
			})
		}
		catch (error) {
			onFail?.({ errMsg: `getStorageInfo:fail ${error.message}` })
		}
		finally {
			onComplete?.()
		}
	}

	/**
	 * 从 `${module}_${event}` 格式的 key 中还原 module 与 event。
	 * 通过遍历已注册模块名做前缀匹配，支持模块名含下划线的场景。
	 * @param {string} eventKey
	 * @returns {{ module: string|null, event: string|null }} 包含解析出的模块名和事件名的对象，若解析失败则均为 null
	 */
	_parseExtEventKey(eventKey) {
		const modules = AppManager.getExtModules()
		for (const moduleName of Object.keys(modules)) {
			const prefix = `${moduleName}_`
			if (eventKey.startsWith(prefix)) {
				return { module: moduleName, event: eventKey.slice(prefix.length) }
			}
		}
		return { module: null, event: null }
	}

	/**
	 * 第三方扩展调用的统一入口
	 *
	 * service 侧 extBridge/extOnBridge/extOffBridge 的 invokeAPI 名称规则：
	 *   extBridge   → name = event,              params = { module, data, success, fail, complete }
	 *   extOnBridge → name = `${module}_${event}`, params = { success(callBack), evtId }
	 *   extOffBridge→ name = `${module}_${event}`, params = { success(undefined) }（无 evtId，keep=false）
	 *
	 * 区分方式：
	 *   - extBridge：params 中携带 module 字段
	 *   - extOnBridge vs extOffBridge：evtId 存在且 success 有值 → on；否则 → off
	 */
	_handleExtCall(name, params = {}) {
		if (params.module !== undefined) {
			// ── extBridge ─────────────────────────────────────────────
			this._extBridgeCall(name, params)
		}
		else if (params.success) {
			// ── extOnBridge：name = `${module}_${event}` ──────────────
			this._extOnBridgeCall(name, params)
		}
		else {
			// ── extOffBridge：name = `${module}_${event}` ─────────────
			this._extOffBridgeCall(name)
		}
	}

	/**
	 * 对应 service 侧 extBridge
	 * invokeAPI(event, { module, data, success, fail, complete, keep })
	 * → container: name=event, params={ module, data, success, fail, complete }
	 */
	_extBridgeCall(event, params) {
		const { module, data = {}, success, fail, complete } = params
		const onSuccess = this.createCallbackFunction(success)
		const onFail = this.createCallbackFunction(fail)
		const onComplete = this.createCallbackFunction(complete)

		const handler = AppManager.getExtModule(module)
		if (!handler) {
			const errMsg = `extBridge:fail module "${module}" not registered`
			console.error(`[container] ${errMsg}`)
			onFail?.({ errMsg })
			onComplete?.()
			return
		}

		try {
			handler({
				event,
				data,
				success: (res) => {
					onSuccess?.(res)
					onComplete?.()
				},
				fail: (err) => {
					onFail?.(err)
					onComplete?.()
				},
			})
		}
		catch (error) {
			onFail?.({ errMsg: `extBridge:fail ${error.message}` })
			onComplete?.()
		}
	}

	/**
	 * 对应 service 侧 extOnBridge
	 * invokeAPI(`${module}_${event}`, { evtId, keep:true, success:callBack })
	 * → container: name=`${module}_${event}`, params={ success, evtId }
	 *
	 * 通过遍历已注册模块名匹配前缀来还原 module 与 event，
	 * 避免模块名本身含下划线时解析出错。
	 */
	_extOnBridgeCall(eventKey, params) {
		const { success } = params
		const onCallback = this.createCallbackFunction(success)

		const { module, event } = this._parseExtEventKey(eventKey)
		if (!module) {
			console.error(`[container] extOnBridge:fail no registered module matched for key "${eventKey}"`)
			return
		}

		const handler = AppManager.getExtModule(module)

		// 若已有相同订阅，先清理旧的
		const prev = this._extSubscriptions.get(eventKey)
		prev?.()

		try {
			const unsubscribe = handler({
				event,
				data: { isSustain: true },
				success: res => onCallback?.(res),
				fail: err => console.error(`[container] extOnBridge error (${eventKey}):`, err),
			})

			this._extSubscriptions.set(eventKey, unsubscribe ?? null)
		}
		catch (error) {
			console.error(`[container] extOnBridge:fail ${error.message}`)
		}
	}

	/**
	 * 对应 service 侧 extOffBridge
	 * invokeAPI(`${module}_${event}`, { success:undefined })
	 * → container: name=`${module}_${event}`, params={ success:undefined }
	 */
	_extOffBridgeCall(eventKey) {
		const unsubscribe = this._extSubscriptions.get(eventKey)
		if (unsubscribe) {
			unsubscribe()
			this._extSubscriptions.delete(eventKey)
		}
	}
}
