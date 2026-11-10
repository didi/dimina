import { createGenerator, createHttpProvider, createPreview, createProjectStore, compileProject, parseProject, createSourceArchive, readSourceProject } from '@dimina/generator'
import './styles/generator.scss'
import diminaLogo from './assets/dimina-logo.png'
import { createSourceHighlight } from './sourceHighlight.js'

const progressStages = {
	generating: { title: '模型正在生成源码…', detail: '正在把你的想法变成页面和交互。', step: 0 },
	repairing: { title: '正在修复工程错误…', detail: '模型正在根据检查结果调整源码。', step: 0 },
	compiling: { title: '正在浏览器中编译…', detail: '正在处理小程序的页面、样式和逻辑。', step: 1 },
	starting: { title: '正在启动小程序…', detail: '启动完成后将自动进入预览。', step: 2 },
	saving: { title: '正在保存小程序…', detail: '正在保存到当前浏览器。', step: 2 },
	loading: { title: '正在打开本地小程序…', detail: '正在恢复已保存的应用。', step: 2 },
}

export function mountGenerator({ root, previewMount, onProjectsChanged = () => {}, onProjectChange = () => {} }) {
	root.classList.add('generator-panel')
	root.innerHTML = `
	 <section class="studio-editor" aria-label="小程序生成工作区">
	  <div class="studio-heading"><span class="studio-eyebrow">AI 小程序实验室</span><h1>把想法变成小程序。</h1><p>连接你的模型，在浏览器里生成、编译和运行。</p></div>
	  <div class="studio-preview-meta"><span id="app-name">新建小程序</span><span id="version">尚未生成</span><button type="button" class="device-stage__jump" data-generator-jump="preview">预览 ↓</button></div>
	  <details class="studio-settings"><summary>模型连接</summary><div class="studio-settings-fields"><label for="protocol">接口协议</label><div class="studio-select"><select id="protocol" aria-describedby="model-help"><button class="studio-select__value" type="button"><selectedcontent></selectedcontent></button><option value="chat-completions">OpenAI 兼容（DeepSeek 等）</option><option value="anthropic-messages">Anthropic Messages（Claude 等）</option><option value="gateway">自定义工程网关</option></select></div><label for="endpoint">模型接口地址</label><input id="endpoint" autocapitalize="off" autocorrect="off" type="url" placeholder="https://api.deepseek.com" autocomplete="off" spellcheck="false" aria-describedby="model-help"><label for="model">模型名称 <span id="model-optional" hidden>可选</span></label><input id="model" autocapitalize="off" autocorrect="off" placeholder="例如 deepseek-flash" autocomplete="off" spellcheck="false" aria-required="true"><label for="token">访问令牌 <span>可选 · 仅本次页面使用</span></label><input id="token" autocapitalize="off" autocorrect="off" type="password" placeholder="填写模型服务所需的令牌" autocomplete="off"><p id="model-help">填写服务基础地址或完整的 /chat/completions 地址，基础地址会自动补全路径。服务需允许当前页面跨域访问。</p></div></details>
	  <form id="generate-form"><label for="prompt" class="studio-label">你想做什么？</label><textarea id="prompt" rows="4" required placeholder="做一个喝水打卡小程序，记录今天喝了几杯水，关闭后也能保留。"></textarea><div class="studio-suggestions"><button type="button" data-prompt="做一个喝水打卡小程序，记录每天喝水的杯数，可以增加、撤销并查看历史，数据保存在本地。">喝水打卡</button><button type="button" data-prompt="做一个待办清单，可以添加任务、完成任务和删除任务，数据保存在本地。">待办清单</button><button type="button" data-prompt="做一个旅行记账本，可以记录金额、分类和备注，展示总支出，数据保存在本地。">旅行记账</button></div><div class="studio-actions"><button id="generate" class="studio-primary">生成小程序 <span>↗</span></button><button id="cancel" type="button" hidden>停止</button><button id="new" type="button">新建</button></div></form>
	  <p id="status" role="status" aria-live="polite">生成的源码和应用保存在当前浏览器中。</p>
	  <div class="studio-projects"><label for="projects">我的小程序</label><div class="studio-select"><select id="projects"><button class="studio-select__value" type="button"><selectedcontent></selectedcontent></button><option value="">选择已保存的小程序</option></select></div><div class="studio-actions studio-project-actions"><button id="export" disabled>导出源码</button><button id="import-trigger" type="button">导入源码</button><input id="import" type="file" accept="application/zip,.zip,application/json,.json" hidden><button id="rollback" disabled>恢复上一版</button><button id="delete" class="studio-danger" disabled>删除</button></div></div>
	  <details id="source-panel"><summary>查看和编辑源码</summary><p id="source-empty" class="studio-empty-hint">生成或导入小程序后，可以在这里查看和编辑源码。</p><div id="source-content" hidden><div class="studio-select"><select id="files" aria-label="选择源码文件" disabled><button class="studio-select__value" type="button"><selectedcontent></selectedcontent></button></select></div><div class="source-code-editor"><pre class="source-code-highlight" aria-hidden="true"><code></code></pre><textarea id="source" rows="12" wrap="off" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" aria-label="源码内容" disabled></textarea></div><button id="rebuild" disabled>本地编译并运行</button></div></details>
	 </section>`
	previewMount.innerHTML = `<div id="preview-empty"><img src="${diminaLogo}" alt="" aria-hidden="true"><h2>你的小程序将在这里运行</h2><p>描述一个想法，或导入已有源码。</p></div><div id="preview-runtime"></div>
	 <section id="preview-status" class="studio-preview-status" aria-labelledby="preview-status-title" hidden>
	  <div class="studio-preview-status__body"><div class="studio-preview-status__indicator" aria-hidden="true"><img src="${diminaLogo}" alt=""><span id="preview-status-symbol"></span></div><h2 id="preview-status-title"></h2><p id="preview-status-detail"></p>
	   <ol id="preview-steps" aria-label="生成进度"><li>生成源码</li><li>本地编译</li><li>启动运行</li></ol><p id="preview-status-hint"></p><button id="preview-resume" type="button" hidden>返回小程序</button></div>
	 </section>`

	const $ = id => root.querySelector(`#${id}`) || previewMount.querySelector(`#${id}`)
	const sourceHighlight = createSourceHighlight({ input: $('source'), layer: root.querySelector('.source-code-highlight') })
	$('source-panel').addEventListener('toggle', () => { if ($('source-panel').open) sourceHighlight.refresh() })
	const setOptions = (select, options) => {
		// Keep the selected-value slot when replacing the project/file options.
		// Browsers without customizable selects discard the optional button.
		const button = select.querySelector('button')
		select.replaceChildren(...(button ? [button] : []), ...options)
	}
	$('protocol').onchange = () => {
		const chat = $('protocol').value === 'chat-completions'
		const anthropic = $('protocol').value === 'anthropic-messages'
		$('endpoint').placeholder = anthropic ? 'https://api.anthropic.com' : chat ? 'https://api.deepseek.com' : 'https://your-service.example/generate'
		$('model').placeholder = anthropic ? '填写服务提供的模型名称' : chat ? '例如 deepseek-flash' : '由你的网关决定'
		$('model').setAttribute('aria-required', String(chat || anthropic))
		$('model-optional').hidden = chat || anthropic
		const tokenLabel = root.querySelector('label[for="token"]')
		tokenLabel.firstChild.textContent = anthropic ? 'API Key ' : '访问令牌 '
		tokenLabel.querySelector('span').textContent = anthropic ? '仅本次页面使用' : '可选 · 仅本次页面使用'
		$('token').placeholder = anthropic ? '填写模型服务的 API Key' : '填写模型服务所需的令牌'
		$('model-help').textContent = anthropic ? '填写服务基础地址、/v1 或完整的 /v1/messages 地址，基础地址会自动补全路径。服务需允许当前页面跨域访问。' : chat ? '填写服务基础地址或完整的 /chat/completions 地址，基础地址会自动补全路径。服务需允许当前页面跨域访问。' : '填写完整网关地址；网关需接收生成指令并返回小程序工程 JSON，同时允许当前页面跨域访问。'
	}
	const store = createProjectStore()
	let active = false, destroyed = false
	let pendingOperation = Promise.resolve()
	let project, controller, busy = false, selectedFile
	const status = (text, error = false, stage) => {
		if (destroyed) return
		$('status').textContent = text
		$('status').classList.toggle('error', error)
		const progress = progressStages[stage]
		const stopped = stage === 'stopped'
		const panel = $('preview-status')
		panel.hidden = !progress && !error && !stopped
		panel.dataset.state = progress ? 'busy' : error ? 'error' : 'stopped'
		panel.dataset.stage = stage || ''
		if (!panel.hidden) {
			$('preview-status-title').textContent = progress?.title || (stopped ? '操作已停止' : '暂时无法完成')
			$('preview-status-detail').textContent = progress?.detail || text
			$('preview-status-symbol').textContent = error ? '!' : stopped ? 'Ⅱ' : ''
			$('preview-status-hint').textContent = project ? '上一个已保存版本仍然保留。' : progress ? '完成后会自动显示小程序。' : '可以调整配置或需求后重新尝试。'
			$('preview-steps').hidden = !progress
			for (const [index, item] of [...$('preview-steps').children].entries()) {
				item.dataset.state = index < progress?.step ? 'done' : index === progress?.step ? 'current' : 'pending'
				if (index === progress?.step) item.setAttribute('aria-current', 'step')
				else item.removeAttribute('aria-current')
			}
			$('preview-resume').hidden = Boolean(progress) || !project
			$('preview-resume').disabled = busy
		}
		$('preview-runtime').inert = busy || !panel.hidden
	}
	const progress = stage => status(progressStages[stage].title, false, stage)
	const statusBarHeight = previewMount.closest('.iphone__screen')?.querySelector('.iphone__status-bar')?.offsetHeight || 0
	const preview = createPreview({ mount: $('preview-runtime'), statusBarHeight, onRuntimeError: error => status(`运行错误：${error}`, true) })
	$('preview-resume').onclick = () => { $('preview-status').hidden = true; $('preview-runtime').inert = busy }
	const previousVersion = value => value ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'previous')) : undefined
	function setBusy(value) {
		if (destroyed) return
		busy = value
		$('preview-runtime').inert = value || !$('preview-status').hidden
		for (const id of ['generate', 'new', 'projects', 'rebuild', 'import', 'import-trigger', 'export', 'rollback', 'delete', 'source', 'files']) $(id).disabled = value || (['rebuild', 'delete', 'source', 'files', 'export'].includes(id) && !project) || (id === 'rollback' && !project?.previous)
		$('generate-form').setAttribute('aria-busy', String(value))
		$('cancel').hidden = !value
		$('preview-resume').disabled = value
	}
	async function refreshProjects() {
		const entries = await store.list()
		setOptions($('projects'), [new Option('选择已保存的小程序', ''), ...entries.map(entry => new Option(entry.name, entry.id))])
		$('projects').value = project?.id || ''
		onProjectsChanged(entries)
	}
	function showSource() {
		setOptions($('files'), Object.keys(project?.files || {}).map(path => new Option(path, path)))
		selectedFile = $('files').value
		$('source').value = project?.files[selectedFile] || ''
		sourceHighlight.setFile(selectedFile)
		$('export').disabled = !project
		$('app-name').textContent = project?.name || '新建小程序'
		$('app-name').title = project?.name || '新建小程序'
		$('version').textContent = project ? `版本 ${project.version}` : '尚未生成'
		$('generate').firstChild.textContent = project ? '修改小程序 ' : '生成小程序 '
		$('preview-empty').hidden = Boolean(project)
		$('source-content').hidden = !project
		$('source-empty').hidden = Boolean(project)
		onProjectChange(project)
	}
	async function accept(candidate) {
		progress('starting')
		await preview.open(candidate, { signal: controller?.signal, beforeCommit: () => { progress('saving'); return store.put(candidate) } })
		project = candidate
		showSource()
		await refreshProjects()
		status('已保存到当前浏览器。可以继续描述想修改的地方。')
	}
	function operate(action) {
		if (busy) return pendingOperation
		controller = new AbortController()
		setBusy(true)
		pendingOperation = (async () => {
			try { await action() }
			catch (error) { if (active) status(error.name === 'AbortError' ? (project ? '已停止，保留上个已保存的版本。' : '已停止，可以重新描述需求后生成。') : error.message, error.name !== 'AbortError', error.name === 'AbortError' ? 'stopped' : undefined) }
			finally { controller = undefined; setBusy(false) }
		})()
		return pendingOperation
	}
	async function openProject(id) {
		return operate(async () => {
			progress('loading')
			const candidate = await store.get(id)
			if (!candidate) throw new Error('本地小程序已不存在')
			await preview.open(candidate, { signal: controller.signal })
			project = candidate; showSource(); $('projects').value = id
			status('已打开本地保存的小程序。')
		})
	}
	$('generate-form').onsubmit = event => {
		event.preventDefault()
		void operate(async () => {
			if (!$('endpoint').value.trim()) { root.querySelector('.studio-settings').open = true; $('endpoint').focus(); throw new Error('请先填写你自己的模型接口地址。') }
			const protocol = $('protocol').value
			if (protocol !== 'gateway' && !$('model').value.trim()) { root.querySelector('.studio-settings').open = true; $('model').focus(); throw new Error('请填写模型名称。') }
			const token = $('token').value.trim()
			const headers = token ? (protocol === 'anthropic-messages' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }) : {}
			const provider = createHttpProvider({ url: $('endpoint').value.trim(), protocol, model: $('model').value.trim() || undefined, headers })
			const generator = createGenerator({ provider, onProgress: ({ stage }) => progress(stage) })
			const candidate = await generator.generate({ prompt: $('prompt').value, project, signal: controller.signal })
			candidate.previous = previousVersion(project)
			await accept(candidate)
			$('prompt').value = ''
		})
	}
	$('cancel').onclick = () => controller?.abort()
	$('new').onclick = () => { project = undefined; preview.destroy(); showSource(); $('projects').value = ''; $('prompt').value = ''; setBusy(false); status('描述一个新想法，开始创建。') }
	root.querySelectorAll('[data-prompt]').forEach(button => { button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus() } })
	$('projects').onchange = () => { if ($('projects').value) void openProject($('projects').value) }
	$('files').onchange = () => { selectedFile = $('files').value; $('source').value = project?.files[selectedFile] || '' }
	// Keep drafts separate from the saved project until compilation and preview succeed.
	const drafts = new Map()
	$('source').oninput = () => { if (project && selectedFile) drafts.set(`${project.id}:${selectedFile}`, $('source').value) }
	$('files').addEventListener('change', () => { $('source').value = drafts.get(`${project?.id}:${selectedFile}`) ?? $('source').value; sourceHighlight.setFile(selectedFile) })
	$('rebuild').onclick = () => void operate(async () => {
		const files = Object.fromEntries(Object.entries(project.files).map(([path, content]) => [path, drafts.get(`${project.id}:${path}`) ?? content]))
		parseProject({ name: project.name, files })
		progress('compiling')
		const resources = await compileProject(files, { appId: project.id, name: project.name }, { signal: controller.signal })
		await accept({ ...project, files, resources, version: project.version + 1, previous: previousVersion(project), updatedAt: Date.now() })
		drafts.clear()
	})
	$('rollback').onclick = () => void operate(async () => {
		const previous = project.previous
		await accept({ ...previous, previous: previousVersion(project), updatedAt: Date.now() })
	})
	$('delete').onclick = () => void operate(async () => {
		await store.delete(project.id)
		localStorage.removeItem(`dimina-generated-data:${project.id}`)
		project = undefined; preview.destroy(); showSource(); await refreshProjects(); status('已删除小程序及其本地数据。')
	})
	$('export').onclick = () => void operate(async () => {
		const edits = Object.fromEntries(Object.keys(project.files).map(path => [path, drafts.get(`${project.id}:${path}`)]))
		const archive = createSourceArchive(project, edits)
		const url = URL.createObjectURL(new Blob([archive.data], { type: 'application/zip' }))
		const anchor = document.createElement('a'); anchor.href = url; anchor.download = archive.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
		status('已导出完整小程序项目源码（ZIP），包含当前源码编辑。')
	})
	$('import-trigger').onclick = () => $('import').click()
	$('import').onchange = () => void operate(async () => {
		const file = $('import').files[0]
		if (!file) return
		const source = await readSourceProject(file)
		const id = `generated-${crypto.randomUUID()}`
		progress('compiling')
		const resources = await compileProject(source.files, { appId: id, name: source.name }, { signal: controller.signal })
		await accept({ id, ...source, resources, version: 1, messages: [], updatedAt: Date.now() })
		$('import').value = ''
	})
	const close = () => { active = false; controller?.abort(); preview.destroy(); status('生成的源码和应用保存在当前浏览器中。') }
	window.addEventListener('pagehide', close)
	showSource()
	setBusy(false)
	return {
		async show(projectId) {
			active = true
			await pendingOperation
			if (!active) return
			await refreshProjects()
			if (!active) return
			if (projectId) await openProject(projectId)
			else if (project) await operate(async () => { progress('loading'); await preview.open(project, { signal: controller.signal }); status('已打开本地保存的小程序。') })
			else status('生成的源码和应用保存在当前浏览器中。')
		},
		hide: close,
		destroy() { close(); destroyed = true; sourceHighlight.destroy(); window.removeEventListener('pagehide', close); root.replaceChildren(); previewMount.replaceChildren() },
	}
}
