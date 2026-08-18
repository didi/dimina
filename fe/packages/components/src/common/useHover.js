/**
 * Implements the hover-class behavior shared by view-like components.
 *
 * exparser marks the original touch event instead of stopping DOM propagation,
 * so hover-stop-propagation only suppresses ancestor hover states and does not
 * swallow tap/touch handlers.
 */
export function useHover(props) {
	const isHover = ref(false)
	let isPressed = false
	let startTimer
	let stayTimer

	function clearStartTimer() {
		if (startTimer !== undefined) {
			clearTimeout(startTimer)
			startTimer = undefined
		}
	}

	function clearStayTimer() {
		if (stayTimer !== undefined) {
			clearTimeout(stayTimer)
			stayTimer = undefined
		}
	}

	function resetHover() {
		clearStartTimer()
		clearStayTimer()
		isHover.value = false
	}

	function start(event) {
		if (event._ddHoverPropagationStopped) {
			return
		}
		if (props.hoverStopPropagation) {
			event._ddHoverPropagationStopped = true
		}

		isPressed = true
		clearStartTimer()
		clearStayTimer()
		if (props.disabled || props.hoverClass === 'none') {
			return
		}
		if (event.touches?.length > 1) {
			return
		}

		startTimer = setTimeout(() => {
			startTimer = undefined
			isHover.value = true
			if (!isPressed) {
				stayTimer = setTimeout(resetHover, Number(props.hoverStayTime) || 0)
			}
		}, Math.max(Number(props.hoverStartTime) || 0, 0))
	}

	function end() {
		isPressed = false
		if (isHover.value) {
			clearStayTimer()
			stayTimer = setTimeout(resetHover, Math.max(Number(props.hoverStayTime) || 0, 0))
		}
	}

	function cancel() {
		isPressed = false
		resetHover()
	}

	onBeforeUnmount(resetHover)

	return {
		isHover,
		onHoverCancel: cancel,
		onHoverEnd: end,
		onHoverStart: start,
	}
}
