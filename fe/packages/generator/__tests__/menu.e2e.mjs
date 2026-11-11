import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium } from 'playwright'

const server = await preview({ root: fileURLToPath(new URL('../../container/', import.meta.url)), configFile: false, base: '/', preview: { host: '127.0.0.1', port: 0, open: false } })
const browser = await chromium.launch({ executablePath: process.env.DIMINA_CHROME_PATH, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 950 } })
const artifacts = process.env.DIMINA_TEST_ARTIFACTS
if (artifacts) await mkdir(artifacts, { recursive: true })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const isolated = () => page.frameLocator('#preview-runtime > iframe')
const screen = () => isolated().frameLocator('iframe')
// Capsule controls live in an opaque iframe inside the scaled host device.
// Dispatch their DOM click so coordinate rounding does not mask menu behavior.
const openMenu = async () => {
	await page.locator('#iphone').scrollIntoViewIfNeeded()
	await isolated().locator('.dimina-mini-app-navigation__actions-variable').evaluate(element => element.click())
	await isolated().locator('.dimina-mini-app-menu.show').waitFor()
}
const idle = () => page.waitForFunction(() => !document.getElementById('generate').disabled, null, { timeout: 90000 })
const source = { name: '菜单回归测试', files: {
	'app.json': JSON.stringify({ pages: ['pages/index/index'], window: { navigationBarTitleText: '菜单回归测试', navigationBarTextStyle: 'white', navigationBarBackgroundColor: '#26394d' } }),
	'app.js': 'App({})',
	'pages/index/index.js': "Page({data:{count:0},onLoad(){wx.getStorage({key:'count',success:res=>this.setData({count:res.data||0})})},add(){const count=this.data.count+1;this.setData({count});wx.setStorage({key:'count',data:count})},exit(){wx.exitMiniProgram({})}})",
	'pages/index/index.wxml': '<view style="padding:32rpx"><text>Count {{count}}</text><button bindtap="add">Increment</button><button bindtap="exit">Exit API</button></view>',
} }
try {
	await page.goto(`${server.resolvedUrls.local[0]}?workspace=generator`)
	await page.locator('#generate').waitFor()
	await page.locator('#import').setInputFiles({ name: 'menu.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) })
	await idle()
	await screen().getByText('Count 0', { exact: true }).waitFor()
	await screen().getByText('Increment', { exact: true }).click()
	await screen().getByText('Count 1', { exact: true }).waitFor()
	await page.waitForFunction(() => Object.values(localStorage).some(value => value.includes('count')))
	if (process.env.DIMINA_MENU_CASE !== 'close') {
		for (const width of [1280, 320, 375, 414]) {
			await page.setViewportSize({ width, height: 950 })
			await openMenu()
			const menu = isolated().locator('.dimina-mini-app-menu.show')
			const cancel = menu.getByRole('button', { name: '取消', exact: true })
			await menu.waitFor()
			await menu.evaluate(async element => { element.getBoundingClientRect(); await Promise.all(element.getAnimations().map(animation => animation.finished)) })
			if (artifacts) await page.locator('#iphone').screenshot({ path: `${artifacts}/menu-${width}.png` })
			const bounds = await menu.boundingBox(), footer = await cancel.boundingBox()
			assert.ok(footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height, `Menu footer must be fully visible at ${width}px`)
			assert.equal(await menu.locator('.dimina-mini-app-menu__app-name').textContent(), source.name)
			assert.equal(await menu.locator('.dimina-mini-app-menu__app-logo-img').isVisible(), false)
			await cancel.evaluate(element => element.click())
			await menu.waitFor({ state: 'hidden' })
		}
		await page.locator('#preview-runtime > iframe').evaluate(frame => { frame.style.height = '220px' })
		await openMenu()
		const menu = isolated().locator('.dimina-mini-app-menu.show')
		assert.equal(await menu.evaluate(element => getComputedStyle(element).overflowY), 'auto')
		const cancel = menu.getByRole('button', { name: '取消', exact: true })
		await cancel.scrollIntoViewIfNeeded()
		const shortMenu = await menu.boundingBox(), shortFooter = await cancel.boundingBox()
		assert.ok(shortFooter.y + shortFooter.height <= shortMenu.y + shortMenu.height, 'The footer can be reached in short embedded viewports')
		if (artifacts) await page.locator('#preview-runtime > iframe').screenshot({ path: `${artifacts}/menu-short.png` })
		await cancel.evaluate(element => element.click())
		await menu.waitFor({ state: 'hidden' })
		await page.locator('#preview-runtime > iframe').evaluate(frame => { frame.style.height = '100%' })
	}
	if (process.env.DIMINA_MENU_CASE !== 'layout') {
		for (const close of ['menu', 'capsule', 'api']) {
			if (close === 'menu') {
				await openMenu()
				await isolated().getByRole('button', { name: '关闭小程序' }).evaluate(element => element.click())
			}
			else if (close === 'capsule') await isolated().locator('.dimina-mini-app-navigation__actions-close').evaluate(element => element.click())
			else await screen().getByText('Exit API', { exact: true }).click()
			await page.locator('#preview-status-title').getByText('小程序已关闭', { exact: true }).waitFor({ timeout: 5000 })
			assert.equal(await page.locator('#preview-runtime').evaluate(element => element.inert), true)
			await page.locator('.iphone__status-bar--black').waitFor()
			if (artifacts) await page.locator('#iphone').screenshot({ path: `${artifacts}/closed-${close}.png` })
			await page.getByRole('button', { name: '重新打开小程序', exact: true }).click()
			await idle()
			await screen().getByText('Count 1', { exact: true }).waitFor()
			await page.locator('.iphone__status-bar--white').waitFor()
		}
	}
	assert.deepEqual(errors, [])
	console.log('Passed: viewport-bounded menus, visible cancel action, generated app metadata, close/reopen via menu, capsule and API, persisted data and status-bar colors.')
} catch (error) {
	console.error('Studio status:', await page.locator('#status').textContent().catch(() => 'unavailable'))
	console.error('Browser errors:', errors)
	if (artifacts) await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {})
	throw error
} finally {
	await browser.close()
	await new Promise(resolve => server.httpServer.close(resolve))
}
