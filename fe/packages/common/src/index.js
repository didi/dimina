// 从 core/amd 导入
export { hasModule, modDefine, modRequire } from './core/amd'

// 从 core/callback 导入
export { default as callback } from './core/callback'

export {
	CANVAS_ACTIVE_PROP,
	CANVAS_CONTRACT_CHANGE_EVENT,
	CANVAS_NODE_PROP,
	CANVAS_OWNER_PROP,
} from './core/dom-contract'

export {
	CANVAS_RGBA_BYTES_PER_PIXEL,
	canvasPixelBudgetError,
	MAX_CANVAS_BITMAP_PIXELS,
	MAX_CANVAS_DIMENSION,
	MAX_CANVAS_IMAGE_BYTES,
	MAX_CANVAS_TRANSFER_PIXELS,
	normalizeCanvasBitmapDimension,
} from './core/canvas-limits'

export {
	createDataFunctionReference,
	getDataFunctionReferenceId,
	isDataFunctionReference,
	transformDataFunctions,
} from './core/data-function'

export {
	matchesPropertyType,
	normalizePropertyDefinition,
	normalizePropertyValues,
	resolvePropertyValue,
} from './core/properties'

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
} from './core/utils'
