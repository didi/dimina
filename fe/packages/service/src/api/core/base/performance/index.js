import { callback } from '@dimina/common'
import { invokeAPI } from '@/api/common'

/**
 * 获取当前小程序性能相关的信息。关于小程序启动性能优化的更多内容，请参考启动性能指南。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/performance/wx.getPerformance.html
 */

export function getPerformance() {
	return Performance.getInstance()
}

class Performance {
	static #instance = null
	// 私有构造函数，防止外部直接实例化
	constructor() {
		if (Performance.#instance) {
			throw new Error(
				'Cannot instantiate more than one Performance instance.',
			)
		}

		this.entryList = new EntryList()

		// 这里可以添加初始化代码
		Performance.#instance = this
	}

	// 静态方法，用于获取单例实例
	static getInstance() {
		if (!Performance.#instance) {
			Performance.#instance = new Performance()
		}
		return Performance.#instance
	}

	createObserver(listener) {
		return new Observer(this, listener)
	}

	getEntries() {
		return this.entryList.getEntries()
	}

	getEntriesByName(name, entryType) {
		return this.entryList.getEntriesByName(name, entryType)
	}

	getEntriesByType(entryType) {
		return this.entryList.getEntriesByType(entryType)
	}

	setBufferSize(size) {
		this.entryList.maxEntrySize = size
	}
}

class EntryList {
	constructor() {
		this._list = []
		this.maxEntrySize = 30
	}

	push(entries) {
		for (const entry of entries) {
			// 如果数组长度已经达到限制，移除第一个元素
			if (this._list.length >= this.maxEntrySize) {
				this._list.shift()
			}
			// 添加条目到数组的末尾
			this._list.push(entry)
		}
	}

	getEntriesByName(name, entryType) {
		return this._entryFilter(name, entryType)
	}

	getEntriesByType(entryType) {
		return this._entryFilter(null, entryType)
	}

	_entryFilter(name, entryType) {
		return this._list.filter((entry) => {
			if (name && name !== entry.name) {
				return false
			}

			if (entryType && entryType !== entry.entryType) {
				return false
			}
			return true
		})
	}

	getEntries() {
		return this._list
	}
}

class Observer {
	constructor(performance, listener) {
		this.performance = performance
		this.entryTypes = []
		this.callback = listener
		this.observerId = null
		this.callbackId = null
		this.connected = false
	}

	observe(options = {}) {
		this.disconnect()
		this.connected = true
		this.entryTypes = Array.isArray(options.entryTypes) ? options.entryTypes : []
		this.callbackId = callback.store((res = {}) => {
			if (res.observerId) {
				this.observerId = res.observerId
				if (!this.connected) {
					invokeAPI('removePerformanceObserver', { observerId: res.observerId }, 'render')
					callback.remove(this.callbackId)
					this.callbackId = null
					return
				}
			}
			const list = res?.data?.entryList ? JSON.parse(res.data.entryList) : []
			if (this.connected && list.length > 0) {
				this.performance.entryList.push(list)
				this.notify(list)
			}
		}, true)
		invokeAPI('addPerformanceObserver', {
			entryTypes: this.entryTypes,
			success: this.callbackId,
		}, 'render')
	}

	notify(data) {
		if (this.connected) {
			const entryList = new EntryList()
			entryList.push(data.filter((entry) => {
				let flag = false
				if (this.entryTypes && this.entryTypes.length > 0) {
					this.entryTypes.forEach((value) => {
						if (entry.entryType === value) {
							flag = true
						}
					})
				}
				return flag
			}))
			if (typeof this.callback === 'function') {
				this.callback(entryList)
			}
		}
	}

	disconnect() {
		this.connected = false
		if (this.observerId) {
			invokeAPI('removePerformanceObserver', {
				observerId: this.observerId,
			}, 'render')
		}
		if (this.callbackId && this.observerId) {
			callback.remove(this.callbackId)
		}
		this.observerId = null
		this.callbackId = null
	}
}
