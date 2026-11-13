// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppListView, getAppInfo } from '@dimina/container-ui'

const deferred = () => {
	let resolve, reject
	const promise = new Promise((done, fail) => { resolve = done; reject = fail })
	return { promise, resolve, reject }
}
const apps = [{ appId: 'wx-first', name: '第一个示例', logo: '/first.png' }, { appId: 'wx-second', name: 'Second', logo: '/second.png' }]
const views = []
function mount(options = {}) {
	const view = new AppListView({ loadApps: async () => apps, onOpen: vi.fn(), ...options })
	document.body.appendChild(view.el)
	views.push(view)
	return view
}
function search(view, value) {
	view.search.value = value
	view.search.dispatchEvent(new Event('input', { bubbles: true }))
}
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('shared Web and desktop application library', () => {
	it('searches names and app IDs, renders text safely and distinguishes empty results', async () => {
		const view = mount()
		await view.refresh()
		expect(view.list.children).toHaveLength(2)
		search(view, '  SECOND ')
		expect(view.list.children).toHaveLength(1)
		expect(view.list.firstElementChild.dataset.appid).toBe('wx-second')
		search(view, 'WX-FIRST')
		expect(view.list.firstElementChild.dataset.appid).toBe('wx-first')
		search(view, '不存在')
		expect(view.state.textContent).toBe('未找到匹配的小程序')
		search(view, '')
		view.setApps([{ appId: 'unsafe', name: '<img src=x onerror=alert(1)>', logo: '/logo.png' }])
		expect(view.list.querySelector('.dimina-app__mini-used-name').textContent).toBe('<img src=x onerror=alert(1)>')
		expect(view.list.querySelectorAll('img')).toHaveLength(1)
		view.setApps([])
		expect(view.state.textContent).toBe('暂无应用')
	})

	it('keeps loading distinct from empty and ignores late responses from an older refresh', async () => {
		const first = deferred(), second = deferred()
		const loadApps = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
		const view = mount({ loadApps })
		const old = view.refresh()
		view.setExtraApps([])
		expect(view.state.textContent).toBe('加载中...')
		const latest = view.refresh()
		first.resolve(apps)
		await old
		expect(view.list.children).toHaveLength(0)
		expect(view.list.getAttribute('aria-busy')).toBe('true')
		second.resolve([apps[1]])
		await latest
		expect(view.list.firstElementChild.dataset.appid).toBe('wx-second')
		expect(view.list.hasAttribute('aria-busy')).toBe(false)
	})

	it('deduplicates opening across search rerenders and restores the current button after failure', async () => {
		const opened = deferred(), onOpen = vi.fn(() => opened.promise)
		const view = mount({ onOpen })
		await view.refresh()
		view.list.querySelector('button').click()
		search(view, 'FIRST')
		const button = view.list.querySelector('button')
		expect(button.disabled).toBe(true)
		// Clicking the row itself must also respect the in-flight operation.
		view.list.firstElementChild.click()
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(apps[0])
		opened.reject(new Error('窗口创建失败'))
		await vi.waitFor(() => expect(button.disabled).toBe(false))
		expect(view.state.getAttribute('role')).toBe('alert')
		expect(view.state.textContent).toContain('窗口创建失败')
	})

	it('refreshes after a successful import and treats cancellation as a non-error', async () => {
		const imported = deferred(), loadApps = vi.fn().mockResolvedValue(apps)
		const view = mount({ loadApps, refreshable: true, action: { label: '导入小程序', onClick: () => imported.promise, refreshAfter: true } })
		await view.refresh()
		view.actionButton.click()
		view.actionButton.click()
		expect(view.actionButton.disabled).toBe(true)
		imported.resolve(false)
		await vi.waitFor(() => expect(view.actionButton.disabled).toBe(false))
		expect(loadApps).toHaveBeenCalledOnce()
		expect(view.state.hidden).toBe(true)
		view.action.onClick = vi.fn().mockResolvedValue()
		view.actionButton.click()
		await vi.waitFor(() => expect(loadApps).toHaveBeenCalledTimes(2))
		expect(view.refreshButton.hidden).toBe(false)
	})

	it('keeps generated projects ahead of built-ins and passes their full identity to the host', async () => {
		const onOpen = vi.fn(), view = mount({ onOpen })
		await view.refresh()
		const generated = { appId: apps[0].appId, name: '本地项目', generated: true }
		view.setExtraApps([generated])
		view.list.firstElementChild.querySelector('button').click()
		expect(onOpen).toHaveBeenCalledExactlyOnceWith(generated)
		expect(view.list.firstElementChild.querySelector('.dimina-app__mini-used-logo').textContent).toBe('✳')
	})

	it('does not render, invoke host actions or refresh after destruction', async () => {
		const pending = deferred(), onOpen = vi.fn(), loadApps = vi.fn(() => pending.promise)
		const view = mount({ loadApps, onOpen })
		const refresh = view.refresh()
		view.destroy()
		view.destroy()
		pending.resolve(apps)
		await refresh
		expect(view.list.children).toHaveLength(0)
		view.refreshButton.click()
		await view.refresh()
		expect(loadApps).toHaveBeenCalledOnce()
		expect(onOpen).not.toHaveBeenCalled()
	})
})

describe('shared application metadata', () => {
	it('preserves supplied logos without touching canvas or browser storage', () => {
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
		const info = getAppInfo({ appId: 'explicit-logo', name: '显式图标', logo: 'https://example.test/logo.png' })
		expect(info.logo).toBe('https://example.test/logo.png')
		expect(getContext).not.toHaveBeenCalled()
	})
	it('shares the fallback logo with the launch screen even when session storage is blocked', () => {
		const canvas = { scale: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), measureText: () => ({ actualBoundingBoxAscent: 20, actualBoundingBoxDescent: 4 }) }
		const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas)
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,c2hhcmVk')
		vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } })
		const app = { appId: 'shared-logo', name: '公共图标' }
		expect(getAppInfo(app).logo).toBe('data:image/png;base64,c2hhcmVk')
		expect(getAppInfo(app).logo).toBe('data:image/png;base64,c2hhcmVk')
		expect(getContext).toHaveBeenCalledOnce()
		expect(app.logo).toBeUndefined()
	})
})
