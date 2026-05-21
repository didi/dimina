import { AppManager } from '@/core/appManager'
import { getAppList, getMiniAppInfo } from '@/services'
import { closest } from '@/utils/util'
import tpl from './appList.html?raw'
import './appList.scss'

export class AppList {
	constructor() {
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
			const appInfo = await getMiniAppInfo(appId)

			if (!appInfo) {
				return
			}

			// 场景值含义
			// https://developers.weixin.qq.com/miniprogram/dev/reference/scene-list.html
			AppManager.openApp({
				appId,
				path: appInfo.path,
				scene: 1001,
				destroy: true, // 关闭之前的小程序
			}, this.parent)
		}
	}

	onPresentOut() { }

	onPresentIn() {
		this.parent.updateStatusBarColor('black')
	}

	renderFilteredAppList() {
		const keyword = this.searchKeyword
		this.filteredAppList = keyword
			? this.appList.filter((appInfo) => {
					const name = appInfo.name?.toLocaleLowerCase() ?? ''
					const appId = appInfo.appId?.toLocaleLowerCase() ?? ''
					return name.includes(keyword) || appId.includes(keyword)
				})
			: this.appList
		this.renderAppList(this.filteredAppList)

		if (!this.appList.length) {
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

			const logo = document.createElement('div')
			logo.className = 'dimina-app__mini-used-logo'

			const logoImg = document.createElement('img')
			logoImg.src = appInfo.logo
			logoImg.alt = `${appInfo.name} logo`
			logoImg.loading = 'lazy'
			logoImg.draggable = false
			logo.appendChild(logoImg)

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
