import { animationToStyle, getDataAttributes, toCamelCase, transformRpx } from '@dimina/common'
import { hasInteractionEvent, triggerEvent, useInfo } from '@/common/events'
import { attachTouchEvents } from '@/common/touchGestures'
import { deepToRaw, install, replaceExternalClassTokens } from '@/common/utils'
import components from './src/index'

export * from './src/index'

const EXTERNAL_CLASS_SCOPE_ATTRIBUTE = 'data-dd-external-class-scope'
const LEGACY_COMPONENT_TAG_ALIASES = {
	'component-host': ['dd-wrapper'],
}

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

const directiveStyleState = new WeakMap()

function snapshotStyle(style) {
	return new Map(Array.from(style, name => [name, {
		priority: style.getPropertyPriority(name),
		value: style.getPropertyValue(name),
	}]))
}

function restoreDirectiveStyle(el) {
	const originalDeclarations = directiveStyleState.get(el)
	if (!originalDeclarations) return

	for (const name of originalDeclarations.keys()) {
		el.style.removeProperty(name)
	}
	for (const [name, declaration] of originalDeclarations) {
		if (declaration) {
			el.style.setProperty(name, declaration.value, declaration.priority)
		}
	}
	directiveStyleState.delete(el)
}

function transformCss(el, val) {
	const convertedStyle = transformRpx(val)
	if (typeof convertedStyle !== 'string' || !convertedStyle.trim()) return

	const before = snapshotStyle(el.style)
	el.style.cssText += convertedStyle
	const after = snapshotStyle(el.style)
	const originalDeclarations = new Map()
	const declarationNames = new Set([...before.keys(), ...after.keys()])

	for (const name of declarationNames) {
		const previous = before.get(name)
		const current = after.get(name)
		if (previous?.value !== current?.value || previous?.priority !== current?.priority) {
			originalDeclarations.set(name, previous || null)
		}
	}

	if (originalDeclarations.size) {
		directiveStyleState.set(el, originalDeclarations)
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
				el.className = replaceExternalClassTokens(el.className, externalClass, clsName)
				if (!el.hasAttribute(instance.sId)) {
					el.setAttribute(instance.sId, '')
				}
				const scopeTokens = new Set(
					(el.getAttribute(EXTERNAL_CLASS_SCOPE_ATTRIBUTE) || '').split(/\s+/).filter(Boolean),
				)
				scopeTokens.add(instance.sId)
				el.setAttribute(EXTERNAL_CLASS_SCOPE_ATTRIBUTE, [...scopeTokens].join(' '))
			}
		}
	}
}

function collectEventBindings(props = {}) {
	const eventBindings = {}
	for (const [attrName, handler] of Object.entries(props || {})) {
		const match = attrName.match(/^(capture-)?(bind|catch)(?::)?(.+)$/)
		if (!match || handler === undefined || handler === null || handler === '') {
			continue
		}

		const [, capture, listenerType, eventType] = match
		const bindingType = capture
			? (listenerType === 'catch' ? 'captureCatch' : 'captureBind')
			: listenerType
		eventBindings[eventType] = eventBindings[eventType] || {}
		eventBindings[eventType][bindingType] = handler
	}
	return eventBindings
}

function getEventBindingRecord(el, binding, vnode) {
	const target = vnode.component?.proxy
	return el._ddEventBindings?.find(record => (
		record.owner === binding.instance
		&& record.target === target
		&& record.nodeType === binding.value
	))
}

function mountEventBindingRecord(el, binding, vnode) {
	const record = {
		owner: binding.instance,
		target: vnode.component?.proxy,
		nodeType: binding.value,
		eventAttr: collectEventBindings(vnode.props),
	}
	el._ddEventBindings = el._ddEventBindings || []
	el._ddEventBindings.push(record)
}

function updateEventBindingRecord(el, binding, vnode) {
	const record = getEventBindingRecord(el, binding, vnode)
	if (record) {
		record.eventAttr = collectEventBindings(vnode.props)
	}
}

function removeEventBindingRecord(el, binding, vnode) {
	const record = getEventBindingRecord(el, binding, vnode)
	if (!record) {
		return
	}
	const index = el._ddEventBindings.indexOf(record)
	if (index >= 0) {
		el._ddEventBindings.splice(index, 1)
	}
}

// 已编译的旧包里 canvas 是原生元素、不经过组件层，手势只能按元素安装在这里。
// 新产物把 canvas 编译成 dd-canvas，由组件自己安装，下面按 tagName 判断天然把它排除在外。
// key 是 canvas 元素，value 是 { detach, info }，info 复用同一个对象引用，
// 属性更新时改写它的 attrs 就能让已安装的手势跟上新的处理函数名。
const canvasGestures = new WeakMap()

/**
 * 从元素 vnode 解析出派发事件所需的节点信息。
 * 页面根组件与自定义组件都 provide 了 bridgeId / path / path->{id}，
 * 指令读 provides 链的做法与 parseExternalClass 一致。
 * @param {object} vnode 元素 vnode
 * @returns {object|null} 含 attrs / bridgeId / moduleId 的节点信息，取不全时为 null
 */
