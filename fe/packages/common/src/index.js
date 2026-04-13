// 从 core/amd 导入
export { modDefine, modRequire } from '@/core/amd'

// 从 core/callback 导入
export { default as callback } from '@/core/callback'

// 从 core/utils 导入
export {
	animationToStyle,
	camelCaseToUnderscore,
	cloneDeep,
	deepEqual,
	get,
	getDataAttributes,
	isAndroid,
	isDesktop,
	isFunction,
	isHarmonyOS,
	isIOS,
	isNil,
	isString,
	isWebWorker,
	parsePath,
	set,
	sleep,
	suffixPixel,
	toCamelCase,
	transformRpx,
	uuid,
} from '@/core/utils'
