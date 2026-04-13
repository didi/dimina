import { isFunction } from '@dimina/common'
import { filterData, mergeBehaviors } from '../../core/utils'

export class PageModule {
	static type = 'page'

	constructor(moduleInfo, extraInfo) {
		this.moduleInfo = moduleInfo
		this.extraInfo = extraInfo
		this.type = PageModule.type
		this.behaviors = this.moduleInfo.behaviors
		this.usingComponents = this.extraInfo.usingComponents
		mergeBehaviors(this.moduleInfo, this.behaviors)

		// 微信页面实例的方法挂在根级；behavior.methods 需要提升到页面定义上。
		if (this.moduleInfo.methods) {
			for (const [name, method] of Object.entries(this.moduleInfo.methods)) {
				if (!(name in this.moduleInfo) && isFunction(method)) {
					this.moduleInfo[name] = method
				}
			}
		}

		this.noReferenceData = filterData(this.moduleInfo.data || {})
	}
}
