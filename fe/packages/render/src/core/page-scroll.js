const REFRESH_HEIGHT = 64
const GESTURE_SLOP = 8
// CSSOM rounds scrollHeight/innerHeight to integers, but scrollY can be fractional.
const SCROLL_ROUNDING_TOLERANCE = 1

function ownsScroll(target) {
	for (let node = target; node && node !== document.body; node = node.parentElement) {
		if (node.nodeType !== 1) continue
		if (node.matches('input, textarea, select, [contenteditable="true"]')) return true
		if (/(auto|scroll)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return true
	}
	return false
}

/** One document/page owns its gesture, refresh state and bottom-entry latch. */
export function createPageScrollController({ config = {}, onScroll, onReachBottom, onPullDownRefresh }) {
	let disposed = false, frame = null, atBottom = false, refreshing = false
	let gesture = null, distance = 0, indicator, spinner, animation
	const configuredDistance = config.onReachBottomDistance
	const bottomDistance = typeof configuredDistance === 'number' && Number.isFinite(configuredDistance)
		? Math.max(0, configuredDistance) : 50
	const scrollTop = () => Math.max(0, window.scrollY || 0)
	const show = (height) => {
		if (!indicator) {
			indicator = document.createElement('div')
			indicator.setAttribute('data-dimina-pull-down-refresh', '')
			indicator.setAttribute('aria-hidden', 'true')
			Object.assign(indicator.style, {
				position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483646',
				pointerEvents: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
				backgroundColor: config.backgroundColor || '#fff', color: config.backgroundTextStyle === 'light' ? '#fff' : '#666',
			})
			spinner = document.createElement('div')
			Object.assign(spinner.style, { width: '20px', height: '20px', boxSizing: 'border-box', border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' })
			indicator.append(spinner)
			document.body.append(indicator)
		}
		indicator.style.height = `${height}px`
		indicator.style.display = height > 0 ? 'flex' : 'none'
		indicator.dataset.state = refreshing ? 'refreshing' : 'pulling'
		spinner.style.transform = `rotate(${distance * 3}deg)`
	}
	const resetGesture = () => {
		gesture = null
		distance = 0
		if (!refreshing && indicator) show(0)
	}
	const start = () => {
		if (disposed || refreshing) return
		refreshing = true
		gesture = null
		show(REFRESH_HEIGHT)
		if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
			animation = spinner.animate?.([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 800, iterations: Infinity })
		}
		onPullDownRefresh()
	}
	const stop = () => {
		refreshing = false
		animation?.cancel()
		animation = null
		resetGesture()
	}
	const handleScroll = () => {
		if (frame !== null) return
		frame = window.requestAnimationFrame(() => {
			frame = null
			if (disposed) return
			const top = scrollTop()
			onScroll(top)
			const scroller = document.scrollingElement || document.documentElement
			const height = scroller.scrollHeight
			const viewportHeight = scroller.clientHeight || window.innerHeight
			const bottom = top > 0 && height > viewportHeight
				&& height - top - viewportHeight <= bottomDistance + SCROLL_ROUNDING_TOLERANCE
			const entered = bottom && !atBottom
			atBottom = bottom
			if (entered) onReachBottom()
		})
	}
	const handleStart = (event) => {
		resetGesture()
		if (refreshing || event.touches.length !== 1 || scrollTop() > 0 || ownsScroll(event.target)) return
		const touch = event.touches[0]
		gesture = { x: touch.clientX, y: touch.clientY, captured: false }
	}
	const handleMove = (event) => {
		if (!gesture) return
		if (event.touches.length !== 1 || scrollTop() > 0) { resetGesture(); return }
		const touch = event.touches[0], dy = touch.clientY - gesture.y, dx = Math.abs(touch.clientX - gesture.x)
		if (!gesture.captured) {
			if (Math.max(dx, Math.abs(dy)) < GESTURE_SLOP) return
			if (dy <= dx) { resetGesture(); return }
			gesture.captured = true
		}
		if (event.cancelable) event.preventDefault()
		distance = Math.min(REFRESH_HEIGHT * 1.5, Math.max(0, dy / 2))
		show(distance)
	}
	const handleEnd = (event) => {
		const shouldRefresh = gesture?.captured && distance >= REFRESH_HEIGHT && event.touches.length === 0
		resetGesture()
		if (shouldRefresh) start()
	}

	window.addEventListener('scroll', handleScroll, { passive: true })
	if (config.enablePullDownRefresh === true) {
		document.addEventListener('touchstart', handleStart, { passive: true })
		document.addEventListener('touchmove', handleMove, { passive: false })
		document.addEventListener('touchend', handleEnd)
		document.addEventListener('touchcancel', resetGesture)
	}
	return {
		start, stop,
		dispose() {
			disposed = true
			stop()
			if (frame !== null) window.cancelAnimationFrame(frame)
			window.removeEventListener('scroll', handleScroll)
			document.removeEventListener('touchstart', handleStart)
			document.removeEventListener('touchmove', handleMove)
			document.removeEventListener('touchend', handleEnd)
			document.removeEventListener('touchcancel', resetGesture)
			indicator?.remove()
		},
	}
}
