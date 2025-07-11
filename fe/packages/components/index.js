import { animationToStyle, getDataAttributes, toCamelCase, transformRpx } from '@dimina/common'
import { triggerEvent, useInfo } from '@/common/events'
import { deepToRaw, install } from '@/common/utils'
import components from './src/index'

export * from './src/index'

function transformAnimation(el, propertyValue) {
	if (!propertyValue?.actions?.length)
		return

	let currentIndex = 0
	const actions = propertyValue.actions

	function executeAnimation() {
		if (currentIndex >= actions.length)
			return

		const currentAction = actions[currentIndex]
		const style = animationToStyle(currentAction)

		// 创建动画
		const animation = el.animate(
			style.keyframes,
			style.options,
		)

		// 设置动画完成回调，执行下一个动画
		animation.onfinish = () => {
			currentIndex++
			executeAnimation()
		}
	}
	// 开始执行动画序列
	executeAnimation()
}

function transformCss(el, val, append) {
	const convertedStyle = transformRpx(val)
	if (append) {
		// 防止覆盖组件自身样式
		el.style.cssText += convertedStyle
	}
	else {
		el.style.cssText = convertedStyle
	}
}

function parseDataset(el, vnode) {
	el._ds = getDataAttributes(vnode.ctx.attrs, deepToRaw)
}

function parseExternalClass(el, instance, vnode) {
	const ctx = vnode.ctx
	if (instance.props && Array.isArray(ctx.provides.externalClasses)) {
		for(const externalClass of ctx.provides.externalClasses) {
			const clsName = instance.props[toCamelCase(externalClass)]
			if (clsName) {
				el.className = el.className.replace(externalClass, clsName)
				if (!el.hasAttribute(instance.sId)) {
					el.setAttribute(instance.sId, '')
				}
			}
		}
	}
}

function Components(app) {
	app.directive('c-style', {
		mounted(el, binding) {
			transformCss(el, binding.value, true)
		},
		updated(el, binding) {
			transformCss(el, binding.value, false)
		},
	})

	app.directive('c-animation', {
		mounted(el, binding) {
			transformAnimation(el, binding.value)
		},
		updated(el, binding) {
			transformAnimation(el, binding.value)
		},
	})

	app.directive('c-data', {
		mounted(el, _binding, vnode) {
			parseDataset(el, vnode)
		},
		updated(el, _binding, vnode) {
			parseDataset(el, vnode)
		},
	})

	app.directive('c-class', {
		mounted(el, binding, vnode) {
			parseExternalClass(el, binding.instance, vnode)
		},
		updated(el, binding, vnode) {
			parseExternalClass(el, binding.instance, vnode)
		},
	})

	return components.forEach((component) => {
		component.mixins = [{
			inheritAttrs: false,
		}]
		install(app, component)
	})
}

const tagWhiteList = components.map(obj => obj.__tagName)

export { Components, deepToRaw, tagWhiteList, triggerEvent, useInfo }
