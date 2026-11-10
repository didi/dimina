import { getAppList, getMiniAppInfo } from '@/services'
import tpl from './appList.html?raw'
import './appList.scss'

// 简单 DOM 向上查找，避免为这一处用法依赖 SDK 内部工具（container-sdk 不对 demo 暴露 utils）。
function closest(node, className) {
	let current = node

	while (current?.classList && !current.classList.contains(className)) {
		current = current.parentNode
	}

	if (current === document) {
		return null
	}

	return current
}

export class AppList {
	/**
	 * @param {ReturnType<typeof import('@dimina/fe-container-sdk').createContainer>} container
	 */
	constructor(container, { onCreate = () => {}, onOpenGenerated = () => {}, getGeneratedProjects } = {}) {
		this.container = container
		this.onCreate = onCreate
		this.onOpenGenerated = onOpenGenerated
		this.getGeneratedProjects = getGeneratedProjects
		this.generatedApps = []
		this.parent = null
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
		this.appList = []
		this.filteredAppList = []
		this.searchKeyword = ''
	}

	viewDidLoad() {
		this.el.innerHTML = tpl

		this.createAppList()
		this.bindSearchEvent()
		this.bindOpenMiniApp()
		this.el.querySelector('.dimina-app__generator-link').onclick = () => this.onCreate()
		void this.refreshGeneratedProjects()
	}

	async refreshGeneratedProjects() {
		if (!this.getGeneratedProjects) return
		try { this.setGeneratedProjects(await this.getGeneratedProjects()) }
		catch { /* The built-in examples remain available when browser storage is disabled. */ }
	}

	setGeneratedProjects(projects) {
		this.generatedApps = projects.map(project => ({ appId: project.id, name: project.name, generated: true }))
		this.renderFilteredAppList()
	}

	createAppList() {
		this.setListState('加载中...')
		getAppList()
			.then((appList) => {
				this.appList = appList
				this.renderFilteredAppList()
			})
			.catch(() => {
				this.appList = []
				this.renderAppList([])
				this.setListState('应用列表加载失败')
			})
	}

	bindSearchEvent() {
		const searchInput = this.el.querySelector('.dimina-app__mini-search-input-placeholder')
		searchInput.addEventListener('input', (e) => {
			this.searchKeyword = e.target.value.trim().toLocaleLowerCase()
			this.renderFilteredAppList()
		})
	}

	bindOpenMiniApp() {
		const appList = this.el.querySelector('.dimina-app__mini-used-list')

		appList.onclick = async (e) => {
			const app = closest(e.target, 'dimina-app__mini-used-list-item')

			if (!app) {
				return
			}

			const appId = app.getAttribute('data-appid')
			if (app.dataset.generated === 'true') {
				this.onOpenGenerated(appId)
				return
			}
			const appInfo = await getMiniAppInfo(appId)

			if (!appInfo) {
				return
			}

			// 场景值含义
			// https://developers.weixin.qq.com/miniprogram/dev/reference/scene-list.html
			this.container.openApp({
				appId,
				path: appInfo.path,
				scene: 1001,
			})
		}
	}

	onPresentOut() { }

	onPresentIn() {
		this.parent.updateStatusBarColor('black')
		void this.refreshGeneratedProjects()
	}

	renderFilteredAppList() {
		const keyword = this.searchKeyword
		const apps = [...this.generatedApps, ...this.appList]
		this.filteredAppList = keyword
			? apps.filter((appInfo) => {
					const name = appInfo.name?.toLocaleLowerCase() ?? ''
					const appId = appInfo.appId?.toLocaleLowerCase() ?? ''
					return name.includes(keyword) || appId.includes(keyword)
				})
			: apps
		this.renderAppList(this.filteredAppList)

		if (!apps.length) {
			this.setListState('暂无应用')
		}
		else if (!this.filteredAppList.length) {
			this.setListState('未找到匹配的小程序')
		}
		else {
			this.setListState('')
		}
	}

	renderAppList(appList) {
		const list = this.el.querySelector('.dimina-app__mini-used-list')
		const fragment = document.createDocumentFragment()

		appList.forEach((appInfo) => {
			const item = document.createElement('li')
			item.className = 'dimina-app__mini-used-list-item'
			item.dataset.appid = appInfo.appId
			item.dataset.generated = String(Boolean(appInfo.generated))

			const logo = document.createElement('div')
			logo.className = 'dimina-app__mini-used-logo'

			if (appInfo.generated) {
				logo.classList.add('dimina-app__mini-used-logo--generated')
				logo.textContent = '✳'
			}
			else {
				const logoImg = document.createElement('img')
				logoImg.src = appInfo.logo
				logoImg.alt = `${appInfo.name} logo`
				logoImg.loading = 'lazy'
				logoImg.draggable = false
				logo.appendChild(logoImg)
			}

			const name = document.createElement('p')
			name.className = 'dimina-app__mini-used-name'
			name.textContent = appInfo.name

			item.append(logo, name)
			fragment.appendChild(item)
		})

		list.replaceChildren(fragment)
	}

	setListState(text) {
		const state = this.el.querySelector('.dimina-app__mini-used-state')
		state.textContent = text
		state.hidden = !text
	}
}
