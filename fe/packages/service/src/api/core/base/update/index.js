import { invokeAPI } from '@/api/common'
import message from '@/core/message'

const UPDATE_STATUS_EVENT = 'onUpdateStatusChange'
const EVENT_UPDATE_FAILED = 'updatefail'
const EVENT_UPDATE_READY = 'updateready'
const EVENT_NO_UPDATE = 'noupdate'
const EVENT_UPDATING = 'updating'

/**
 * 获取全局唯一的版本更新管理器，用于管理小程序更新。关于小程序的更新机制，可以查看运行机制文档。
 * https://developers.weixin.qq.com/miniprogram/dev/api/base/update/wx.getUpdateManager.html
 */
export function getUpdateManager() {
	return UpdateManager.getInstance()
}

class UpdateManager {
	// 私有静态变量，用于存储单例实例
	static #instance = null

	// 私有构造函数，防止外部直接实例化
	constructor() {
		if (UpdateManager.#instance) {
			throw new Error(
				'Cannot instantiate more than one UpdateManager instance.',
			)
		}
		this.hasAppliedUpdate = false
		this.updateFailed = false
		this.updateReady = false
		this.checkForUpdateResult = null

		this.updateFailedListeners = []
		this.updateReadyListeners = []
		this.checkForUpdateListeners = []

		message.on(UPDATE_STATUS_EVENT, (msg) => this.handleUpdateStatusChange(msg))

		UpdateManager.#instance = this
	}

	handleUpdateStatusChange(msg = {}) {
		const { event } = msg

		if (event === EVENT_UPDATE_FAILED) {
			this.updateFailed = true
			this.emit(this.updateFailedListeners)
			return
		}

		if (event === EVENT_UPDATE_READY) {
			this.updateReady = true
			this.checkForUpdateResult = { hasUpdate: true }
			this.emit(this.checkForUpdateListeners, this.checkForUpdateResult)
			this.emit(this.updateReadyListeners)
			return
		}

		if (event === EVENT_UPDATING) {
			this.checkForUpdateResult = { hasUpdate: true }
			this.emit(this.checkForUpdateListeners, this.checkForUpdateResult)
			return
		}

		if (event === EVENT_NO_UPDATE) {
			this.checkForUpdateResult = { hasUpdate: false }
			this.emit(this.checkForUpdateListeners, this.checkForUpdateResult)
			return
		}

		if (typeof msg.hasUpdate === 'boolean') {
			this.checkForUpdateResult = { hasUpdate: msg.hasUpdate }
			this.emit(this.checkForUpdateListeners, this.checkForUpdateResult)
		}
	}

	emit(listeners, ...args) {
		listeners.slice().forEach((cb) => {
			cb(...args)
		})
	}

	// 静态方法，用于获取单例实例
	static getInstance() {
		if (!UpdateManager.#instance) {
			UpdateManager.#instance = new UpdateManager()
		}
		return UpdateManager.#instance
	}

	/**
	 * 强制小程序重启并使用新版本。在小程序新版本下载完成后（即收到 onUpdateReady 回调）调用。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.applyUpdate.html
	 */
	applyUpdate() {
		if (!this.updateReady) {
			console.error('[applyUpdate]: update is not ready')
		}
		else if (this.hasAppliedUpdate) {
			console.error('[applyUpdate]: applyUpdate has been called')
		}
		else {
			this.hasAppliedUpdate = true
			return invokeAPI('applyUpdate')
		}
	}

	/**
	 * 监听向微信后台请求检查更新结果事件。微信在小程序每次启动（包括热启动）时自动检查更新，不需由开发者主动触发。
	 * https://developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.onCheckForUpdate.html
	 */
	onCheckForUpdate(cb) {
		if (typeof cb !== 'function') {
			return
		}
		this.checkForUpdateListeners.push(cb)
		if (this.checkForUpdateResult) {
			cb(this.checkForUpdateResult)
		}
	}

	/**
	 * 监听小程序更新失败事件。小程序有新版本，客户端主动触发下载（无需开发者触发），下载失败（可能是网络原因等）后回调
	 * https://developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.onUpdateFailed.html
	 */
	onUpdateFailed(cb) {
		if (typeof cb !== 'function') {
			return
		}
		this.updateFailedListeners.push(cb)
		if (this.updateFailed) {
			cb()
		}
	}

	/**
	 * 监听小程序有版本更新事件。客户端主动触发下载（无需开发者触发），下载成功后回调
	 *	https://developers.weixin.qq.com/miniprogram/dev/api/base/update/UpdateManager.onUpdateReady.html
	 */
	onUpdateReady(cb) {
		if (typeof cb !== 'function') {
			return
		}
		this.updateReadyListeners.push(cb)
		if (this.updateReady) {
			cb()
		}
	}
}

UpdateManager.getInstance()
