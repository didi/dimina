import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { preview } from 'vite'
import { chromium } from 'playwright'
import { strFromU8, unzipSync } from 'fflate'

// Exercise the built application, including packaged Worker/Wasm URLs. No live
// model credentials are needed: only the external model response is intercepted.
const root = process.env.DIMINA_TEST_APP_ROOT || fileURLToPath(new URL('../../container/', import.meta.url))
const server = await preview({ root, configFile: false, base: process.env.DIMINA_TEST_BASE || '/', preview: { host: '127.0.0.1', port: 0, open: false } })
const browser = await chromium.launch({ executablePath: process.env.DIMINA_CHROME_PATH, headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 950 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const source = {
	name: '喝水打卡',
	files: {
		'app.json': JSON.stringify({ pages: ['pages/index'], window: { navigationBarTitleText: '喝水打卡', navigationBarBackgroundColor: '#ffffff', navigationBarTextStyle: 'black' } }),
		'app.js': 'App({})',
		'utils/count.js': 'exports.next = value => value + 1',
		'pages/index.js': `const {next} = require('../utils/count'); Page({data:{count:0,note:'',history:[]}, onLoad(){wx.getStorage({key:'count',success:res=>this.setData({count:res.data||0})})}, add(){const count=next(this.data.count);this.setData({count,history:[{id:count,title:'第'+count+'杯'}]});wx.setStorage({key:'count',data:count})}, edit(e){this.setData({note:e.detail.value})}})`,
		'pages/index.wxml': '<view class="page"><text>今天喝了 {{count}} 杯水</text><button bindtap="add">喝一杯水</button><input placeholder="添加备注" bindinput="edit"/><text>{{note}}</text><view wx:if="{{count > 0}}">继续保持</view><view wx:for="{{history}}" wx:key="id">{{item.title}}</view></view>',
		'pages/index.wxss': '.page {padding:40rpx;} button,input {margin-top:30rpx;}',
	},
}
let requestCount = 0
let incoming
let chatRequest
const anthropicRequests = []
const artifacts = process.env.DIMINA_TEST_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
let releaseModel
const modelResponse = new Promise(resolve => { releaseModel = resolve })
await page.route('https://api.deepseek.com/**', async route => {
	if (new URL(route.request().url()).pathname !== '/chat/completions') {
		await route.fulfill({ status: 404, body: 'Not Found' })
		return
	}
	chatRequest = route.request().postDataJSON()
	requestCount++
	await modelResponse
	await route.fulfill({ json: { choices: [{ message: { role: 'assistant', content: JSON.stringify(source) }, finish_reason: 'stop' }] }, headers: { 'Access-Control-Allow-Origin': '*' } })
})
await page.route('https://model.example/generate', async route => {
	incoming = route.request().postDataJSON()
	requestCount++
	const result = structuredClone(source)
	if (requestCount === 2) result.files['pages/index.js'] = 'Page({'
	if (requestCount >= 3) result.files['pages/index.wxml'] = result.files['pages/index.wxml'].replace('今天喝了', '今日已喝')
	await route.fulfill({ json: result, headers: { 'Access-Control-Allow-Origin': '*' } })
})
await page.route('https://api.anthropic.com/**', async route => {
	if (new URL(route.request().url()).pathname !== '/v1/messages') {
		await route.fulfill({ status: 404, body: 'Not Found' })
		return
	}
	anthropicRequests.push({ body: route.request().postDataJSON(), headers: route.request().headers() })
	const result = structuredClone(source)
	if (anthropicRequests.length === 1) result.files['pages/index.js'] = 'Page({'
	result.files['pages/index.wxml'] = result.files['pages/index.wxml'].replace('今天喝了', '本日喝了')
	await route.fulfill({ json: { type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(result) }], stop_reason: 'end_turn' }, headers: { 'Access-Control-Allow-Origin': '*' } })
})
const idle = async () => {
	await page.waitForFunction(() => !document.getElementById('generate').disabled, null, { timeout: 90000 })
}
const screen = () => page.frameLocator('#preview-runtime > iframe').frameLocator('iframe')
const assertPreviewFillsScreen = async () => {
	const frame = await page.locator('#preview-runtime > iframe').boundingBox()
	const screen = await page.locator('.iphone__screen').boundingBox()
	assert.ok(Math.abs(frame.y - screen.y) < 1, 'Generated runtime must not reserve the host status bar twice')
	assert.ok(Math.abs(frame.height - screen.height) < 1, 'Generated runtime must use the same viewport height as the examples')
}
try {
	await page.goto(server.resolvedUrls.local[0])
	const demoPath = new URL(page.url()).pathname
	assert.equal(await page.locator('#iphone').count(), 1)
	await page.locator('.dimina-app__generator-link').click()
	await page.locator('#generate').waitFor()
	await page.evaluate(() => {
		window.generatorPhases = []
		const panel = document.getElementById('preview-status')
		new MutationObserver(() => { if (!panel.hidden) window.generatorPhases.push(panel.dataset.stage) }).observe(panel, { attributes: true, childList: true, subtree: true })
	})
	assert.equal(new URL(page.url()).pathname, demoPath)
	assert.equal(await page.locator('#iphone').count(), 1)
	await page.locator('.studio-settings').evaluate(element => { element.open = true })
	assert.equal(await page.locator('#protocol').inputValue(), 'chat-completions')
	await page.locator('#endpoint').fill('https://api.deepseek.com')
	await page.locator('#model').fill('deepseek-flash')
	await page.locator('#token').fill('ephemeral-test-token')
	await page.locator('#prompt').fill('做一个喝水打卡工具')
	await page.locator('#generate').click()
	await page.locator('#preview-status-title').getByText('模型正在生成源码…', { exact: true }).waitFor()
	assert.equal(await page.locator('#preview-status').isVisible(), true)
	assert.equal(await page.locator('#preview-runtime').evaluate(element => element.inert), true)
	if (artifacts) {
		await page.screenshot({ path: `${artifacts}/generator-progress-desktop.png`, fullPage: true })
		await page.locator('#iphone').screenshot({ path: `${artifacts}/simulator-progress.png` })
	}
	for (const width of [320, 375, 414, 768]) {
		await page.setViewportSize({ width, height: 844 })
		await page.locator('#preview-status').scrollIntoViewIfNeeded()
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
		assert.equal(await page.locator('#preview-status').evaluate(element => element.scrollWidth <= element.clientWidth), true)
		if (artifacts) await page.screenshot({ path: `${artifacts}/generator-progress-${width}.png`, fullPage: true })
	}
	await page.emulateMedia({ reducedMotion: 'reduce' })
	assert.equal(await page.locator('.studio-preview-status__indicator').evaluate(element => getComputedStyle(element, '::before').animationName), 'none')
	await page.emulateMedia({ reducedMotion: 'no-preference' })
	await page.setViewportSize({ width: 1280, height: 950 })
	releaseModel()
	await idle()
	assert.match(await page.locator('#status').textContent(), /已保存/)
	assert.equal(await page.locator('#preview-status').isVisible(), false)
	const phases = await page.evaluate(() => window.generatorPhases)
	for (const phase of ['generating', 'compiling', 'starting', 'saving']) assert.ok(phases.includes(phase), `Missing simulator phase: ${phase}`)
	assert.equal(chatRequest.model, 'deepseek-flash')
	assert.equal(chatRequest.stream, false)
	assert.equal(chatRequest.messages[0].role, 'system')
	assert.equal(chatRequest.messages.at(-1).content, '做一个喝水打卡工具')
	await screen().getByText('今天喝了 0 杯水', { exact: true }).waitFor()
	await assertPreviewFillsScreen()
	await screen().getByText('喝一杯水', { exact: true }).click()
	await screen().getByText('今天喝了 1 杯水', { exact: true }).waitFor()
	await screen().getByText('第1杯', { exact: true }).waitFor()
	await screen().locator('input.dd-input').fill('下午')
	await screen().getByText('下午', { exact: true }).waitFor()
	const id = await page.locator('#projects').inputValue()
	await page.waitForFunction(() => Object.values(localStorage).some(value => value.includes('count')))
	const renderFrame = page.frames().at(-1)
	assert.equal(await renderFrame.evaluate(() => { try { return Boolean(top.document) } catch { return false } }), false)
	assert.equal(await renderFrame.evaluate(() => { try { return Boolean(localStorage.length) } catch { return false } }), false)
	await page.locator('#protocol').selectOption('gateway')
	await page.locator('#endpoint').fill('https://model.example/generate')
	assert.equal(await page.locator('#model-optional').isVisible(), true)
	await page.locator('#prompt').fill('修改标题，保留数据')
	await page.locator('#generate').click()
	await idle()
	assert.equal(requestCount, 3)
	assert.match(incoming.messages.at(-1).content, /编译失败/)
	assert.ok(await page.evaluate(() => window.generatorPhases.includes('repairing')))
	await screen().getByText('今日已喝 1 杯水', { exact: true }).waitFor()
	assert.equal(await page.locator('#version').textContent(), '版本 2')
	await page.locator('#rollback').click()
	await idle()
	await screen().getByText('今天喝了 1 杯水', { exact: true }).waitFor()
	await page.locator('#protocol').selectOption('anthropic-messages')
	await page.locator('#endpoint').fill('https://api.anthropic.com/v1')
	await page.locator('#model').fill('my-claude-model')
	assert.equal(await page.locator('#model-optional').isVisible(), false)
	await page.locator('#prompt').fill('修改标题，仍然保留喝水记录')
	await page.locator('#generate').click()
	await idle()
	assert.match(await page.locator('#status').textContent(), /已保存/)
	assert.equal(anthropicRequests.length, 2)
	const anthropic = anthropicRequests[1]
	assert.equal(anthropic.headers['x-api-key'], 'ephemeral-test-token')
	assert.equal(anthropic.headers.authorization, undefined)
	assert.equal(anthropic.headers['anthropic-version'], '2023-06-01')
	assert.equal(anthropic.headers['anthropic-dangerous-direct-browser-access'], 'true')
	assert.equal(anthropic.body.model, 'my-claude-model')
	assert.equal(typeof anthropic.body.system, 'string')
	assert.equal(anthropic.body.max_tokens, 8192)
	assert.equal(anthropic.body.stream, false)
	assert.equal(anthropic.body.messages.some(message => message.role === 'system'), false)
	assert.match(anthropic.body.messages[0].content, /app\.json/)
	assert.match(anthropic.body.messages.at(-1).content, /编译失败/)
	await screen().getByText('本日喝了 1 杯水', { exact: true }).waitFor()
	assert.equal(await page.locator('#version').textContent(), '版本 2')
	await page.locator('#rollback').click()
	await idle()
	await screen().getByText('今天喝了 1 杯水', { exact: true }).waitFor()
	await page.reload()
	await page.locator(`#projects option[value="${id}"]`).waitFor({ state: 'attached' })
	assert.equal(await page.locator('#token').inputValue(), '')
	await context.setOffline(true)
	await page.locator('#projects').selectOption(id)
	await idle()
	await screen().getByText('今天喝了 1 杯水', { exact: true }).waitFor()
	await screen().getByText('喝一杯水', { exact: true }).click()
	await screen().getByText('今天喝了 2 杯水', { exact: true }).waitFor()
	await page.locator('#source-panel').evaluate(element => { element.open = true })
	for (const [file, language, token] of [
		['app.json', 'json', '.token.property'],
		['pages/index.wxml', 'wxml', '.token.interpolation'],
		['pages/index.wxss', 'css', '.token.selector'],
		['pages/index.js', 'javascript', '.token.keyword'],
	]) {
		await page.locator('#files').selectOption(file)
		assert.equal(await page.locator('.source-code-editor').getAttribute('data-language'), language)
		assert.ok(await page.locator(`.source-code-highlight ${token}`).count())
		assert.equal(await page.locator('.source-code-highlight').getAttribute('aria-hidden'), 'true')
	}
	const originalSource = await page.locator('#source').inputValue()
	await page.locator('#source').focus()
	await page.keyboard.press('ControlOrMeta+End')
	await page.keyboard.insertText('\n// 原生撤销测试')
	await page.keyboard.press('ControlOrMeta+z')
	assert.equal(await page.locator('#source').inputValue(), originalSource)
	await page.locator('#source').dispatchEvent('compositionstart')
	assert.equal(await page.locator('.source-code-highlight').evaluate(element => getComputedStyle(element).visibility), 'hidden')
	assert.notEqual(await page.locator('#source').evaluate(element => getComputedStyle(element).color), 'rgba(0, 0, 0, 0)')
	await page.locator('#source').dispatchEvent('compositionend')
	const scrollSource = `// ${'长行'.repeat(180)}\n${Array.from({ length: 70 }, (_, index) => `const item${index} = "测试滚动";`).join('\n')}\n`
	await page.locator('#source').fill(scrollSource)
	await page.waitForFunction(() => document.querySelector('.source-code-highlight').textContent.includes('item69'))
	const offsets = await page.locator('#source').evaluate(element => {
		element.scrollTop = 180; element.scrollLeft = 90; element.dispatchEvent(new Event('scroll'))
		const layer = document.querySelector('.source-code-highlight')
		return { top: element.scrollTop, left: element.scrollLeft, highlightTop: layer.scrollTop, highlightLeft: layer.scrollLeft }
	})
	assert.ok(offsets.top > 0 && offsets.left > 0)
	assert.equal(offsets.top, offsets.highlightTop)
	assert.equal(offsets.left, offsets.highlightLeft)
	await page.locator('#files').selectOption('app.json')
	await page.locator('#files').selectOption('pages/index.js')
	assert.equal(await page.locator('#source').inputValue(), scrollSource)
	if (artifacts) await page.locator('#source-content').screenshot({ path: `${artifacts}/syntax-highlight.png` })
	await page.locator('#files').selectOption('pages/index.js')
	await page.locator('#source').fill('Page({')
	await context.setOffline(false)
	await page.locator('#rebuild').click()
	await idle()
	assert.match(await page.locator('#status').textContent(), /Unexpected|EOF|Expected|Parse|预期|结束/i)
	assert.equal(await page.locator('#preview-status').getAttribute('data-state'), 'error')
	assert.equal(await page.locator('#preview-resume').isVisible(), true)
	await screen().getByText('今天喝了 2 杯水', { exact: true }).waitFor()
	assert.equal(await page.locator('#version').textContent(), '版本 1')
	await page.locator('#preview-resume').click()
	assert.equal(await page.locator('#preview-status').isVisible(), false)
	assert.equal(await page.locator('#preview-runtime').evaluate(element => element.inert), false)
	await page.locator('#source').fill(source.files['pages/index.js'])
	await page.locator('#rebuild').click()
	await idle()
	assert.match(await page.locator('#status').textContent(), /已保存/)
	await screen().getByText('今天喝了 2 杯水', { exact: true }).waitFor()
	await page.locator('#files').selectOption('pages/index.wxml')
	const exportedWxml = `${source.files['pages/index.wxml']}<text>待导出的草稿</text>`
	await page.locator('#source').fill(exportedWxml)
	const downloadPromise = page.waitForEvent('download')
	await page.locator('#export').click()
	const download = await downloadPromise
	assert.equal(download.suggestedFilename(), `${source.name}.zip`)
	const archive = await readFile(await download.path())
	const exported = unzipSync(archive)
	for (const [path, content] of Object.entries(source.files)) assert.equal(strFromU8(exported[path]), path === 'pages/index.wxml' ? exportedWxml : content)
	assert.equal(JSON.parse(strFromU8(exported['project.config.json'])).compileType, 'miniprogram')
	assert.ok(exported['README.md'])
	assert.equal(Object.values(exported).some(data => strFromU8(data).includes('ephemeral-test-token')), false)
	if (artifacts) await download.saveAs(`${artifacts}/${download.suggestedFilename()}`)
	await page.locator('#source-panel').evaluate(element => { element.open = false })
	await page.locator('.studio-settings').evaluate(element => { element.open = false })
	await page.locator('[data-demo-mode="examples"]').click()
	await page.locator(`.dimina-app__mini-used-list-item[data-appid="${id}"]`).waitFor()
	assert.equal(new URL(page.url()).pathname, demoPath)
	assert.equal(new URL(page.url()).searchParams.has('workspace'), false)
	await page.locator(`.dimina-app__mini-used-list-item[data-appid="${id}"]`).click()
	await idle()
	await screen().getByText('今天喝了 2 杯水', { exact: true }).waitFor()
	if (artifacts) {
		await page.screenshot({ path: `${artifacts}/generator-desktop.png`, fullPage: true })
		await page.locator('#iphone').screenshot({ path: `${artifacts}/navbar-desktop.png` })
	}
	await page.setViewportSize({ width: 390, height: 844 })
	await assertPreviewFillsScreen()
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
	await page.locator('.device-stage__preview').scrollIntoViewIfNeeded()
	await screen().getByText('喝一杯水', { exact: true }).click()
	await screen().getByText('今天喝了 3 杯水', { exact: true }).waitFor()
	if (artifacts) {
		await page.screenshot({ path: `${artifacts}/generator-mobile.png`, fullPage: true })
		await page.locator('#iphone').screenshot({ path: `${artifacts}/navbar-mobile.png` })
	}
	await page.locator('#import').setInputFiles({ name: download.suggestedFilename(), mimeType: 'application/zip', buffer: archive })
	await idle()
	assert.match(await page.locator('#status').textContent(), /已保存/)
	assert.notEqual(await page.locator('#projects').inputValue(), id)
	await screen().getByText('待导出的草稿', { exact: true }).waitFor()
	await screen().getByText('今天喝了 0 杯水', { exact: true }).waitFor()
	await page.locator('#projects').selectOption(id)
	await idle()
	await screen().getByText('今天喝了 3 杯水', { exact: true }).waitFor()
	const customNavigation = { name: '自定义导航', files: {
		'app.js': 'App({})',
		'app.json': JSON.stringify({ pages: ['pages/index'], window: { navigationStyle: 'custom' } }),
		'pages/index.js': 'Page({data:{statusBarHeight:0},onLoad(){this.setData({statusBarHeight:wx.getSystemInfoSync().statusBarHeight})}})',
		'pages/index.wxml': '<view class="custom-header" style="padding-top:{{statusBarHeight}}px">自定义导航</view>',
		'pages/index.wxss': '.custom-header {height:44px;box-sizing:content-box;display:flex;align-items:center;justify-content:center;}',
	} }
	await page.locator('#import').setInputFiles({ name: 'custom-navigation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(customNavigation)) })
	await idle()
	assert.match(await page.locator('#status').textContent(), /已保存/)
	await assertPreviewFillsScreen()
	const statusHeight = await page.locator('.iphone__status-bar').evaluate(element => element.offsetHeight)
	assert.equal(await screen().locator('.custom-header').evaluate(element => getComputedStyle(element).paddingTop), `${statusHeight}px`)
	if (artifacts) await page.locator('#iphone').screenshot({ path: `${artifacts}/navbar-custom.png` })
	assert.deepEqual(errors, [])
	console.log('Passed: syntax highlighting, native undo/composition, scroll alignment and per-file drafts, full simulator viewport and custom-navigation status-bar geometry, complete source ZIP export/import with editor drafts, Anthropic Messages authentication/context/repair, simulator generation/repair/compile/start/save states, responsive progress and reduced motion, Chat Completions base URL, custom model gateway, browser compiler, live events/input/loops, isolated preview, storage, repair, rollback, offline reopen, failed-edit preservation, mobile layout.')
} catch (error) {
	console.error('Studio status:', await page.locator('#status').textContent())
	// eslint-disable-next-line unicorn/prefer-dom-node-text-content -- Playwright innerText returns only rendered app text.
	for (const frame of page.frames().slice(1)) console.error('Preview:', (await frame.locator('body').innerText().catch(() => '')).slice(0, 600))
	console.error('Browser errors:', errors)
	throw error
} finally {
	await browser.close()
	await new Promise(resolve => server.httpServer.close(resolve))
}
