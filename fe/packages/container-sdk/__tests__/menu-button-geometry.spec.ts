import { describe, expect, it } from 'vitest'
import { MiniApp } from '../src/pages/miniApp/miniApp.js'

describe('MiniApp menu button geometry', () => {
	it('returns menu coordinates relative to the mini-program viewport', () => {
		const app = Object.create(MiniApp.prototype) as MiniApp
		const menuRect = {
			top: 82,
			right: 829,
			bottom: 119,
			left: 734,
			width: 95,
			height: 37,
			x: 734,
			y: 82,
		}
		app.el = {
			getBoundingClientRect: () => ({ left: 428 }),
			querySelector: () => ({ getBoundingClientRect: () => menuRect }),
		} as unknown as HTMLElement
		// container-sdk 的 shell 适配器设计：状态栏几何改由 this.parent.shell.getStatusBarRect()
		// 提供（不再直接查询宿主 DOM 里的 .iphone__status-bar），this.parent 是 Application。
		app.parent = {
			shell: {
				getStatusBarRect: () => ({ height: 48 }),
			},
		} as unknown as MiniApp['parent']

		expect(app.getMenuButtonBoundingClientRect()).toEqual({
			top: 52,
			right: 401,
			bottom: 89,
			left: 306,
			width: 95,
			height: 37,
			x: 306,
			y: 52,
		})
	})
})
