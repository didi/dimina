import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer } from '../src/index.js'
import { createAppConfigResponse } from './fixtures/app-config.js'
import { FakeWorker, resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 契约（红灯阶段，onAppLaunchError 尚未实现）：
// createContainer({ mount, onAppLaunchError }) 新增可选配置，签名
// (error: unknown, context: { appId: string }) => void。小程序启动失败
// （app-config.json 不可达/为空/非法）时该回调被调用恰好一次；启动成功时
// 一次都不调用；openApp() 无论成功/失败都仍然 resolve（不 reject，不产生
// unhandled rejection）；容器在启动还在途中就把小程序销毁（正常销毁流程，
// 不是加载失败）不应误报。
//
// 目前 CreateContainerOptions 类型上还没有 onAppLaunchError 字段，直接写
// `createContainer({ mount, onAppLaunchError })` 字面量会撞 TS 的"多余属性
// 检查"报错。这里用 createContainerWithOnAppLaunchError() 把 options 先赋给
// 一个带局部 interface 的变量再传：变量（非字面量）传参不受多余属性检查约束，
// 只要它结构上兼容 CreateContainerOptions（mount 字段类型一致）即可通过。
// 等实现把 onAppLaunchError 补进 CreateContainerOptions 后，这个局部 interface
// 与真实类型结构一致，调用点不需要任何回改。

interface CreateContainerOptionsWithLaunchError {
	mount: HTMLElement
	onAppLaunchError: (error: unknown, context: { appId: string }) => void
}

function createContainerWithOnAppLaunchError(
	mount: HTMLElement,
	onAppLaunchError: (error: unknown, context: { appId: string }) => void,
) {
	const options: CreateContainerOptionsWithLaunchError = { mount, onAppLaunchError }
	return createContainer(options)
}

function toUrlString(input: unknown): string {
	if (typeof input === 'string') {
		return input
	}
	if (input instanceof URL) {
		return input.toString()
	}
	return (input as { url?: string })?.url ?? String(input)
}

function jsonResponse(payload: unknown) {
	const text = JSON.stringify(payload)
	return Promise.resolve({
		ok: true,
		status: 200,
		json: () => Promise.resolve(JSON.parse(text)),
		text: () => Promise.resolve(text),
	})
}

function emptyResponse() {
	// 模拟一个"404 空 body"的响应：readFile() 内部是 fetch(url).then(r => r.text())，
	// 这种响应不会走 fetch 的 reject 分支，而是 resolve 一个空字符串——
	// 用来覆盖"配置为空/非法"这条与"网络失败"不同的失败入口。
	return Promise.resolve({
		ok: false,
		status: 404,
		text: () => Promise.resolve(''),
		json: () => Promise.reject(new Error('unexpected json() call on an empty 404-style response')),
	})
}

/**
 * fetch mock：appList.json 返回空列表；目标 appId 的 app-config.json 请求按
 * mode 立即失败（'reject' = fetch 本身 reject，模拟网络失败；'empty' = resolve
 * 一个空 body，模拟 404）；其它一切请求（包括其它 appId 的配置）一律返回有效
 * 配置，避免把无关请求一并搞挂产生噪音。
 */
function installFailingConfigFetchMock(failingAppId: string, mode: 'reject' | 'empty') {
	const fetchMock = vi.fn((input: unknown) => {
		const url = toUrlString(input)

		if (url.includes('appList.json')) {
			return jsonResponse([])
		}

		if (url.includes('app-config.json') && url.includes(failingAppId)) {
			return mode === 'reject' ? Promise.reject(new Error('network down')) : emptyResponse()
		}

		return jsonResponse(createAppConfigResponse())
	})

	globalThis.fetch = fetchMock as unknown as typeof fetch
	return { fetchMock }
}

/**
 * fetch mock：目标 appId 的 app-config.json 请求先挂起，直到测试手动调用
 * release(outcome) 才 settle。其它请求立即返回有效配置。用于构造"启动还在途
 * 中"的窗口，参考 destroy-during-pending-fetch.spec.ts 的
 * installControllableFetchMock ——那条测试已经证明：openApp() 的 resolve
 * （present 完成）不等于 initApp 跑完，config 请求在 openApp() resolve 之后
 * 仍可能是"在途"的。
 */
function installControllableConfigFetchMock(gatedAppId: string) {
	let releaseGate: (outcome: 'reject' | 'empty') => void
	const gate = new Promise<'reject' | 'empty'>((resolve) => {
		releaseGate = resolve
	})

	const fetchMock = vi.fn((input: unknown) => {
		const url = toUrlString(input)

		if (url.includes('appList.json')) {
			return jsonResponse([])
		}

		if (url.includes('app-config.json') && url.includes(gatedAppId)) {
			return gate.then(outcome => (outcome === 'reject' ? Promise.reject(new Error('network down (released)')) : emptyResponse()))
		}

		return jsonResponse(createAppConfigResponse())
	})

	globalThis.fetch = fetchMock as unknown as typeof fetch
	return { release: (outcome: 'reject' | 'empty') => releaseGate(outcome) }
}

async function waitForNextWorker(startIndex: number, timeout = 8000) {
	await vi.waitFor(() => {
		expect(FakeWorker.instances.length).toBeGreaterThan(startIndex)
	}, { timeout })
	return FakeWorker.instances[startIndex]
}

describe('onAppLaunchError', () => {
	let mount: HTMLElement

	beforeEach(() => {
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('is called exactly once with an Error and { appId } when app-config.json is unreachable (fetch rejects)', async () => {
		const APP_ID = 'wx-launch-error-reject'
		installFailingConfigFetchMock(APP_ID, 'reject')
		const onAppLaunchError = vi.fn()
		const container = createContainerWithOnAppLaunchError(mount, onAppLaunchError)

		await container.openApp({ appId: APP_ID, path: 'pages/index/index' })

		// openApp() 可能在失败判定之前就已经 resolve（见下面"仍然 resolve"那条），
		// 所以失败回调要单独 waitFor，不能只靠 await openApp() 之后立即断言。
		await vi.waitFor(() => {
			expect(onAppLaunchError).toHaveBeenCalled()
		}, { timeout: 8000 })

		expect(onAppLaunchError.mock.calls).toHaveLength(1)
		expect(onAppLaunchError.mock.calls[0][0]).toBeInstanceOf(Error)
		expect(onAppLaunchError.mock.calls[0][1]).toEqual({ appId: APP_ID })
	}, 10000)

	it('is called when app-config.json resolves with an empty (404-style) body', async () => {
		const APP_ID = 'wx-launch-error-empty'
		installFailingConfigFetchMock(APP_ID, 'empty')
		const onAppLaunchError = vi.fn()
		const container = createContainerWithOnAppLaunchError(mount, onAppLaunchError)

		await container.openApp({ appId: APP_ID, path: 'pages/index/index' })

		await vi.waitFor(() => {
			expect(onAppLaunchError).toHaveBeenCalled()
		}, { timeout: 8000 })

		expect(onAppLaunchError.mock.calls).toHaveLength(1)
		expect(onAppLaunchError.mock.calls[0][0]).toBeInstanceOf(Error)
		expect(onAppLaunchError.mock.calls[0][1]).toEqual({ appId: APP_ID })
	}, 10000)

	it('is never called when the app launches successfully', async () => {
		const APP_ID = 'wx-launch-success'
		installFetchMock()
		const onAppLaunchError = vi.fn()
		const container = createContainerWithOnAppLaunchError(mount, onAppLaunchError)

		await container.openApp({ appId: APP_ID, path: 'pages/index/index' })
		const worker = await waitForNextWorker(0)

		// 等启动链路真正跑完（逻辑线程收到过 postMessage），而不是只等 openApp()
		// resolve——后者可能在整条启动链路跑完之前就已经 resolve 了，过早断言
		// "零调用"会掩盖"其实还没跑到失败判定"这种假阴性。
		await vi.waitFor(() => {
			expect(worker.postMessage).toHaveBeenCalled()
		}, { timeout: 8000 })
		// 再多等一小段时间，给后台的失败探测逻辑一个足够的窗口去（错误地）触发。
		await new Promise(resolve => setTimeout(resolve, 300))

		expect(onAppLaunchError).not.toHaveBeenCalled()
	}, 10000)

	it('still resolves openApp() on launch failure, without producing an unhandled rejection (backward compatible)', async () => {
		const APP_ID = 'wx-launch-error-resolves'
		installFailingConfigFetchMock(APP_ID, 'reject')
		const onAppLaunchError = vi.fn()
		const container = createContainerWithOnAppLaunchError(mount, onAppLaunchError)

		const unhandledRejections: unknown[] = []
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason)
		}
		process.on('unhandledRejection', onUnhandledRejection)

		try {
			// 失败经回调通知，不改变 openApp() 的调用时序语义：现有不传回调的调用方
			// 行为不应该变化——既不 reject，也不能因为失败路径冒出 unhandled rejection。
			await expect(container.openApp({ appId: APP_ID, path: 'pages/index/index' })).resolves.toBeDefined()

			await vi.waitFor(() => {
				expect(onAppLaunchError).toHaveBeenCalled()
			}, { timeout: 8000 })

			expect(unhandledRejections).toEqual([])
		}
		finally {
			process.off('unhandledRejection', onUnhandledRejection)
		}
	}, 10000)

	it('does not report a launch error when the app is destroyed while its config fetch is still in flight (abort, not failure)', async () => {
		// 对应"容器在小程序启动还在途中就把它销毁"的场景（正常销毁流程，不是加载
		// 失败）。destroy-during-pending-fetch.spec.ts 已经证明：openApp() 的
		// resolve（present 完成）不等于 initApp 跑完，config 请求在 openApp()
		// resolve 之后仍可能是"在途"的。这里让目标 app 的配置请求挂起到
		// openApp() resolve 之后，立即 destroy，然后才放行配置请求、让它以一个
		// 会导致"失败"的结果 settle：如果 destroy 没有正确打断在途的启动续体，
		// 被打断的续体仍会跑到失败判定分支，误报一次 onAppLaunchError。
		// 注：这里卡住/等待的是"config 请求 settle"这一步；能抓的回归是
		// "销毁后仍处理迟到的失败结果"，抓不了"销毁发生在 config 请求已经
		// settle、卡在其他握手步骤"这类更晚窗口的误报（如果构造不稳定，
		// 后续可以针对那类窗口再补一条，而不是让这条本身变得随机绿/红）。
		const APP_ID = 'wx-launch-error-abort'
		const { release } = installControllableConfigFetchMock(APP_ID)
		const onAppLaunchError = vi.fn()
		const container = createContainerWithOnAppLaunchError(mount, onAppLaunchError)

		const miniApp = await container.openApp({ appId: APP_ID, path: 'pages/index/index' })
		await container.application.destroyRootView(miniApp)

		// 销毁之后才放行配置请求（以会导致"失败"的结果 settle）。
		release('reject')

		// 没有"成功信号"可等（本来就该什么都不发生），只能等一段足够长的时间，
		// 让被打断的续体（如果没被正确挡住）有机会跑到失败判定分支。
		await new Promise(resolve => setTimeout(resolve, 1000))

		expect(onAppLaunchError).not.toHaveBeenCalled()
	}, 10000)
})
