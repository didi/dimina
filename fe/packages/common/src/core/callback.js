import { isFunction, uuid } from './utils'

class Callback {
	constructor() {
		this.callbacks = {}
	}

	store(callback, keep, evtId = uuid()) {
		if (keep) {
			// 检查是否已经为该函数生成过 UUID
			for (const [k, v] of Object.entries(this.callbacks)) {
				if (v.callback === callback) {
					return k
				}
			}
		}

		this.callbacks[evtId] = { callback, keep }
		return evtId
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
		const obj = this.callbacks[evtId]
		if (obj && isFunction(obj.callback)) {
			obj.callback(args)
			if (!obj.keep) {
				delete this.callbacks[evtId]
			}
		}
	}

	remove(evtId) {
		if (evtId) {
			Object.keys(this.callbacks).forEach((k) => {
				if (evtId === k) {
					delete this.callbacks[k]
				}
			})
		}
		else {
			Object.entries(this.callbacks).forEach(([k, v]) => {
				if (v.keep) {
					delete this.callbacks[k]
				}
			})
		}
	}
}

export default new Callback()
