import assert from 'node:assert/strict'
import { createServer as createHTTPServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build, createServer } from 'vite'
import componentsConfig from '../../components/vite.config.mjs'
import { getPages, storeInfo } from '../../compiler/src/env.js'
import { compileML } from '../../compiler/src/core/view-compiler.js'

// Compile real WXML, mount the built-in components, and load the standalone H5
// SDK from another origin. UA cases exercise platform selection, not devices.
const feRoot = fileURLToPath(new URL('../../../', import.meta.url))
const project = await mkdtemp(resolve(tmpdir(), 'dimina-web-view-'))
const previousTarget = process.env.TARGET_PATH
let browser, server, guestServer
try {
	await writeFile(resolve(project, 'app.json'), '{"pages":["index"]}')
	await writeFile(resolve(project, 'project.config.json'), '{"appid":"embedded-browser"}')
	await writeFile(resolve(project, 'index.wxml'), `
		<view id="header" style="height:80rpx">小程序头部</view>
		<scroll-view id="scroll" scroll-y="{{true}}" style="height:600rpx">
			<view style="height:200rpx"/>
			<web-view wx:if="{{visible}}" id="card" embedded="{{embedded}}" src="{{src}}"
				style="width:100%;height:{{height}}rpx;border-radius:40rpx" bindmessage="receive" bindload="loaded" binderror="failed"/>
			<view style="height:600rpx"/>
		</scroll-view>
		<view id="footer" style="height:80rpx">小程序底部</view>
		<web-view id="other" embedded="{{true}}" src="{{otherSrc}}" style="height:100rpx" bindmessage="otherMessage"/>
		<view wx:if="{{overlay}}" id="cover" style="position:fixed;left:100rpx;top:360rpx;width:160rpx;height:100rpx;z-index:10;background:#8abca1">普通视图遮挡</view>
	`)
	process.env.TARGET_PATH = resolve(project, 'out')
	storeInfo(project)
	await compileML(getPages().mainPages, null, { completedTasks: 0 })
	const compiled = await readFile(resolve(project, 'out/main/index.js'), 'utf8')
	await build({ root: resolve(feRoot, 'packages/jdimina'), configFile: resolve(feRoot, 'packages/jdimina/vite.config.mjs'), logLevel: 'warn' })
	const sdk = await readFile(resolve(feRoot, 'packages/jdimina/dist/jdimina_next.js'), 'utf8')
	guestServer = createHTTPServer((req, res) => {
		if (req.url === '/sdk.js') {
			res.setHeader('Content-Type', 'application/javascript')
			res.end(sdk)
			return
		}
		res.setHeader('Content-Type', 'text/html; charset=utf-8')
		res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
			<style>body{margin:0;background:#ead8b2;height:900px}button,input{display:block;margin:4px}</style>
			<button id="send">发送消息</button><input id="field" aria-label="内容">
			<script src="/sdk.js"></script><script>
			const tag = new URL(location.href).searchParams.get('tag');
			wx.miniProgram.getEnv(value => { window.env = value; wx.miniProgram.postMessage({data:{tag,ready:value.miniprogram}}) });
			document.getElementById('send').onclick = () => wx.miniProgram.postMessage({data:{tag,clicked:true}});
			</script>`)
	})
	await new Promise(resolve => guestServer.listen(0, '127.0.0.1', resolve))
	const guestURL = `http://127.0.0.1:${guestServer.address().port}/?tag=`
	const config = componentsConfig({ mode: 'development' })
	server = await createServer({
		...config, configFile: false, root: feRoot, logLevel: 'warn',
		plugins: [...config.plugins, { name: 'embedded-test-page', configureServer(dev) { dev.middlewares.use('/embedded-test', serveFixture) } }],
		optimizeDeps: { noDiscovery: true, include: [] },
		resolve: { ...config.resolve, alias: { ...config.resolve.alias, vue: resolve(feRoot, 'packages/components/node_modules/vue/dist/vue.runtime.esm-bundler.js') } },
		server: { host: '127.0.0.1', port: 0 },
	})
	function serveFixture(_req, res) {
		res.setHeader('Content-Type', 'text/html; charset=utf-8')
		res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><div id="app"></div>
		<script type="module">
		import * as Vue from '/packages/components/node_modules/vue/dist/vue.runtime.esm-bundler.js';
		import {Components} from '/packages/components/index.js';
		Object.assign(window,Object.fromEntries(Object.entries(Vue).map(([key,value])=>['_'+key,value])),{Vue});
		const factories=new Map(),cache=new Map();
		window.modDefine=(id,factory)=>factories.set(id,factory);
		window.modRequire=id=>{if(!cache.has(id)){const module={exports:{}};cache.set(id,module);factories.get(id)(modRequire,module,module.exports)}return cache.get(id).exports};
		window.Module=info=>window.pageInfo=info;
		(new Function(${JSON.stringify(compiled)}))();
		for(const id of factories.keys())modRequire(id);
		window.events=[];window.nativeCalls=[];
		window.DiminaRenderBridge={mapRenderer:'web'};
		window.__message={send:value=>events.push(value),invoke:value=>nativeCalls.push(value),on(){},off(){}};
		window.state=Vue.reactive({visible:true,embedded:true,src:${JSON.stringify(guestURL + 'card')},otherSrc:${JSON.stringify(guestURL + 'other')},height:400,overlay:true});
		const app=Vue.createApp({setup(){Vue.provide('bridgeId','browser-page');Vue.provide('path','index');Vue.provide('index',{id:'page-module'});return state},render:pageInfo.render});
		Components(app);app.mount('#app');window.testApp=app;
		</script>`)
	}
	await server.listen()
	browser = await chromium.launch({ executablePath: process.env.DIMINA_CHROME_PATH, headless: true })
	for (const [platform, userAgent] of [
		['Web', undefined], ['Android', 'Mozilla/5.0 (Linux; Android 17) AppleWebKit/537.36 Mobile Safari/537.36'],
		['iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'],
		['Harmony', 'Mozilla/5.0 (OpenHarmony 6.0) AppleWebKit/537.36 Mobile Safari/537.36'],
	]) {
		const context = await browser.newContext({ viewport: { width: 375, height: 812 }, userAgent })
		const page = await context.newPage()
		const errors = []
		page.on('pageerror', error => errors.push(error.message))
		await page.goto(`${server.resolvedUrls.local[0]}embedded-test`)
		await page.waitForFunction(() => events.some(msg => msg.body?.methodName === 'receive' && msg.body.event.detail.data[0]?.ready))
		const frame = page.locator('#card')
		const bounds = await frame.boundingBox()
		assert.equal(bounds.height, 200)
		assert.equal(bounds.width, 375)
		assert.equal(bounds.y, 140)
		assert.equal(await page.locator('#footer').evaluate(el => el.getBoundingClientRect().y), 340)
		assert.equal(await frame.evaluate(el => getComputedStyle(el).borderTopLeftRadius), '20px')
		assert.equal(await page.evaluate(() => document.elementFromPoint(60, 190).id), 'cover')
		assert.notEqual(await page.evaluate(() => document.elementFromPoint(1, 141).id), 'card')
		assert.equal(await page.evaluate(() => nativeCalls.length), 0)
		await frame.contentFrame().locator('#send').click()
		await page.waitForFunction(() => events.some(msg => msg.body?.methodName === 'receive' && msg.body.event.detail.data[0]?.clicked))
		assert.equal(await page.evaluate(() => events.filter(msg => msg.body?.methodName === 'otherMessage').every(msg => msg.body.event.detail.data[0].tag === 'other')), true)
		if (process.env.DIMINA_TEST_ARTIFACTS) await page.screenshot({ path: `${process.env.DIMINA_TEST_ARTIFACTS}/embedded-${platform}.png` })
		await page.evaluate(() => { state.overlay = false })
		await frame.contentFrame().locator('#field').fill('局部表单')
		assert.equal(await frame.contentFrame().locator('#field').inputValue(), '局部表单')
		await page.locator('#scroll').evaluate(el => { el.scrollTop = 60 })
		await page.waitForFunction(() => document.getElementById('card').getBoundingClientRect().y === 80)
		await page.evaluate(() => { state.height = 300 })
		await page.waitForFunction(() => document.getElementById('card').getBoundingClientRect().height === 150)
		assert.equal(await frame.contentFrame().locator('#field').inputValue(), '局部表单', 'Changing layout must preserve the H5 document')
		await page.evaluate(url => { window.oldFrame = document.getElementById('card'); state.src = url }, guestURL + 'next')
		await page.waitForFunction(() => events.some(msg => msg.body?.methodName === 'receive' && msg.body.event.detail.data[0]?.tag === 'next'))
		assert.equal(await page.evaluate(() => oldFrame === document.getElementById('card')), false)
		await page.evaluate(() => { state.visible = false })
		await frame.waitFor({ state: 'detached' })
		await page.evaluate(() => { state.visible = true })
		await frame.waitFor()
		await page.waitForFunction(() => events.filter(msg => msg.body?.methodName === 'receive' && msg.body.event.detail.data[0]?.tag === 'next').length === 2)
		assert.deepEqual(errors, [], `${platform} page errors`)
		console.log(`${platform}: compiled WXML, layout, clipping, overlay, form, scroll, SDK, src replacement and remount passed`)
		await context.close()
	}
}
finally {
	await browser?.close()
	await server?.close()
	if (guestServer) await new Promise(resolve => guestServer.close(resolve))
	if (previousTarget === undefined) delete process.env.TARGET_PATH
	else process.env.TARGET_PATH = previousTarget
	await rm(project, { recursive: true, force: true })
}
