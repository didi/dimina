import { normalizePropertyDefinition } from '@dimina/common'

const TYPE_MAPS = {
	s: String,
	n: Number,
	b: Boolean,
	o: Object,
	a: Array,
}

export class Module {
	constructor(moduleInfo) {
		this.moduleInfo = moduleInfo
	}

	setInitialData(props) {
		this.builtinBehaviors = new Set(props?.__diminaMeta?.builtinBehaviors || [])
		const serializedProps = props ? { ...props } : props
		if (serializedProps) delete serializedProps.__diminaMeta
		const { propertySchemas, vueProps } = this.unSerializeProps(serializedProps)
		this.propertySchemas = propertySchemas
		this.props = vueProps
	}

	unSerializeProps(properties) {
		if (!properties) {
			return {
				propertySchemas: {},
				vueProps: {},
			}
		}
		const propertySchemas = {}
		const vueProps = {}
		for (const key in properties) {
			const property = properties[key]
			const serializedTypes = Array.isArray(property.type) ? property.type : [property.type]
			const types = serializedTypes.map(item => this.convertStringToType(item))
			propertySchemas[key] = normalizePropertyDefinition({
				type: types[0],
				optionalTypes: types.slice(1),
				value: property.default,
			})
			// Vue props 只承担值传输，禁止其 Boolean casting/默认值覆盖小程序语义。
			vueProps[key] = { type: null }
			if (property.cls) {
				vueProps[key].cls = true
			}
		}

		return { propertySchemas, vueProps }
	}

	/**
	 * 将字符串转换成实际类型
	 * @param {*} type
	 */
	convertStringToType(type) {
		if (type === null) {
			return null
		}
		const result = TYPE_MAPS[type]
		if (!result) {
			console.warn('[system]', '[render]', `unknown props type ${type}`)
		}
		return result
	}
}
