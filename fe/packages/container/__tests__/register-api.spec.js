import { describe, expect, it, vi } from 'vitest'

/**
 * 测试 registerApi / invokeApi 机制。
 * 由于 MiniApp 依赖 DOM / Worker，这里复刻核心逻辑进行单元测试。
 */
function createMiniAppStub() {
	const app = {
		apiRegistry: {},

		registerApi(name, handler) {
			this.apiRegistry[name] = handler
		},

		// 模拟第三方扩展路由
		_handleExtCall: vi.fn(),

		invokeApi(name, params) {
			const handler = this.apiRegistry[name]
			if (handler) {
				handler.call(this, params)
			}
			else if (typeof this[name] === 'function') {
				this[name](params)
			}
			else {
				// 未命中已知方法，转发给第三方扩展路由处理
				this._handleExtCall(name, params)
			}
		},
	}
	return app
}

describe('MiniApp registerApi', () => {
	it('should invoke a registered custom API handler', () => {
		const app = createMiniAppStub()
		const handler = vi.fn()

		app.registerApi('getQdLocation', handler)
		app.invokeApi('getQdLocation', { foo: 'bar' })

		expect(handler).toHaveBeenCalledWith({ foo: 'bar' })
	})

	it('should fall back to built-in method when no custom handler registered', () => {
		const app = createMiniAppStub()
		app.request = vi.fn()

		app.invokeApi('request', { url: 'https://example.com' })

		expect(app.request).toHaveBeenCalledWith({ url: 'https://example.com' })
	})

	it('should prefer custom handler over built-in method', () => {
		const app = createMiniAppStub()
		const customHandler = vi.fn()
		app.request = vi.fn()

		app.registerApi('request', customHandler)
		app.invokeApi('request', { url: 'test' })

		expect(customHandler).toHaveBeenCalledWith({ url: 'test' })
		expect(app.request).not.toHaveBeenCalled()
	})

	it('should fall back to _handleExtCall for unknown API', () => {
		const app = createMiniAppStub()

		app.invokeApi('nonExistentApi', { key: 'value' })

		expect(app._handleExtCall).toHaveBeenCalledWith('nonExistentApi', { key: 'value' })
	})

	it('should support registering multiple custom APIs', () => {
		const app = createMiniAppStub()
		const handler1 = vi.fn()
		const handler2 = vi.fn()

		app.registerApi('customApi1', handler1)
		app.registerApi('customApi2', handler2)

		app.invokeApi('customApi1', { a: 1 })
		app.invokeApi('customApi2', { b: 2 })

		expect(handler1).toHaveBeenCalledWith({ a: 1 })
		expect(handler2).toHaveBeenCalledWith({ b: 2 })
	})

	it('should allow overwriting a registered handler', () => {
		const app = createMiniAppStub()
		const handler1 = vi.fn()
		const handler2 = vi.fn()

		app.registerApi('myApi', handler1)
		app.registerApi('myApi', handler2)
		app.invokeApi('myApi', {})

		expect(handler1).not.toHaveBeenCalled()
		expect(handler2).toHaveBeenCalled()
	})

	it('should call handler with app as this context', () => {
		const app = createMiniAppStub()
		let thisRef = null

		app.registerApi('checkThis', function () {
			thisRef = this
		})
		app.invokeApi('checkThis', {})

		expect(thisRef).toBe(app)
	})
})
