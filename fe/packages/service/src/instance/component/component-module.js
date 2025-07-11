import { filterData, mergeBehaviors, serializeProps } from '../../core/utils'

export class ComponentModule {
	static type = 'component'

	/**
	 *
	 * @param {{data: object, lifetimes: object, pageLifetimes: object, methods: object, options: object, properties: object}} moduleInfo
	 */
	constructor(moduleInfo, extraInfo) {
		this.moduleInfo = moduleInfo
		this.extraInfo = extraInfo
		this.type = ComponentModule.type
		this.isComponent = this.extraInfo.component
		this.behaviors = this.moduleInfo.behaviors
		this.usingComponents = this.extraInfo.usingComponents
		mergeBehaviors(this.moduleInfo, this.behaviors)
		this.noReferenceData = filterData(this.moduleInfo.data || {})
	}

	getProps() {
		let props = serializeProps(this.moduleInfo.properties)

		if (Array.isArray(this.moduleInfo.externalClasses) && this.moduleInfo.externalClasses.length > 0) {
			if (!props) {
				props = {}
			}
			for (const externalClass of this.moduleInfo.externalClasses) {
				props[externalClass] = {
					type: ['s'],
					cls: true,
				}
			}
		}
		return props
	}
}
