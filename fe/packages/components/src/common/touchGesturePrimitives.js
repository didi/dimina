// 合成的 TouchEvent 可能带着空的 touches 列表（自动化工具就是这么派发的），
// 拿不到触摸点时退回原点，序列本身仍要正常走完
export const ORIGIN_POINT = {
	identifier: 0,
	clientX: 0,
	clientY: 0,
	pageX: 0,
	pageY: 0,
	screenX: 0,
	screenY: 0,
	force: 0,
}

export function firstPoint(...lists) {
	for (const list of lists) {
		const point = list && list[0]
		if (point) {
			return point
		}
	}
	return ORIGIN_POINT
}

export function touchPoints(list, getRelativeElement) {
	const element = getRelativeElement?.()
	const rect = element?.getBoundingClientRect?.()
	return Array.from(list || []).map((touch) => {
		const point = {
			identifier: touch.identifier,
			clientX: touch.clientX,
			clientY: touch.clientY,
			pageX: touch.pageX,
			pageY: touch.pageY,
			screenX: touch.screenX,
			screenY: touch.screenY,
			force: touch.force,
		}
		if (rect) {
			point.x = touch.clientX - rect.left
			point.y = touch.clientY - rect.top
		}
		return point
	})
}

/**
 * 控件被 label 激活时补发的 tap。
 *
 * button 与勾选类控件不同：官方在 label 激活时让它派发自己的 tap，而且这次 tap 会沿组件树冒泡
 * ——微信里点 label 文字，button 收到一次 tap，label 和外层 view 各收到两次（一次来自这里，
 * 一次来自原始触摸序列）。激活是一次直接调用而不是原生事件，所以用一个冒泡的自定义事件
 * 把同一次 tap 交给路径上的每个手势 owner。
 */
export const ACTIVATION_TAP_EVENT = 'dd:activationtap'

/**
 * @param {HTMLElement} element 被激活的控件根元素，这次 tap 的 target
 * @param {object} sourceEvent 触发激活的那个 label tap 事件，提供触摸点与坐标
 */
export function dispatchActivationTap(element, sourceEvent) {
	if (!element) {
		return
	}
	element.dispatchEvent(new CustomEvent(ACTIVATION_TAP_EVENT, {
		bubbles: true,
		detail: { sourceEvent },
	}))
}

export function sharedSequenceState(nativeEvent) {
	if (!nativeEvent.__ddGestureSequenceState) {
		nativeEvent.__ddGestureSequenceState = { tapSuppressed: false }
	}
	return nativeEvent.__ddGestureSequenceState
}

/**
 * tap 属于完整 touchend 冒泡后的合成阶段。所有 owner 在同一原生 dispatch 中先登记任务，
 * microtask 再按 listener 实际到达顺序统一派发，DOM 同步移除和 document 级 pointerup
 * 都不会让某个 owner 提前收口或永久滞留后续任务。
 */
export function enqueueAfterTouchEnd(nativeEvent, task) {
	const state = nativeEvent.__ddAfterTouchEnd || { jobs: [], scheduled: false }
	nativeEvent.__ddAfterTouchEnd = state
	state.jobs.push(task)
	if (state.scheduled) return
	state.scheduled = true
	queueMicrotask(() => {
		for (const job of state.jobs.splice(0)) job()
		state.scheduled = false
	})
}

export function markStopped(nativeEvent, type) {
	if (!nativeEvent) {
		return
	}
	if (!nativeEvent.__ddStoppedTypes) {
		nativeEvent.__ddStoppedTypes = new Set()
	}
	nativeEvent.__ddStoppedTypes.add(type)
}

export function isStopped(nativeEvent, type) {
	return Boolean(nativeEvent && nativeEvent.__ddStoppedTypes && nativeEvent.__ddStoppedTypes.has(type))
}

/**
 * 本次事件涉及的触点标识。手势 owner 用它维护自己的触点账本：只有经由本节点 touchstart
 * 到达的触点才算数，别处按下的手指不参与本节点的单指判定，也不该拖住它的序列不放。
 * 合成事件可能不带 changedTouches，这时按调用方给的兜底标识当作一个触点，序列照常走完。
 */
export function eventIdentifiers(event, fallbackIdentifier = ORIGIN_POINT.identifier) {
	const changed = Array.from(event?.changedTouches || [])
	if (changed.length) {
		return changed.map(touch => touch.identifier)
	}
	return [fallbackIdentifier]
}

export function pointWithIdentifier(identifier, ...lists) {
	for (const list of lists) {
		const point = Array.from(list || []).find(item => item.identifier === identifier)
		if (point) return point
	}
	return null
}

function allowsNativeScroll(element, axis) {
	const overflow = window.getComputedStyle(element)[axis]
	return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay'
}

function canScrollHorizontally(element, deltaX) {
	const maxScrollLeft = element.scrollWidth - element.clientWidth
	const scrollLeft = element.scrollLeft
	const rtl = window.getComputedStyle(element).direction === 'rtl'
	if (rtl && scrollLeft <= 0) {
		return (deltaX > 0 && scrollLeft > -maxScrollLeft)
			|| (deltaX < 0 && scrollLeft < 0)
	}
	return (deltaX > 0 && scrollLeft > 0)
		|| (deltaX < 0 && maxScrollLeft - scrollLeft >= 1)
}

export function shouldBlockNativeScroll(event, touch, boundary, previousClientX, previousClientY) {
	const deltaX = touch.clientX - previousClientX
	const deltaY = touch.clientY - previousClientY
	const horizontal = Math.abs(deltaX) > Math.abs(deltaY)
	for (const pathElement of event?.composedPath?.() || []) {
		if (horizontal && allowsNativeScroll(pathElement, 'overflowX')
			&& pathElement.scrollWidth > pathElement.clientWidth) {
			if (canScrollHorizontally(pathElement, deltaX)) return false
		}
		else if (!horizontal && allowsNativeScroll(pathElement, 'overflowY')
			&& pathElement.scrollHeight > pathElement.clientHeight) {
			const maxScrollTop = pathElement.scrollHeight - pathElement.clientHeight
			if ((deltaY > 0 && pathElement.scrollTop > 0)
				|| (deltaY < 0 && maxScrollTop - pathElement.scrollTop >= 1)) return false
		}
		// Descendants and the catch owner may scroll; ancestors outside the catch boundary may not.
		if (pathElement === boundary) break
	}
	return true
}

// 鼠标 / 触控笔按官方基础库的做法伪造成 identifier 为 0 的单点触摸序列。
export function pointerToTouch(event) {
	return {
		identifier: 0,
		clientX: event.clientX,
		clientY: event.clientY,
		pageX: event.pageX,
		pageY: event.pageY,
		screenX: event.screenX,
		screenY: event.screenY,
		force: event.pressure ?? 0,
	}
}
