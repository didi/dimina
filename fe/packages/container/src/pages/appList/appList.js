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
	}

	viewDidLoad() {
		this.el.innerHTML = tpl

		this.createAppList()
		this.bindSearchEvent()
		this.bindOpenMiniApp()
	}

	createAppList() {
		const list = this.el.querySelector('.dimina-app__mini-used-list')
		getAppList().then((appList) => {
			appList.forEach((appInfo) => {
				const item = `
				<li class="dimina-app__mini-used-list-item" data-appid="${appInfo.appId}">
					<div class="dimina-app__mini-used-logo">
						<img src="${appInfo.logo}" alt="">
					</div>
					<p class="dimina-app__mini-used-name">${appInfo.name}</p>
				</li>
			`
				const temp = document.createElement('div')

				temp.innerHTML = item
				list.appendChild(temp.children[0])
			})
		})
	}

	bindSearchEvent() {
		const searchInput = this.el.querySelector('.dimina-app__mini-search-input-placeholder')
		const list = this.el.querySelector('.dimina-app__mini-used-list')
		const li = list.getElementsByTagName('li')
		searchInput.addEventListener('input', (e) => {
			const filter = e.target.value
			for (const item of li) {
				const a = item.getElementsByTagName('p')[0]
				const txtValue = a.textContent
				if (txtValue.toUpperCase().includes(filter)) {
					item.style.display = ''
				}
				else {
					item.style.display = 'none'
				}
			}
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
				name: appInfo.name,
				logo: appInfo.logo,
				scene: 1001,
				destroy: true, // 关闭之前的小程序
			}, this.parent)
		}
	}

	onPresentOut() { }

	onPresentIn() {
		this.parent.updateStatusBarColor('black')
	}
}
