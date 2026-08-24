/**
 * label 激活控件的定向入口。
 *
 * 官方 label 通过一个独立的、不冒泡的事件激活控件：控件执行自己的动作（切换、聚焦、change），
 * 但不会补发一次控件自己的 tap，也不会波及控件的祖先。这里用登记在控件根元素上的激活回调
 * 表达同一件事，取代 target.click()——click 会被手势层当成一次独立交互再合成一次 tap，
 * 并且会沿 DOM 冒泡把 tap 派给控件的祖先。
 */

const ACTIVATION_KEY = '__ddLabelActivate'

/**
 * label 内部查找可激活控件用的选择器，querySelector 天然返回文档序第一个。
 * 可激活的控件只有 button、checkbox、input、radio、switch 五种；textarea 和 slider
 * 不在其列，label 会跳过它们继续往后找。
 */
export const LABEL_TARGET_SELECTOR = '[data-dd-label-target], input'

/** 没有组件登记入口的原生控件，激活即聚焦 */
const NATIVE_TARGET_SELECTOR = 'input'

/**
 * 把控件的激活动作登记到它的根元素上。
 *
 * @param {object} elementRef 控件根元素引用
 * @param {Function} activate 激活动作，入参是触发激活的那个 label tap 事件
 */
export function useLabelActivation(elementRef, activate) {
	let bound = null

	const bind = (element) => {
		if (bound && bound[ACTIVATION_KEY] === activate) {
			delete bound[ACTIVATION_KEY]
		}
		bound = element ?? null
		if (bound) {
			bound[ACTIVATION_KEY] = activate
		}
	}

	onMounted(() => bind(elementRef.value))
	// 控件的根元素可能换成另一个节点（如 switch 的 checkbox / switch 两种形态）
	watch(elementRef, element => bind(element), { flush: 'post' })
	onUnmounted(() => bind(null))
}

/**
 * 激活一个 label 目标。
 *
 * @param {Element} element 目标元素
 * @param {object} event 触发激活的 label tap 事件
 * @returns {boolean} 目标是否可激活
 */
export function activateLabelTarget(element, event) {
	const activate = element?.[ACTIVATION_KEY]
	if (typeof activate === 'function') {
		// 事件的 id 与 dataset 取自 currentTarget/target，所以控件派发的事件必须以控件
		// 自己为这两者——否则小程序收到的 change 会带着 label 的 dataset。
		// 触摸点和坐标仍沿用 label 这次 tap 的。
		activate(event ? { ...event, currentTarget: element, target: element } : event)
		return true
	}
	if (typeof element?.matches === 'function' && element.matches(NATIVE_TARGET_SELECTOR)) {
		element.focus()
		return true
	}
	return false
}
