import { hasCatchEvent, triggerEvent } from './events'

/**
 * 处理组件的触摸相关事件
 * 封装了触摸事件的添加、移除和检测catch事件处理器的逻辑
 * @param {object} info 组件信息
 * @param {object} elementRef 元素引用
 * @param {number} longPressThreshold 长按触发阈值，单位毫秒
 * @param {number} moveThreshold 判定为移动的阈值，单位像素
 */
export function useTouchEvents(info, elementRef, longPressThreshold = 350, moveThreshold = 10) {
	// 长按相关状态
	const longPressTimer = ref(null)
	const touchStartPosition = ref({ x: 0, y: 0 })
	const isTouchMoved = ref(false)
	const canMoveStatus = ref('init')


	/**
	 * 触摸开始事件处理
	 * @param {Event} event 原始事件对象
	 */
	function onTouchStart(event) {
		// currentTarget 在异步回调中可能为空，此处保存引用
		const currentTarget = event.currentTarget
		const touch = event.touches[0]
		touchStartPosition.value = { x: touch.clientX, y: touch.clientY }
		isTouchMoved.value = false
		canMoveStatus.value = 'init'

		// 清除可能存在的定时器
		if (longPressTimer.value) {
			clearTimeout(longPressTimer.value)
		}

		// 设置长按定时器
		longPressTimer.value = setTimeout(() => {
			// 如果触摸没有移动太多，则触发长按事件
			if (!isTouchMoved.value) {
				// longtap 是 longpress 的历史别名，exparser 会按实际绑定分发。
				const preservedEvent = { ...event, currentTarget }
				triggerEvent('longpress', { event: preservedEvent, info })
				triggerEvent('longtap', { event: preservedEvent, info })
			}
			longPressTimer.value = null
		}, longPressThreshold)

		triggerEvent('touchstart', { event, info })
	}

	/**
	 * 触摸移动事件处理
	 * @param {Event} event 原始事件对象
	 */
	function onTouchMove(event) {
		const touch = event.touches[0]
		const moveX = Math.abs(touch.clientX - touchStartPosition.value.x)
		const moveY = Math.abs(touch.clientY - touchStartPosition.value.y)

		// 如果移动距离超过阈值，则标记为已移动
		if (moveX > moveThreshold || moveY > moveThreshold) {
			isTouchMoved.value = true

			// 如果移动了，取消长按定时器
			if (longPressTimer.value) {
				clearTimeout(longPressTimer.value)
				longPressTimer.value = null
			}
		}

		// 针对 catchtouchmove 场景，防止滚动穿透
		if (hasCatchEvent(info, 'touchmove')) {
			if (canMoveStatus.value === 'off') {
				// 阻止浏览器默认滚动行为
				event.cancelable && event.preventDefault()
				return
			}

			// 遍历事件传递路径元素，找到包含滚动条的元素
			const path = event?.composedPath() || []

			for (const element of path) {
				const { scrollHeight, clientHeight, scrollTop } = element
				if (scrollHeight > clientHeight) {
					// 向下滑动，查看上方内容
					if (touch.clientY - touchStartPosition.value.y > 0) {
						// 到顶后，继续拖动就阻止浏览器默认的滚动事件
						scrollTop === 0 && preventDefaultMove(event)
					} else if (scrollHeight - clientHeight - scrollTop < 1) {
						// 向上滑动，查看下方内容，到容器底部，阻止浏览器默认的滚动事件
						// 因为scrollTop是一个非整数，而scrollHeight和clientHeight是四舍五入的，因此确定滚动区域是否滚动到底的唯一方法是查看滚动量是否足够接近某个阈值
						preventDefaultMove(event)
					} else {
						canMoveStatus.value = 'on'
					}
					break;
				}
			}
		}

		triggerEvent('touchmove', { event, info })
	}

	/**
	 * 禁止浏览器默认行为事件处理
	 * @param {Event} event 原始事件对象
	 */
	function preventDefaultMove(event) {
		event.cancelable && event.preventDefault()
		canMoveStatus.value === 'init' && (canMoveStatus.value = 'off')
	}

	/**
	 * 触摸结束事件处理
	 * @param {Event} event 原始事件对象
	 */
	function onTouchEnd(event) {
		// 清除长按定时器
		if (longPressTimer.value) {
			clearTimeout(longPressTimer.value)
			longPressTimer.value = null
		}

		triggerEvent('touchend', { event, info })
	}

	/**
	 * 触摸取消事件处理
	 * @param {Event} event 原始事件对象
	 */
	function onTouchCancel(event) {
		// 清除长按定时器
		if (longPressTimer.value) {
			clearTimeout(longPressTimer.value)
			longPressTimer.value = null
		}

		triggerEvent('touchcancel', { event, info })
	}

	// 检查是否有catch事件处理器
	// 支持写法：catchtouchstart、catch:touchstart
	const hasCatchTouchStart = hasCatchEvent(info, 'touchstart')
	const hasCatchTouchMove = hasCatchEvent(info, 'touchmove')
	const hasCatchTouchEnd = hasCatchEvent(info, 'touchend')
	const hasCatchTouchCancel = hasCatchEvent(info, 'touchcancel')

	// 在组件挂载时添加事件监听器
	onMounted(() => {
		if (elementRef.value) {
			elementRef.value.addEventListener('touchstart', onTouchStart, { passive: !hasCatchTouchStart })
			elementRef.value.addEventListener('touchmove', onTouchMove, { passive: !hasCatchTouchMove })
			elementRef.value.addEventListener('touchend', onTouchEnd, { passive: !hasCatchTouchEnd })
			elementRef.value.addEventListener('touchcancel', onTouchCancel, { passive: !hasCatchTouchCancel })
		}
	})

	// 在组件卸载时移除事件监听器
	onUnmounted(() => {
		if (elementRef.value) {
			elementRef.value.removeEventListener('touchstart', onTouchStart, { passive: !hasCatchTouchStart })
			elementRef.value.removeEventListener('touchmove', onTouchMove, { passive: !hasCatchTouchMove })
			elementRef.value.removeEventListener('touchend', onTouchEnd, { passive: !hasCatchTouchEnd })
			elementRef.value.removeEventListener('touchcancel', onTouchCancel, { passive: !hasCatchTouchCancel })
		}
	})
}
