import { AppListView } from '@dimina/container-ui'
import '@dimina/container-ui/style.css'
import { getAppList } from '@/services'
import tpl from './appList.html?raw'
import './appList.scss'

export class AppList {
	/** @param {ReturnType<typeof import('@dimina/fe-container-sdk').createContainer>} container */
	constructor(container, { onCreate = () => {}, onOpenGenerated = () => {}, getGeneratedProjects } = {}) {
		this.container = container
		this.onCreate = onCreate
		this.onOpenGenerated = onOpenGenerated
		this.getGeneratedProjects = getGeneratedProjects
		this.generatedApps = []
		this.parent = null
		this.el = document.createElement('div')
		this.el.classList.add('dimina-native-view')
	}

	viewDidLoad() {
		this.el.innerHTML = tpl
		this.library = new AppListView({
			loadApps: getAppList,
			onOpen: app => app.generated
				? this.onOpenGenerated(app.appId)
				: this.container.openApp({ appId: app.appId, path: app.path, scene: 1001 }),
			action: { label: 'AI 创建', onClick: () => this.onCreate() },
		})
		this.el.firstElementChild.appendChild(this.library.el)
		this.library.setExtraApps(this.generatedApps)
		void this.library.refresh()
		void this.refreshGeneratedProjects()
	}

	async refreshGeneratedProjects() {
		if (!this.getGeneratedProjects) return
		try { this.setGeneratedProjects(await this.getGeneratedProjects()) }
		catch { /* Built-in examples remain available when browser storage is disabled. */ }
	}

	setGeneratedProjects(projects) {
		this.generatedApps = projects.map(project => ({ appId: project.id, name: project.name, generated: true }))
		this.library?.setExtraApps(this.generatedApps)
	}

	onPresentOut() { }

	onPresentIn() {
		this.parent.shell.updateStatusBarColor('black')
		void this.refreshGeneratedProjects()
	}
}
