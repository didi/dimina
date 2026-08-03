import { beforeEach, describe, expect, it } from 'vitest'
import { createContainer } from '../src/index.js'
import { resetFakeWorker } from './fixtures/fake-worker.js'
import { installFetchMock } from './fixtures/mock-fetch.js'

// 回归测试：Application 不再对外暴露 pushView / popView 这两个方法。
// 导航栈操作应统一收敛到 openApp / closeApp 等容器级入口，
// application 上不应残留旧的 pushView / popView 可调用方法。

describe('Application no longer exposes legacy pushView/popView methods', () => {
	let mount: HTMLElement

	beforeEach(() => {
		installFetchMock()
		resetFakeWorker()
		mount = document.createElement('div')
		document.body.appendChild(mount)
	})

	it('does not expose pushView or popView as callable methods', () => {
		const container = createContainer({ mount })

		// `in` 而非直接属性访问：pushView/popView 已从 Application 类型中删除，
		// 直接访问会编译报错（TS2339）；用 `in` 做运行时存在性检查，语义不变。
		expect('pushView' in container.application).toBe(false)
		expect('popView' in container.application).toBe(false)
	})
})
