import { hasCatchEvent, hasEvent, triggerEvent } from './events'
import {
	ACTIVATION_TAP_EVENT,
	enqueueAfterTouchEnd,
	eventIdentifiers,
	firstPoint,
	isStopped,
	markStopped,
	ORIGIN_POINT,
	pointerToTouch,
	pointWithIdentifier,
	sharedSequenceState,
	touchPoints,
	shouldBlockNativeScroll,
} from './touchGesturePrimitives'

/**
 * 在一个元素上安装完整的手势处理，返回卸载函数。
 *
 * 这里是 touchstart / touchmove / touchend / touchcancel / longpress / longtap /
 * tap / canceltap 的唯一来源，tap 由触摸序列合成而不是监听原生 click，
 * 这样 canvas 这类只有触摸通道的节点也能拿到 tap，长按也才能按官方语义抑制随后的 tap。
 *
 * 纯 DOM 实现，不依赖 Vue：组件走 useTouchEvents 薄壳，已编译的旧包里保持为原生元素的
 * canvas 走 c-event-node 指令，两条路径共用这一份。
 *
 * @param {object} info 节点信息，需含 attrs / bridgeId / moduleId
 * @param {HTMLElement} element 安装监听器的元素
 * @param {object} [options] 行为选项
 * @param {number} [options.longPressThreshold] 长按触发阈值，单位毫秒
 * @param {number} [options.moveThreshold] 判定为移动的阈值，单位像素
 * @param {Function} [options.getRelativeElement] 返回一个元素；给定后每个触摸点额外带上相对该元素左上角的 x / y
 * @param {Function} [options.tapHandler] 组件内建动作与 tap 派发的统一处理器
 * @param {boolean|Function} [options.disableScroll] 是否阻止原生 touchmove 默认滚动
 * @param {Function} [options.resolveTarget] 把原生事件源换成小程序看得见的那个节点
 * @returns {Function} 卸载函数
 */
