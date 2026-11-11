import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import componentsConfig from '../../components/vite.config.mjs'
import { getPages, storeInfo } from '../../compiler/src/env.js'
import { compileML } from '../../compiler/src/core/view-compiler.js'

// Native touch input lets the browser perform compatibility-click hit testing
// after the popup mounts. Synthetic DOM events alone cannot reproduce that step.
const feRoot = fileURLToPath(new URL('../../../', import.meta.url))
const project = await mkdtemp(resolve(tmpdir(), 'dimina-picker-browser-'))
const previousTarget = process.env.TARGET_PATH
let browser, server
try {
	await writeFile(resolve(project, 'app.json'), '{"pages":["index"]}')
	await writeFile(resolve(project, 'project.config.json'), '{"appid":"picker-browser"}')
	await writeFile(resolve(project, 'index.wxml'), `
		<picker id="single" range="{{options}}" value="{{selected}}" disabled="{{disabled}}"
			bindtap="opened" bindchange="changed" bindcancel="cancelled">
			<view id="single-trigger" style="padding:20px;background:#e5edf5;margin:12px">选择</view>
		</picker>
		<picker id="multi" mode="multiSelector" range="{{columns}}" value="{{indices}}" bindchange="changed" bindcancel="cancelled">
			<view id="multi-trigger" style="padding:20px;margin:12px">多列</view>
		</picker>
		<picker id="time" mode="time" value="09:30" bindchange="changed" bindcancel="cancelled">
			<view id="time-trigger" style="padding:20px;margin:12px">时间</view>
		</picker>
		<picker id="date" mode="date" value="2000-01-01" start="1999-01-01" end="2001-12-31" bindchange="changed" bindcancel="cancelled">
			<view id="date-trigger" style="padding:20px;margin:12px">日期</view>
		</picker>
	`)
	process.env.TARGET_PATH = resolve(project, 'out')
	storeInfo(project)
	await compileML(getPages().mainPages, null, { completedTasks: 0 })
	const compiled = await readFile(resolve(project, 'out/main/index.js'), 'utf8')
	const config = componentsConfig({ mode: 'development' })
	server = await createServer({
		...config, configFile: false, root: feRoot, logLevel: 'warn',
		plugins: [...config.plugins, { name: 'picker-test-page', configureServer(dev) {
			dev.middlewares.use('/picker-test', (_req, res) => {
				res.setHeader('Content-Type', 'text/html; charset=utf-8')
				res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
				<style>body{margin:0}.dd-picker-overlay,.dd-picker-container{animation:none!important}</style><div id="app"></div>
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
				window.events=[];window.inputs=[];
				window.__message={send:value=>events.push(value),invoke(){},on(){},off(){}};
				for(const type of ['touchstart','touchend','click'])document.addEventListener(type,e=>inputs.push({type,target:e.target.className,detail:e.detail}),true);
				window.state=Vue.reactive({options:['A','B','C'],selected:1,disabled:false,columns:[['A','B'],['C','D']],indices:[1,0]});
				const app=Vue.createApp({setup(){Vue.provide('bridgeId','picker-browser');Vue.provide('path','index');Vue.provide('index',{id:'page-module'});return state},render:pageInfo.render});
				Components(app);app.mount('#app');window.testApp=app;
				</script>`)
			})
		} }],
		optimizeDeps: { noDiscovery: true, include: [] },
		resolve: { ...config.resolve, alias: { ...config.resolve.alias, vue: resolve(feRoot, 'packages/components/node_modules/vue/dist/vue.runtime.esm-bundler.js') } },
		server: { host: '127.0.0.1', port: 0 },
	})
	await server.listen()
	browser = await chromium.launch({ executablePath: process.env.DIMINA_CHROME_PATH, headless: true })
	for (const touch of [true, false]) {
		const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: touch, isMobile: touch })
		const page = await context.newPage()
		const errors = []
		page.on('pageerror', error => errors.push(error.message))
		await page.goto(`${server.resolvedUrls.local[0]}picker-test`)
		await page.locator('#single-trigger').waitFor()
		const activate = async selector => {
			const box = await page.locator(selector).boundingBox()
			assert.ok(box, selector)
			const x = box.x + box.width / 2, y = box.y + box.height / 2
			if (touch) await page.touchscreen.tap(x, y)
			else await page.mouse.click(x, y)
		}
		const eventsFor = method => page.evaluate(method => events.filter(message => message.body?.methodName === method).map(message => message.body.event), method)
		const assertOpen = async () => {
			await page.locator('.dd-picker-overlay').waitFor({ state: 'visible' })
			assert.equal(await page.locator('.dd-picker-overlay').count(), 1)
		}
		const assertClosed = () => page.locator('.dd-picker-overlay').waitFor({ state: 'detached' })

		await activate('#single-trigger')
		await assertOpen()
		assert.equal((await eventsFor('cancelled')).length, 0)
		assert.equal((await eventsFor('changed')).length, 0)
		assert.equal((await eventsFor('opened')).length, 1)
		if (touch) {
			assert.ok(await page.evaluate(() => inputs.some(event => event.type === 'click' && event.target === 'dd-picker-overlay')),
				'the browser must deliver the opening compatibility click to the new mask')
		}
		await activate('.dd-picker-confirm')
		await assertClosed()
		assert.equal((await eventsFor('changed')).length, 1)
		assert.equal((await eventsFor('changed'))[0].detail.value, 1)

		await activate('#single-trigger')
		await assertOpen()
		await activate('.dd-picker-cancel')
		await assertClosed()
		assert.equal((await eventsFor('cancelled')).length, 1)
		await activate('#single-trigger')
		await assertOpen()
		if (touch) await page.touchscreen.tap(10, 10)
		else await page.mouse.click(10, 10)
		await assertClosed()
		assert.equal((await eventsFor('cancelled')).length, 2)

		for (const [id, value] of [['multi', [1, 0]], ['time', '09:30'], ['date', '2000-01-01']]) {
			await activate(`#${id}-trigger`)
			await assertOpen()
			await activate('.dd-picker-confirm')
			await assertClosed()
			assert.deepEqual((await eventsFor('changed')).at(-1).detail.value, value)
		}
		await page.evaluate(async () => { state.disabled = true; await Vue.nextTick() })
		await activate('#single-trigger')
		assert.equal(await page.locator('.dd-picker-overlay').count(), 0)
		assert.deepEqual(errors, [])
		console.log(`Picker ${touch ? 'touch' : 'mouse'}: opening click, confirm, cancel, mask, modes and disabled passed`)
		await context.close()
	}
} finally {
	await browser?.close()
	await server?.close()
	if (previousTarget === undefined) delete process.env.TARGET_PATH
	else process.env.TARGET_PATH = previousTarget
	await rm(project, { recursive: true, force: true })
}
