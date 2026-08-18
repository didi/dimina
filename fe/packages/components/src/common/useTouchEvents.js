import { attachTouchEvents } from './touchGestures'

/**
 * 组件版的手势安装：把 attachTouchEvents 绑到组件的挂载/卸载生命周期上。
 *
 * 手势语义本身全部在 touchGestures.js 里，编译产物中保持为原生元素的 canvas
 * 走 c-event-node 指令调用同一个 attachTouchEvents，两条路径不会各自实现一套。
 *
 * @param {object} info 组件信息
 * @param {object} elementRef 元素引用
 * @param {object} [options] 行为选项
 * @param {number} [options.longPressThreshold] 长按触发阈值，单位毫秒
 * @param {number} [options.moveThreshold] 判定为移动的阈值，单位像素
 * @param {object} [options.relativeTo] 元素引用；给定后每个触摸点额外带上相对该元素左上角的 x / y
 */
export function useTouchEvents(info, elementRef, options = {}) {
	const { relativeTo = null, ...rest } = options
	let detach = null
	let catchSignature = ''
	let installedElement = null

	const currentCatchSignature = () => ['touchstart', 'touchmove', 'touchend', 'touchcancel']
		.map(type => Boolean(info.attrs?.[`catch${type}`] || info.attrs?.[`catch:${type}`]))
		.join(':')

	const install = () => {
		if (!elementRef.value) return
		detach?.()
		detach = attachTouchEvents(info, elementRef.value, {
			...rest,
			// 组件的上下文与选项比指令兜底的更权威，可以从已装上的指令手里接管
			takeOver: true,
			getRelativeElement: relativeTo ? () => relativeTo.value : null,
		})
		catchSignature = currentCatchSignature()
		installedElement = elementRef.value
	}

	onMounted(install)

	// 控件的根元素可能换成另一个节点（如 switch 的 checkbox / switch 两种形态）。
	// 手势装在旧节点上就等于控件失去全部交互，新节点上一个监听器都没有。
	// 判据是「装在哪个节点上」而不是 ref 是否变动：重装会作废正在结算的触摸序列，
	// 节点没换却重装一次，正好会吃掉这一次 tap。
	watch(elementRef, () => {
		if (elementRef.value && elementRef.value !== installedElement) install()
	}, { flush: 'post' })

	onUpdated(() => {
		// passive 选项只能在注册监听器时决定；bind/catch 动态切换时精确重装。
		if (catchSignature !== currentCatchSignature()) install()
	})

	onUnmounted(() => {
		// 已开始的原生序列仍以真实 touchend/touchcancel 收口；卸载不能伪造终态。
		detach?.({ preserveActive: true })
		detach = null
	})
}