function resolveNodeInfo(vnode) {
	const provides = vnode.ctx?.provides
	const path = provides?.path
	const moduleId = path ? provides[path]?.id : undefined
	if (provides?.bridgeId === undefined || moduleId === undefined) {
		return null
	}
	return { attrs: vnode.props || {}, bridgeId: provides.bridgeId, moduleId }
}

function canvasDisableScroll(attrs = {}) {
	const value = attrs['disable-scroll'] ?? attrs.disableScroll
	return value !== undefined && value !== null && value !== false && value !== 'false'
}

function canvasGestureSignature(attrs = {}) {
	return [
		...['touchstart', 'touchmove', 'touchend', 'touchcancel']
			.map(type => Boolean(attrs[`catch${type}`] || attrs[`catch:${type}`])),
		canvasDisableScroll(attrs),
	].join(':')
}

function mountCanvasGestures(el, vnode) {
	if (el.tagName !== 'CANVAS' || el.__ddGestureDetach) {
		return
	}
	const info = resolveNodeInfo(vnode)
	if (!info || (!hasInteractionEvent(info) && !canvasDisableScroll(info.attrs))) {
		return
	}
	const detach = attachTouchEvents(info, el, {
		disableScroll: () => canvasDisableScroll(info.attrs),
		getRelativeElement: () => el,
	})
	canvasGestures.set(el, { detach, info, gestureSignature: canvasGestureSignature(info.attrs), latestVNode: vnode })
}

// passive 选项只能在注册监听器时决定，所以 catch 绑定或 disable-scroll 变化必须重装监听器。但重装
// 会清掉活动序列、长按计时器和 tap 状态，正在进行的这次触摸就再也发不出 tap / longpress /
// canceltap，所以要等它自己以 touchend / touchcancel 收口之后再换 owner。
// 期间到达的属性更新只更新 latestVNode，换 owner 时按最新的一份重新解析。
function swapCanvasGestures(el, state) {
	if (state.pendingSwap) return
	state.pendingSwap = true
	state.detach({
		preserveActive: true,
		onDetached: () => {
			// 卸载或被组件接管时这条登记已经作废，不能拿它把手势再装回去。
			if (canvasGestures.get(el) !== state) return
			canvasGestures.delete(el)
			mountCanvasGestures(el, state.latestVNode)
		},
	})
}

function updateCanvasGestures(el, vnode) {
	const state = canvasGestures.get(el)
	const attrs = vnode.props || {}
	// 组件 owner 接管后，指令保存的 detach 已不再是当前 owner，不得反向抢回元素。
	if (state && el.__ddGestureDetach !== state.detach) {
		canvasGestures.delete(el)
		return
	}
	if (!state) {
		mountCanvasGestures(el, vnode)
		return
	}
	state.latestVNode = vnode
	// 交互事件全部撤掉时也走同一条路：mountCanvasGestures 对没有交互事件的 canvas 不装手势。
	if (!hasInteractionEvent({ attrs }) && !canvasDisableScroll(attrs)) {
		swapCanvasGestures(el, state)
		return
	}
	if (state.gestureSignature !== canvasGestureSignature(attrs)) {
		swapCanvasGestures(el, state)
		return
	}
	state.info.attrs = attrs
}

function unmountCanvasGestures(el) {
	const state = canvasGestures.get(el)
	if (state) {
		state.detach({ preserveActive: true, nodeRemoved: true })
		canvasGestures.delete(el)
	}
}

function Components(app) {
	app.directive('c-style', {
		mounted(el, binding) {
			transformCss(el, binding.value)
		},
		beforeUpdate(el) {
			// Remove only declarations owned by the previous WXML style value.
			// Vue can then patch the component's own inline style independently.
			restoreDirectiveStyle(el)
		},
		updated(el, binding) {
			transformCss(el, binding.value)
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

	app.directive('c-prop-bindings', {
		mounted(el, binding) {
			// 将属性绑定信息存储在 DOM 元素上，供 render 层使用
			// 使用动态绑定，Vue 会自动将 HTML 实体解码后的 JSON 解析为对象
			el._propBindings = binding.value || {}
		},
	})

	app.directive('c-event-node', {
		mounted(el, binding, vnode) {
			mountEventBindingRecord(el, binding, vnode)
			mountCanvasGestures(el, vnode)
		},
		updated(el, binding, vnode) {
			updateEventBindingRecord(el, binding, vnode)
			updateCanvasGestures(el, vnode)
		},
		beforeUnmount(el, binding, vnode) {
			removeEventBindingRecord(el, binding, vnode)
			unmountCanvasGestures(el)
		},
	})

	return components.forEach((component) => {
		component.mixins = [{
			inheritAttrs: false,
		}]
		install(app, component)
		for (const alias of LEGACY_COMPONENT_TAG_ALIASES[component.__tagName] || []) {
			// Keep already-compiled applications working while new output uses
			// dd-component-host exclusively.
			app.component(alias, component)
		}
	})
}

const tagWhiteList = components.map(obj => obj.__tagName)

export { Components, deepToRaw, tagWhiteList, triggerEvent, useInfo }
