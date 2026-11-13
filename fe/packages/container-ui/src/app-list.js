import template from './app-list.html?raw'
import searchIcon from './assets/search.jpg'

/** Shared list behavior; the host supplies its catalog and open/import actions. */
export class AppListView {
	constructor({ loadApps, onOpen, action, refreshable = false } = {}) {
		this.loadApps = loadApps
		this.onOpen = onOpen
		this.action = action
		this.apps = []
		this.extraApps = []
		this.filteredApps = []
		this.opening = new Set()
		this.loading = false
		this.revision = 0
		this.destroyed = false
		const wrapper = document.createElement('div')
		wrapper.innerHTML = template
		this.el = wrapper.firstElementChild
		this.search = this.el.querySelector('input')
		this.search.style.backgroundImage = `url("${searchIcon}")`
		this.list = this.el.querySelector('ul')
		this.state = this.el.querySelector('.dimina-app__mini-used-state')
		this.actionButton = this.el.querySelector('.dimina-app__generator-link')
		this.refreshButton = this.el.querySelector('.dimina-app__mini-refresh')
		this.refreshButton.hidden = !refreshable
		this.actionButton.hidden = !action
		if (action) this.actionButton.querySelector('[data-action-label]').textContent = action.label
		this.onSearch = () => this.render()
		this.onListClick = (event) => {
			const item = event.target.closest?.('[data-appid]')
			if (!item || !this.list.contains(item)) return
			const app = this.filteredApps.find(entry => entry.appId === item.dataset.appid && Boolean(entry.generated) === (item.dataset.generated === 'true'))
			if (app) void this.open(app)
		}
		this.onRefresh = () => { void this.refresh() }
		this.onAction = () => { void this.runAction() }
		this.search.addEventListener('input', this.onSearch)
		this.list.addEventListener('click', this.onListClick)
		this.refreshButton.addEventListener('click', this.onRefresh)
		this.actionButton.addEventListener('click', this.onAction)
	}

	async refresh() {
		if (this.destroyed) return
		const revision = ++this.revision
		this.loading = true
		this.list.setAttribute('aria-busy', 'true')
		this.setState('加载中...')
		try {
			const apps = await this.loadApps()
			if (this.destroyed || revision !== this.revision) return
			this.loading = false
			this.setApps(apps)
		}
		catch (error) {
			if (this.destroyed || revision !== this.revision) return
			this.loading = false
			this.setState(`应用列表加载失败${error?.message ? `：${error.message}` : ''}`, true)
		}
		finally {
			if (!this.destroyed && revision === this.revision) this.list.removeAttribute('aria-busy')
		}
	}

	setApps(apps) {
		this.apps = apps
		this.render()
	}

	setExtraApps(apps) {
		this.extraApps = apps
		this.render()
	}

	render() {
		if (this.destroyed) return
		const apps = [...this.extraApps, ...this.apps]
		const keyword = this.search.value.trim().toLocaleLowerCase()
		this.filteredApps = apps.filter(app => !keyword || [app.name, app.appId].some(value => String(value ?? '').toLocaleLowerCase().includes(keyword)))
		const fragment = document.createDocumentFragment()
		for (const app of this.filteredApps) {
			const item = document.createElement('li')
			item.className = 'dimina-app__mini-used-list-item'
			item.dataset.appid = app.appId
			item.dataset.generated = String(Boolean(app.generated))
			const button = document.createElement('button')
			button.className = 'dimina-app__mini-used-open'
			button.type = 'button'
			const logo = document.createElement('div')
			logo.className = 'dimina-app__mini-used-logo'
			if (app.generated) {
				logo.classList.add('dimina-app__mini-used-logo--generated')
				logo.textContent = '✳'
			}
			else {
				const image = document.createElement('img')
				if (app.logo) image.src = app.logo
				image.alt = `${app.name} logo`
				image.loading = 'lazy'
				image.draggable = false
				logo.appendChild(image)
			}
			const name = document.createElement('p')
			name.className = 'dimina-app__mini-used-name'
			name.textContent = app.name
			button.append(logo, name)
			item.appendChild(button)
			const opening = this.opening.has(this.appKey(app))
			this.updateOpening(item, opening, opening ? 'loading' : undefined)
			fragment.appendChild(item)
		}
		this.list.replaceChildren(fragment)
		this.setState(!apps.length ? (this.loading ? '加载中...' : '暂无应用') : !this.filteredApps.length ? '未找到匹配的小程序' : '')
	}

	appKey(app) { return `${Boolean(app.generated)}:${app.appId}` }

	updateOpening(item, busy, state) {
		const button = item.querySelector('button')
		button.disabled = busy
		if (state) button.dataset.state = state
		if (busy) button.setAttribute('aria-busy', 'true')
		else button.removeAttribute('aria-busy')
	}

	async open(app) {
		const key = this.appKey(app)
		if (this.destroyed || this.opening.has(key)) return
		this.opening.add(key)
		const update = (busy, state) => {
			for (const item of this.list.children) {
				if (item.dataset.appid === app.appId && (item.dataset.generated === 'true') === Boolean(app.generated)) this.updateOpening(item, busy, state)
			}
		}
		update(true, 'loading')
		try {
			await this.onOpen(app)
			if (!this.destroyed) update(false, 'success')
		}
		catch (error) {
			if (!this.destroyed) {
				update(false, 'error')
				this.setState(`打开小程序失败：${error?.message || error}`, true)
			}
		}
		finally {
			this.opening.delete(key)
			if (!this.destroyed) update(false)
		}
	}

	async runAction() {
		if (this.destroyed || this.actionButton.disabled || !this.action) return
		this.actionButton.disabled = true
		try {
			const result = await this.action.onClick()
			if (!this.destroyed && result !== false && this.action.refreshAfter) await this.refresh()
		}
		catch (error) { if (!this.destroyed) this.setState(error?.message || String(error), true) }
		finally { if (!this.destroyed) this.actionButton.disabled = false }
	}

	setState(text, error = false) {
		this.state.textContent = text
		this.state.hidden = !text
		this.state.setAttribute('role', error ? 'alert' : 'status')
	}

	destroy() {
		if (this.destroyed) return
		this.destroyed = true
		++this.revision
		this.search.removeEventListener('input', this.onSearch)
		this.list.removeEventListener('click', this.onListClick)
		this.refreshButton.removeEventListener('click', this.onRefresh)
		this.actionButton.removeEventListener('click', this.onAction)
	}
}
