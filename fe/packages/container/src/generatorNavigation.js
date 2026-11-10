/** Share the existing device between examples and the lazy AI workspace. */
export function createGeneratorNavigation({ device, container, onProjectsChanged, load = () => import('./generator.js') }) {
	const stage = device.root.querySelector('.device-stage')
	const editor = stage.querySelector('.device-stage__workspace')
	const statement = stage.querySelector('.device-stage__statement')
	const previewMount = document.createElement('div')
	previewMount.id = 'preview'
	previewMount.className = 'device-stage__generated-preview'
	previewMount.hidden = true
	device.appContainer.append(previewMount)
	let workspace, loading, revision = 0, mode = 'examples'
	const normalApplication = container.application
	const generatedApplication = {
		sleepActiveView: () => workspace?.hide(),
		wakeActiveView: () => workspace?.show(),
	}

	async function open(nextMode, projectId) {
		const request = ++revision
		const changed = mode !== nextMode
		mode = nextMode
		const generated = mode === 'generator'
		stage.classList.toggle('device-stage--generator', generated)
		device.root.classList.toggle('is-generator-active', generated)
		statement.hidden = generated
		editor.hidden = !generated
		previewMount.hidden = !generated
		normalApplication.el.hidden = generated
		if (changed) device.root.scrollTop = 0
		for (const button of stage.querySelectorAll('[data-demo-mode]')) button.setAttribute('aria-pressed', String(button.dataset.demoMode === mode))
		const url = new URL(location.href)
		if (generated) url.searchParams.set('workspace', 'generator')
		else url.searchParams.delete('workspace')
		history.replaceState(history.state, '', url)
		if (!generated) {
			workspace?.hide()
			device.open(normalApplication)
			if (!device.isScreenSleeping) normalApplication.wakeActiveView()
			return
		}
		normalApplication.sleepActiveView()
		device.open(generatedApplication)
		device.updateStatusBarColor('black')
		try {
			if (!workspace) {
				editor.textContent = '正在加载 AI 创建工作区…'
				loading ||= load().catch(error => { loading = undefined; throw error })
				const { mountGenerator } = await loading
				if (request !== revision) return
				workspace = mountGenerator({ root: editor, previewMount, onProjectsChanged })
			}
			if (request !== revision || device.isScreenSleeping) return
			await workspace.show(projectId)
		} catch (error) {
			if (request === revision) {
				const status = editor.querySelector('[role="status"]')
				if (status) { status.textContent = error.message; status.classList.add('error') }
				else editor.textContent = `AI 工作区加载失败：${error.message}`
			}
		}
	}
	for (const button of stage.querySelectorAll('[data-demo-mode]')) button.onclick = () => void open(button.dataset.demoMode)
	stage.addEventListener('click', event => {
		const jump = event.target.closest('[data-generator-jump]')
		if (!jump || mode !== 'generator') return
		const target = jump.dataset.generatorJump === 'preview' ? stage.querySelector('.device-stage__preview') : editor
		if (!target) return
		// Dismiss the keyboard before scrolling, and keep keyboard navigation at the destination.
		document.activeElement?.blur()
		target.tabIndex = -1
		target.focus({ preventScroll: true })
		target.scrollIntoView({ block: 'start' })
	})
	window.addEventListener('pagehide', () => workspace?.destroy(), { once: true })
	return { open }
}
