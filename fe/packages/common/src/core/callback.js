import { isFunction, uuid } from './utils'

class Callback {
	constructor() {
		this.callbacks = new Map()
		// keep 的回调按函数身份去重。之前每次登记都要遍历整张表比对，条目多了每登记
		// 一次就全表扫一遍，这里用一张反查表把它换成常数时间。
		this.keepIds = new Map()
	}

	store(callback, keep, evtId) {
		// null 跟没给一样，自己生成一个。放它进来会成为 Map 的键，而 remove 把 null
		// 当作「没给 id」拒绝执行，一次性回调就再也摘不掉、可以被反复触发。
		const id = evtId === undefined || evtId === null ? uuid() : evtId

		if (keep) {
			const existedId = this.keepIds.get(callback)
			if (existedId !== undefined) {
				return existedId
			}
		}

		// 传了显式 evtId 时可能覆盖掉已有条目（扩展订阅就会反复用同一个事件名当 id）。
		// 被覆盖的那个函数在反查表里的记录也要一起清掉，否则它会指回一个已经换了
		// 回调的 id，之后拿它重新登记就会拿到别人的回调。
		const replaced = this.callbacks.get(id)
		if (replaced && this.keepIds.get(replaced.callback) === id) {
			this.keepIds.delete(replaced.callback)
		}

		this.callbacks.set(id, { callback, keep })
		if (keep) {
			this.keepIds.set(callback, id)
		}
		return id
	}

	/**
	 * [Container] triggerCallback -> [Service] invoke
	 * @param {*} evtId
	 * @param {*} args
	 */
	invoke(evtId, args) {
		if (evtId === undefined) {
			return
		}
		const obj = this.callbacks.get(evtId)
		if (!obj || !isFunction(obj.callback)) {
			return
		}
		// 一次性回调先摘再调：调用方在自己的回调里拿同一个 id 再触发一次不会重入，
		// 回调抛异常时记录也不会漏在表里（清理写在调用之后的话会被异常跳过）。
		if (!obj.keep) {
			this.remove(evtId)
		}
		obj.callback(args)
	}

	/**
	 * 摘掉指定 id 的回调。不传 id 时什么都不做——这张表是所有接口共用的，
	 * 谁登记的谁负责摘，这里没有信息能区分某一次清理该波及哪些条目。
	 * 整表清空用 clear()。
	 * @param {*} evtId
	 */
	remove(evtId) {
		// 只有「没给 id」才什么都不做。不能用真值判断——0、false、空字符串都是 store
		// 收得下的显式 id（换成 Map 之后键不再被字符串化），拿真值判断挡掉的话它们
		// 就永远摘不掉，一次性回调还会因为摘不掉而被反复触发。
		if (evtId === undefined || evtId === null) {
			return
		}
		const obj = this.callbacks.get(evtId)
		if (!obj) {
			return
		}
		this.callbacks.delete(evtId)
		// 同一个函数可能已经在别的 id 下重新登记过，反查表里那条就不该跟着删。
		if (this.keepIds.get(obj.callback) === evtId) {
			this.keepIds.delete(obj.callback)
		}
	}

	/**
	 * 清空整张表。销毁运行环境时用，正常业务路径不该调用。
	 */
	clear() {
		this.callbacks.clear()
		this.keepIds.clear()
	}
}

export default new Callback()