export function attachTouchEvents(info, element, options = {}) {
	// 一个元素只允许有一个手势所有者，且组件路径的优先级高于指令路径：组件手里的
	// info 来自 useInfo()（处理了插槽嵌套），还带着自己的相对坐标选项，
	// 指令只是无人认领时的兜底。
	// 顺序不能当判据——实测 Vue 的指令 mounted 先于同一实例的 onMounted 执行，
	// 所以组件要能从已装上的指令手里接管，而不是靠自己先到。
	if (element.__ddGestureDetach) {
		if (!options.takeOver) {
			return () => {}
		}
		element.__ddGestureDetach()
	}

	const {
		longPressThreshold = 350,
		moveThreshold = 10,
		getRelativeElement = null,
		tapHandler = null,
		disableScroll = false,
		resolveTarget = null,
	} = options

	let longPressTimer = null
	let startClientX = 0
	let startClientY = 0
	let previousClientX = 0
	let previousClientY = 0
	let hasPreviousTouchPoint = false
	let startTouches = []
	let startChangedTouches = []
	let sequenceTarget = null
	let isMoved = false
	let hasCancelTap = false
	let isTapSuppressed = false
	let sequenceGeneration = 0
	let attached = true
	let detachRequested = false
	// detach 被推迟时等着的回调；调用方靠它把"换 owner"排在当前这次触摸收口之后。
	const detachedCallbacks = []
	let activeInputType = null
	let activeTouchIdentifier = null
	// 本 owner 自己见过的触点。别处元素上的手指本节点收不到 touchstart/touchend，只会在
	// event.touches 里露面，不能参与单指判定，也不能决定这次触摸输入什么时候算结束。
	const ownTouches = new Set()
	let activePointerId = null
	let activePointerTouch = null
	let sequenceState = null
	const toPoints = list => touchPoints(list, getRelativeElement)

	/**
	 * 组装交给 triggerEvent 的事件对象。
	 * catch 阻断只在原生事件上按类型打标记，不阻断原生冒泡：祖先仍需观察完整原生序列来
	 * 推进自己的状态机，而后代的 catch:tap 也不该顺带吃掉祖先的 bindtouchend。
	 */
	function makeEvent(type, nativeEvent, payload) {
		return {
			// 组件用来搭出自己形态的内部节点不是小程序声明过的节点，事件源必须换回组件自己的
			// 根节点，否则 target 上取不到开发者写的 id 与 data-*。
			target: resolveTarget ? resolveTarget(payload.target) : payload.target,
			currentTarget: element,
			touches: payload.touches,
			changedTouches: payload.changedTouches,
			clientX: payload.clientX,
			clientY: payload.clientY,
			pageX: payload.pageX,
			pageY: payload.pageY,
			cancelable: Boolean(nativeEvent?.cancelable),
			preventDefault: () => {
				if (nativeEvent?.cancelable) {
					nativeEvent.preventDefault()
				}
			},
			stopPropagation: () => {
				// 祖先仍需观察完整原生序列来推进自己的 tap/longpress 状态机；
				// 按类型标记只抑制祖先派发当前事件，不阻断原生监听器执行。
				markStopped(nativeEvent, type)
			},
			composedPath: () => nativeEvent?.composedPath?.() || [],
		}
	}

	function emit(type, nativeEvent, payload, detail) {
		if (!attached || isStopped(nativeEvent, type)) {
			return
		}
		const event = makeEvent(type, nativeEvent, payload)
		if (type === 'tap' && tapHandler) {
			tapHandler({ event, detail, info })
			return
		}
		triggerEvent(type, { event, detail, info })
	}

	function clearLongPressTimer() {
		if (longPressTimer) {
			clearTimeout(longPressTimer)
			longPressTimer = null
		}
	}

	function sequencePayload(nativeEvent, touches, changedTouches, point) {
		return {
			target: sequenceTarget ?? nativeEvent?.target,
			touches,
			changedTouches,
			clientX: point?.clientX,
			clientY: point?.clientY,
			pageX: point?.pageX,
			pageY: point?.pageY,
		}
	}

	function sendCancelTap(nativeEvent, point) {
		// 位移取消后的每一条 touchmove 都带一条 canceltap，不是整个序列只发一条：微信真机探针里
		// 两次越过阈值的移动就记到两条 canceltap。hasCancelTap 只用来让 touchend 的终点复查与
		// touchcancel 不再重复补发。
		hasCancelTap = true
		emit('canceltap', nativeEvent, sequencePayload(nativeEvent, startTouches, startChangedTouches, point))
	}

	function startSequence(nativeEvent, touches, changedTouches, point) {
		sequenceTarget = nativeEvent?.target ?? null
		sequenceState = sharedSequenceState(nativeEvent)
		const startedSequenceState = sequenceState
		startClientX = point.clientX
		startClientY = point.clientY
		previousClientX = point.clientX
		previousClientY = point.clientY
		hasPreviousTouchPoint = true
		startTouches = toPoints(touches)
		startChangedTouches = toPoints(changedTouches)
		isMoved = false
		hasCancelTap = false
		isTapSuppressed = false
		const generation = ++sequenceGeneration

		clearLongPressTimer()
		longPressTimer = setTimeout(() => {
			longPressTimer = null
			if (!attached || generation !== sequenceGeneration || isMoved) {
				return
			}
			const payload = sequencePayload(nativeEvent, startTouches, startChangedTouches, point)
			// longtap 派发可能同步开始新序列或卸载 owner；旧 timer 结果不能污染新状态。
			emit('longtap', nativeEvent, payload)
			if (!attached || generation !== sequenceGeneration) {
				return
			}
			emit('longpress', nativeEvent, payload)
			if (attached && generation === sequenceGeneration && hasEvent(info, 'longpress')) {
				isTapSuppressed = true
				// A descendant owns the native gesture's tap decision. Ancestors observe the
				// same touchstart state and must not synthesize a separate tap after longpress.
				startedSequenceState.tapSuppressed = true
			}
		}, longPressThreshold)

		emit('touchstart', nativeEvent, sequencePayload(nativeEvent, startTouches, startChangedTouches))
	}

	function exceedsMoveThreshold(point) {
		return Math.abs(point.clientX - startClientX) > moveThreshold
			|| Math.abs(point.clientY - startClientY) > moveThreshold
	}

	function moveSequence(nativeEvent, touches, changedTouches, point) {
		const generation = sequenceGeneration
		if (exceedsMoveThreshold(point)) {
			if (!isMoved) {
				isMoved = true
				clearLongPressTimer()
			}
		}
		if (generation !== sequenceGeneration) return
		previousClientX = point.clientX
		previousClientY = point.clientY
		emit('touchmove', nativeEvent, sequencePayload(nativeEvent, toPoints(touches), toPoints(changedTouches)))
		if (generation === sequenceGeneration && isMoved) {
			sendCancelTap(nativeEvent, point)
		}
	}

	function endSequence(nativeEvent, touches, changedTouches, point, endPoint = null) {
		clearLongPressTimer()
		// glass-easel 在 touchend 处重新比一次起点与终点：中途的 touchmove 可能一条都没到
		// （被 preventDefault 吞掉、或系统把移动合并进抬手），只看 isMoved 会把远处抬手当成 tap。
		if (!isMoved && endPoint && exceedsMoveThreshold(endPoint)) {
			isMoved = true
		}
		const shouldTap = !isMoved && !isTapSuppressed && !sequenceState?.tapSuppressed
		const touchEndPayload = sequencePayload(nativeEvent, toPoints(touches), toPoints(changedTouches))
		const tapPayload = sequencePayload(nativeEvent, startTouches, startChangedTouches, point)
		// 位移路径已经在 moveSequence 里发过 canceltap，一个序列至多一条。
		const shouldSendCancelTap = isMoved && !hasCancelTap
		hasCancelTap = hasCancelTap || shouldSendCancelTap
		sequenceState = null
		sequenceTarget = null
		emit('touchend', nativeEvent, touchEndPayload)
		if (shouldSendCancelTap) {
			emit('canceltap', nativeEvent, tapPayload)
		}
		// 每个 owner 都登记任务，让路径上最后一个 owner 能统一收口；被抑制的 owner 登记空任务。
		enqueueAfterTouchEnd(nativeEvent, () => {
			if (shouldTap) emit('tap', nativeEvent, tapPayload)
		})
	}

	function cancelSequence(nativeEvent, touches, changedTouches, point) {
		clearLongPressTimer()
		const cancelPayload = sequencePayload(nativeEvent, toPoints(touches), toPoints(changedTouches))
		const cancelTapPayload = sequencePayload(nativeEvent, startTouches, startChangedTouches, point)
		const shouldSendCancelTap = !hasCancelTap
		// Commit the old sequence before dispatch. touchcancel handlers may synchronously
		// start a new sequence, which owns the mutable fields from that point onward.
		hasCancelTap = true
		sequenceState = null
		sequenceTarget = null
		emit('touchcancel', nativeEvent, cancelPayload)
		if (shouldSendCancelTap) {
			emit('canceltap', nativeEvent, cancelTapPayload)
		}
	}

	function emitTouchPhase(type, event) {
		const point = firstPoint(event.changedTouches, event.touches)
		const payload = sequencePayload(event, toPoints(event.touches), toPoints(event.changedTouches), point)
		if (activeTouchIdentifier === null) payload.target = event.target
		emit(type, event, payload)
	}

	function releaseOwnTouches(event) {
		for (const identifier of eventIdentifiers(event, activeTouchIdentifier ?? ORIGIN_POINT.identifier)) {
			ownTouches.delete(identifier)
		}
	}

	function releaseTouchInputIfEmpty() {
		if (ownTouches.size) return
		activeInputType = null
		hasPreviousTouchPoint = false
	}

	function onTouchStart(event) {
		if (activeInputType === 'pointer') {
			return
		}
		const touch = firstPoint(event.changedTouches, event.touches)
		for (const identifier of eventIdentifiers(event, touch.identifier)) {
			ownTouches.add(identifier)
		}
		if (activeInputType === null) {
			activeInputType = 'touch'
			// Empty synthetic events represent one automation touch. A real event that
			// already contains multiple contacts cannot begin a single-touch gesture.
			if (ownTouches.size <= 1) {
				activeTouchIdentifier = touch.identifier
				startSequence(event, event.touches, event.changedTouches, touch)
			}
			else {
				activeTouchIdentifier = null
				previousClientX = touch.clientX
				previousClientY = touch.clientY
				hasPreviousTouchPoint = true
				emitTouchPhase('touchstart', event)
			}
			return
		}

		// tap/longpress 是单指手势。额外触点不能重置主触点的起点，也不能开启第二个计时器。
		// 但按官方 glass-easel，possibleTaps 是按 identifier 独立记的：后落下的手指既不会
		// 删掉先落手指的记录，也不会替它发 canceltap——第一根手指原地抬起时仍然是一次 tap。
		// longpress 不在 glass-easel 这一层，沿用既有判断：多指下不触发长按。
		const generation = sequenceGeneration
		emitTouchPhase('touchstart', event)
		if (generation !== sequenceGeneration) return
		if (activeTouchIdentifier !== null
			&& (ownTouches.size > 1 || touch.identifier !== activeTouchIdentifier)) {
			clearLongPressTimer()
		}
	}

	function onTouchMove(event) {
		if (activeInputType === 'pointer') {
			return
		}
		const touch = pointWithIdentifier(activeTouchIdentifier, event.touches, event.changedTouches)
			|| firstPoint(event.touches, event.changedTouches)
		const scrollDisabled = typeof disableScroll === 'function' ? disableScroll() : disableScroll
		const shouldBlockScroll = scrollDisabled || (hasCatchEvent(info, 'touchmove')
			&& (!hasPreviousTouchPoint
				|| shouldBlockNativeScroll(event, touch, element, previousClientX, previousClientY)))

		// A listener installed in the middle of an existing native sequence may see
		// move/end without start. Forward the raw touch phase, but never synthesize a gesture.
		if (activeInputType !== 'touch' || activeTouchIdentifier === null) {
			previousClientX = touch.clientX
			previousClientY = touch.clientY
			hasPreviousTouchPoint = true
			emitTouchPhase('touchmove', event)
		}
		else {
			// 滚动是否被阻止不能冻结位移、长按和 canceltap 状态。
			moveSequence(event, event.touches, event.changedTouches, touch)
		}
		if (shouldBlockScroll && event.cancelable) {
			event.preventDefault()
		}
	}

	function onTouchEnd(event) {
		if (activeInputType === 'pointer') {
			return
		}
		const activePoint = pointWithIdentifier(activeTouchIdentifier, event.changedTouches)
		const emptySyntheticEnd = activeTouchIdentifier !== null && !event.changedTouches?.length && !event.touches?.length
		releaseOwnTouches(event)
		if (activeTouchIdentifier === null || (!activePoint && !emptySyntheticEnd)) {
			releaseTouchInputIfEmpty()
			emitTouchPhase('touchend', event)
			enqueueAfterTouchEnd(event, () => {})
		}
		else {
			activeTouchIdentifier = null
			releaseTouchInputIfEmpty()
			endSequence(event, event.touches, event.changedTouches, activePoint || ORIGIN_POINT, activePoint)
		}
		finishPendingDetach(event)
	}

	function onTouchCancel(event) {
		if (activeInputType === 'pointer') {
			return
		}
		const activePoint = pointWithIdentifier(activeTouchIdentifier, event.changedTouches)
		const emptySyntheticCancel = activeTouchIdentifier !== null && !event.changedTouches?.length && !event.touches?.length
		releaseOwnTouches(event)
		if (activeTouchIdentifier === null || (!activePoint && !emptySyntheticCancel)) {
			releaseTouchInputIfEmpty()
			emitTouchPhase('touchcancel', event)
		}
		else {
			activeTouchIdentifier = null
			releaseTouchInputIfEmpty()
			sequenceGeneration += 1
			cancelSequence(event, event.touches, event.changedTouches, activePoint || ORIGIN_POINT)
		}
		finishPendingDetach(event)
	}

	function detachPointerTracking() {
		activePointerId = null
		activePointerTouch = null
		if (activeInputType === 'pointer') activeInputType = null
		document.removeEventListener('pointermove', onPointerMove)
		document.removeEventListener('pointerup', onPointerUp)
		document.removeEventListener('pointercancel', onPointerCancel)
		window.removeEventListener('blur', onPointerWindowBlur)
	}

	function onPointerDown(event) {
		// 右键、中键、浏览器同时派发的 touch pointer，以及活跃序列的竞争输入都不接管 owner。
		if (event.pointerType === 'touch' || (event.button ?? 0) !== 0 || activeInputType !== null) {
			return
		}
		activeInputType = 'pointer'
		activePointerId = event.pointerId
		const touch = pointerToTouch(event)
		activePointerTouch = touch
		// 指针可能移出元素后才抬起，移动与抬起挂在 document 上才能收全序列。
		// 窗口失焦可能没有 pointerup/pointercancel，必须显式终止 owner。
		document.addEventListener('pointermove', onPointerMove)
		document.addEventListener('pointerup', onPointerUp)
		document.addEventListener('pointercancel', onPointerCancel)
		window.addEventListener('blur', onPointerWindowBlur)
		startSequence(event, [touch], [touch], touch)
	}

	function onPointerMove(event) {
		if (activePointerId === null || event.pointerId !== activePointerId) {
			return
		}
		const touch = pointerToTouch(event)
		activePointerTouch = touch
		moveSequence(event, [touch], [touch], touch)
	}

	function onPointerWindowBlur(event) {
		if (activePointerId === null) return
		const touch = activePointerTouch || ORIGIN_POINT
		detachPointerTracking()
		sequenceGeneration += 1
		cancelSequence(event, [], [touch], touch)
		finishPendingDetach(event)
	}

	function onPointerUp(event) {
		if (activePointerId === null || event.pointerId !== activePointerId) {
			return
		}
		const touch = pointerToTouch(event)
		detachPointerTracking()
		endSequence(event, [], [touch], touch, touch)
		finishPendingDetach(event)
	}

	function onPointerCancel(event) {
		if (activePointerId === null || event.pointerId !== activePointerId) {
			return
		}
		const touch = pointerToTouch(event)
		detachPointerTracking()
		sequenceGeneration += 1
		cancelSequence(event, [], [touch], touch)
		finishPendingDetach(event)
	}

	// click 只作为兜底，覆盖程序化 el.click() 与键盘、无障碍触发。
	// 真实指针序列补发的 click 带非零 detail（点击计数），tap 已经由触摸序列合成过，
	// 这类 click 一律放过；detail 为 0 的 click 不来自指针序列，是一次独立交互。
	function onClick(event) {
		if (event.detail > 0) {
			return
		}
		const touch = pointerToTouch(event)
		const points = toPoints([touch])
		emit('tap', event, {
			target: event.target,
			touches: points,
			changedTouches: points,
			pageX: event.pageX,
			pageY: event.pageY,
		})
	}

	// 控件被 label 激活时补发的 tap 沿 DOM 冒泡到这里，路径上每个 owner 都派发一次，
	// 与真实触摸序列合成的 tap 一样受 catch 阻断约束。
	function onActivationTap(event) {
		const { sourceEvent } = event.detail || {}
		emit('tap', event, {
			target: event.target,
			touches: toPoints(sourceEvent?.touches),
			changedTouches: toPoints(sourceEvent?.changedTouches),
			clientX: sourceEvent?.clientX,
			clientY: sourceEvent?.clientY,
			pageX: sourceEvent?.pageX,
			pageY: sourceEvent?.pageY,
		})
	}

	// 检查是否有catch事件处理器
	// 支持写法：catchtouchmove、catch:touchmove
	const hasCatchTouchMove = hasCatchEvent(info, 'touchmove')
	const hasDisabledScroll = typeof disableScroll === 'function' ? disableScroll() : disableScroll
	const hasCatchTouchEnd = hasCatchEvent(info, 'touchend')
	const hasCatchTouchCancel = hasCatchEvent(info, 'touchcancel')

	// catch 只阻止事件冒泡，不阻止默认行为：在 touchstart 上 preventDefault 会连带取消
	// 浏览器的兼容鼠标事件，子树里的原生 input 将再也无法靠触摸聚焦。
	element.addEventListener('touchstart', onTouchStart, { passive: true })
	element.addEventListener('touchmove', onTouchMove, { passive: !hasCatchTouchMove && !hasDisabledScroll })
	element.addEventListener('touchend', onTouchEnd, { passive: !hasCatchTouchEnd })
	element.addEventListener('touchcancel', onTouchCancel, { passive: !hasCatchTouchCancel })
	element.addEventListener('pointerdown', onPointerDown)
	element.addEventListener('click', onClick)
	element.addEventListener(ACTIVATION_TAP_EVENT, onActivationTap)

	function finalizeDetach() {
		if (!attached) return
		attached = false
		detachRequested = false
		sequenceGeneration += 1
		clearLongPressTimer()
		activeTouchIdentifier = null
		activeInputType = null
		ownTouches.clear()
		detachPointerTracking()
		if (element.__ddGestureDetach === detach) {
			delete element.__ddGestureDetach
		}
		element.removeEventListener('touchstart', onTouchStart, { passive: true })
		element.removeEventListener('touchmove', onTouchMove, { passive: !hasCatchTouchMove && !hasDisabledScroll })
		element.removeEventListener('touchend', onTouchEnd, { passive: !hasCatchTouchEnd })
		element.removeEventListener('touchcancel', onTouchCancel, { passive: !hasCatchTouchCancel })
		element.removeEventListener('pointerdown', onPointerDown)
		element.removeEventListener('click', onClick)
		element.removeEventListener(ACTIVATION_TAP_EVENT, onActivationTap)
		// 放在最后：回调常常是"装上新 owner"，要等 __ddGestureDetach 让出来、监听器全摘掉之后再跑。
		while (detachedCallbacks.length) {
			detachedCallbacks.shift()()
		}
	}

	// 终态 tap 是 endSequence 排进 touchend 微任务里派发的，收掉 owner 必须排在它后面：
	// finalizeDetach 会把 attached 置否并推进 generation，早一步收掉正好吃掉这一次的 tap。
	function finishPendingDetach(nativeEvent) {
		if (!detachRequested || activeInputType !== null) return
		if (!nativeEvent) {
			finalizeDetach()
			return
		}
		enqueueAfterTouchEnd(nativeEvent, () => {
			if (detachRequested && activeInputType === null) finalizeDetach()
		})
	}

	/**
	 * @param {object} [options]
	 * @param {boolean} [options.preserveActive] 序列进行中时推迟到真实终态再摘除，不伪造 touchend / touchcancel
	 * @param {boolean} [options.nodeRemoved] 节点已经离开树；此后只转达真实事件，不再靠自己的计时器合成手势
	 * @param {Function} [options.onDetached] 真正摘除后的回调，调用方用它把"换 owner"排在收口之后
	 */
	function detach({ preserveActive = false, nodeRemoved = false, onDetached = null } = {}) {
		if (!attached) {
			onDetached?.()
			return
		}
		if (preserveActive && activeInputType !== null) {
			detachRequested = true
			// 节点还在树上（bind/catch 换 owner）时长按照常触发；节点已经卸载时必须停表：
			// 长按由所有者自己的计时器合成，不停表就是给一个不存在的节点补造 longpress / longtap。
			if (nodeRemoved) clearLongPressTimer()
			if (onDetached) detachedCallbacks.push(onDetached)
			return
		}
		finalizeDetach()
		onDetached?.()
	}

	element.__ddGestureDetach = detach
	return detach
}
