import { callback } from '@dimina/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import hostEnv from '../src/core/host-env'
import runtime from '../src/core/runtime'
import { takeAllWindowResizeListenerIds } from '../src/core/window-resize-listeners'
import { PageModule } from '../src/instance/page/page-module'

/**
 * 判据集中在 service 层，宿主（iOS / Android / HarmonyOS / 模拟器）只上报原始事实，不各自实现抑制逻辑。
 * 这些用例守护 resize 派发的完整判据：
 *
 * 窗口通道（wx.onWindowResize）和页面通道（Page.onResize）互相独立——窗口通道只在这次上报的几何相对应用级基线发生了变化时触发，页面通道默认触发，与几何是否变化无关；页面配置的方向不是 auto 时两条通道一起被抑制。
 * 几何基线由整个应用共享，不按 bridgeId 分别维护，即使在被抑制的那次上报里也会照常推进。
 *
 * 同一 16ms 窗口内到达的多次上报合并成一次结算：窗口通道按"窗口内是否有任意一次上报想触发"做或运算，结算时使用窗口内最后一次上报的几何。
 * 页面通道还要求上报时的可见 generation 在结算时仍有效，隐藏或重新显示后的旧报告不会派发。
 * 宿主没有上报 pageOrientation 时，说明它已经在本地判完并且自己会触发窗口监听，这里只透传页面通道，不再二次判据，也不重复触发窗口监听。
 */
describe('page resize dispatch gate', () => {
	const PORTRAIT = { windowWidth: 375, windowHeight: 812 }
	const LANDSCAPE = { windowWidth: 812, windowHeight: 375 }

	function mountPage(bridgeId) {
		const received = []
		runtime.instances[bridgeId] = {
			page: {
				__id__: 'page',
				__type__: PageModule.type,
				initd: true,
				pageHide: () => {},
				pageResize: res => received.push(res),
				pageShow: () => {},
				pageUnload: () => {},
			},
		}
		Object.assign(runtime.getPageState(bridgeId), {
			hidden: false,
			shown: true,
			visibilityGeneration: 1,
		})
		return received
	}

	async function registerWindowListener() {
		globalThis.DiminaServiceBridge = { invoke: vi.fn(), publish: vi.fn(), onMessage: null }
		const { onWindowResize } = await import('../src/api/core/ui/window/index.js')
		const listener = vi.fn()
		onWindowResize(listener)
		return listener
	}

	beforeEach(() => {
		vi.useFakeTimers()
		runtime.instances = {}
		runtime.pageStates.clear()
		clearTimeout(runtime.resizeGate.timer)
		runtime.resizeGate.baseline = { windowWidth: 0, windowHeight: 0, deviceOrientation: '' }
		runtime.resizeGate.timer = null
		runtime.resizeGate.fireWindow = false
		runtime.resizeGate.pendingPageOwners = []
		runtime.resizeGate.lastEvent = null
		takeAllWindowResizeListenerIds().forEach(evtId => callback.remove(evtId))
		hostEnv.reset()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('dispatches the page channel even when the geometry repeats, while the window channel only fires on an actual change', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-independent'
		const received = mountPage(bridgeId)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(1)
		expect(listener).toHaveBeenCalledTimes(1)

		runtime.pageResize({ bridgeId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(2)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	/**
	 * 两条通道拿到的是同一个对象，形状恰好是 `{ deviceOrientation, size }`，其中 `size` 是宿主上报的那个对象本身、原样透传。
	 * 所以宿主在 size 里多放的字段（如 screenWidth/screenHeight）会原样到达业务代码——裁不裁在宿主，不在这里。
	 * 官方文档只列了 size.windowWidth/windowHeight，据此裁剪载荷会让业务读不到 deviceOrientation。
	 */
	it('hands both channels one object shaped exactly {deviceOrientation, size}, with the host size passed through', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-payload'
		const received = mountPage(bridgeId)
		const hostSize = { ...LANDSCAPE, screenWidth: 812, screenHeight: 375 }

		runtime.pageResize({
			bridgeId,
			size: hostSize,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(1)
		expect(listener).toHaveBeenCalledTimes(1)
		const pagePayload = received[0]
		const windowPayload = listener.mock.calls[0][0]
		expect(pagePayload).toBe(windowPayload)
		expect(Object.keys(pagePayload).sort()).toEqual(['deviceOrientation', 'size'])
		expect(pagePayload.deviceOrientation).toBe('landscape')
		expect(pagePayload.size).toBe(hostSize)
	})

	it('suppresses both channels for a fixed-orientation page when the change is not unblocked anywhere in the app', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-pinned'
		const received = mountPage(bridgeId)

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'portrait' },
		})
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(0)
		expect(listener).not.toHaveBeenCalled()
	})

	it('advances the app-global baseline even for a change the fixed-orientation rule suppressed', async () => {
		const listener = await registerWindowListener()
		const bridgeIdPinned = 'bridge-baseline-pinned'
		const bridgeIdAuto = 'bridge-baseline-auto'
		const receivedPinned = mountPage(bridgeIdPinned)
		const receivedAuto = mountPage(bridgeIdAuto)

		runtime.pageResize({
			bridgeId: bridgeIdPinned,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'portrait' },
		})
		vi.advanceTimersByTime(16)
		expect(receivedPinned).toHaveLength(0)
		expect(listener).not.toHaveBeenCalled()

		runtime.pageResize({
			bridgeId: bridgeIdAuto,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		vi.advanceTimersByTime(16)

		// 基线已经在被抑制的那次上报里走到了横屏，这次相同几何不构成变化。
		expect(listener).not.toHaveBeenCalled()
		expect(receivedAuto).toHaveLength(1)
	})

	it('shares one geometry baseline across every bridgeId in the app, not a fresh baseline per page', async () => {
		const listener = await registerWindowListener()
		const bridgeIdA = 'bridge-baseline-a'
		const bridgeIdB = 'bridge-baseline-b'
		const receivedA = mountPage(bridgeIdA)
		const receivedB = mountPage(bridgeIdB)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId: bridgeIdA, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(receivedA).toHaveLength(1)

		runtime.pageResize({ bridgeId: bridgeIdB, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)

		// B 上报的几何与 A 留下的应用级基线相同，窗口通道不该把它当成一次新变化。
		expect(listener).toHaveBeenCalledTimes(1)
		expect(receivedB).toHaveLength(1)
	})


	it('merges pageResize calls within 16ms into a single settle, delivering the geometry of the last call to every dispatch', async () => {
		const listener = await registerWindowListener()
		const bridgeIdA = 'bridge-merge-a'
		const bridgeIdB = 'bridge-merge-b'
		const receivedA = mountPage(bridgeIdA)
		const receivedB = mountPage(bridgeIdB)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId: bridgeIdA, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		runtime.pageResize({ bridgeId: bridgeIdB, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })

		expect(receivedA).toHaveLength(0)
		expect(receivedB).toHaveLength(0)
		expect(listener).not.toHaveBeenCalled()

		vi.advanceTimersByTime(16)

		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith({ size: LANDSCAPE, deviceOrientation: 'landscape' })

		// A 只在窗口内的第一次上报里出现过，结算时仍然只拿到一次派发，用的是第二次上报（窗口内最后一次）的几何，而不是它自己上报的竖屏。
		expect(receivedA).toHaveLength(1)
		expect(receivedA[0].size).toEqual(LANDSCAPE)
		expect(receivedA[0].deviceOrientation).toBe('landscape')

		expect(receivedB).toHaveLength(1)
		expect(receivedB[0].size).toEqual(LANDSCAPE)
	})

	it('does not dispatch a single pageResize call synchronously — it settles only after 16ms', () => {
		const bridgeId = 'bridge-solo'
		const received = mountPage(bridgeId)

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		expect(received).toHaveLength(0)

		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(1)
	})

	it('produces two separate settles when calls are separated by a full 16ms window', () => {
		const bridgeId = 'bridge-separate'
		const received = mountPage(bridgeId)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(1)

		runtime.pageResize({ bridgeId, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(2)

		expect(received[0].deviceOrientation).toBe('landscape')
		expect(received[1].deviceOrientation).toBe('portrait')
	})

	it('bypasses all gating when the host has already judged locally, still deferring through the merge window', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-host-judged'
		const received = mountPage(bridgeId)

		runtime.pageResize({ bridgeId, size: LANDSCAPE, deviceOrientation: 'landscape' })
		expect(received).toHaveLength(0)

		vi.advanceTimersByTime(16)
		expect(received).toHaveLength(1)
		// 宿主自己在本地已经触发过窗口监听，这一层不能再触发第二遍。
		expect(listener).not.toHaveBeenCalled()
	})

	it('fires the window channel for the very first event in a fresh app lifetime', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-first-ever'
		mountPage(bridgeId)

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})

		expect(listener).not.toHaveBeenCalled()
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	/**
	 * 模拟器宿主为了让 onShow 同步读到落地页自己的尺寸，会先送几何再送 pageShow （getSystemInfoSync 读的是主进程缓存的 hostEnv 快照）。
	 * 收件人在结算时才定，所以登记时这一页还没 show 不能成为丢弃它的理由——丢了，缓存页返回到一个「它自己没变、窗口也没再动」的几何时就再也收不到 onResize。
	 */
	it('delivers a report that arrived just before the page showed', () => {
		const bridgeId = 'bridge-reported-before-show'
		const received = mountPage(bridgeId)
		Object.assign(runtime.getPageState(bridgeId), { shown: false, hidden: false })

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		runtime.pageShow({ bridgeId })
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(1)
	})

	it('drops a report for a page that never showed within the merge window', () => {
		const bridgeId = 'bridge-never-shown'
		const received = mountPage(bridgeId)
		Object.assign(runtime.getPageState(bridgeId), { shown: false, hidden: false })

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(0)
	})

	/**
	 * 固定方向页两条通道都被抑制，如果这次上报也不刷新缓存的窗口事实，它落地后 `wx.getWindowInfo` 读到的就一直是上一页的几何，且再没有纠正的机会。
	 * 微信把缓存更新挂在与派发无关的 handler 上（只写缓存、不派发），这里对齐。
	 */
	it('refreshes the cached window facts even for a report both channels suppressed', () => {
		const bridgeId = 'bridge-suppressed-facts'
		mountPage(bridgeId)
		hostEnv.init({ systemInfo: { windowWidth: 375, windowHeight: 812, deviceOrientation: 'portrait', brand: 'probe' } })

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'landscape' },
		})

		expect(hostEnv.getSystemInfo()).toMatchObject({
			windowWidth: LANDSCAPE.windowWidth,
			windowHeight: LANDSCAPE.windowHeight,
			deviceOrientation: 'landscape',
			brand: 'probe',
		})
	})

	/**
	 * 基础库不构造 `size`，把宿主给的那个对象原样交给两条通道的回调，所以宿主放进去多少字段就透出多少。
	 * 四端都会带上整块屏幕的尺寸，业务据此能同时拿到屏幕和可用窗口。
	 */
	it('hands both channels the host size object untouched, screen dimensions included', async () => {
		const listener = await registerWindowListener()
		const bridgeId = 'bridge-size-passthrough'
		const received = mountPage(bridgeId)
		const size = { screenWidth: 812, screenHeight: 375, windowWidth: 812, windowHeight: 331 }

		runtime.pageResize({
			bridgeId,
			size,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		vi.advanceTimersByTime(16)

		expect(received[0].size).toBe(size)
		expect(listener.mock.calls[0][0].size).toBe(size)
	})

	/**
	 * 屏幕尺寸和窗口尺寸一起随旋转换宽高。
	 * 不刷新的话 `getSystemInfoSync().screenWidth` 会一直停在旋转前的值，而窗口尺寸已经是新的，业务拿到的是一份自相矛盾的快照。
	 */
	it('refreshes the cached screen dimensions alongside the window ones', () => {
		const bridgeId = 'bridge-screen-facts'
		mountPage(bridgeId)
		hostEnv.init({
			systemInfo: { screenWidth: 375, screenHeight: 812, windowWidth: 375, windowHeight: 748, deviceOrientation: 'portrait' },
		})

		runtime.pageResize({
			bridgeId,
			size: { screenWidth: 812, screenHeight: 375, windowWidth: 812, windowHeight: 331 },
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})

		expect(hostEnv.getSystemInfo()).toMatchObject({
			screenWidth: 812,
			screenHeight: 375,
			windowWidth: 812,
			windowHeight: 331,
		})
	})

	/**
	 * 宿主没带屏幕尺寸时保留快照里原来的值：用 undefined 覆盖掉一个本来正确的值比留着一个可能过时的值更糟，业务读到的会直接是 undefined。
	 */
	it('keeps the cached screen dimensions when the host omits them', () => {
		const bridgeId = 'bridge-screen-absent'
		mountPage(bridgeId)
		hostEnv.init({
			systemInfo: { screenWidth: 375, screenHeight: 812, windowWidth: 375, windowHeight: 748, deviceOrientation: 'portrait' },
		})

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})

		expect(hostEnv.getSystemInfo()).toMatchObject({
			screenWidth: 375,
			screenHeight: 812,
			windowWidth: LANDSCAPE.windowWidth,
			windowHeight: LANDSCAPE.windowHeight,
		})
	})

	it('invalidates a queued resize when its page hides before settlement', () => {
		const bridgeId = 'bridge-hidden-before-settle'
		const received = mountPage(bridgeId)

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		runtime.pageHide({ bridgeId })
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(0)
	})

	it('does not revive an old resize when the page hides and shows again in the same merge window', () => {
		const bridgeId = 'bridge-reshown-before-settle'
		const received = mountPage(bridgeId)

		runtime.pageResize({
			bridgeId,
			size: LANDSCAPE,
			deviceOrientation: 'landscape',
			pageOrientation: { originalPageOrientation: 'auto' },
		})
		runtime.pageHide({ bridgeId })
		runtime.pageShow({ bridgeId })
		vi.advanceTimersByTime(16)

		expect(received).toHaveLength(0)
	})

	it('lets a new report in a new display generation replace the stale queued ownership', () => {
		const bridgeId = 'bridge-new-generation-report'
		const received = mountPage(bridgeId)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		runtime.pageHide({ bridgeId })
		runtime.pageShow({ bridgeId })
		runtime.pageResize({ bridgeId, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		vi.advanceTimersByTime(16)

		expect(received).toEqual([{ size: PORTRAIT, deviceOrientation: 'portrait' }])
	})

	it('silently skips a queued bridgeId that unloaded before the settle fires', () => {
		const bridgeIdA = 'bridge-unload-a'
		const bridgeIdB = 'bridge-unload-b'
		const receivedB = mountPage(bridgeIdB)
		mountPage(bridgeIdA)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId: bridgeIdA, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		runtime.pageResize({ bridgeId: bridgeIdB, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		runtime.pageUnload({ bridgeId: bridgeIdA })

		expect(() => vi.advanceTimersByTime(16)).not.toThrow()
		expect(receivedB).toHaveLength(1)
	})

	// 宿主可能在页面实例注册之前就发来这一页的几何（iOS 的 viewWillTransition 就早于实例创建约 10ms）。
	// 这类上报没有页面可派发，但它承载的几何必须照常推进应用级基线，否则下一次真实的几何变化会被拿来和一个过期基线比较、误判成"没变过"。
	it('advances the app-level baseline for a report whose page instance is not registered yet', async () => {
		const listener = await registerWindowListener()
		const mountedId = 'bridge-entry'
		const unregisteredId = 'bridge-not-yet-created'
		mountPage(mountedId)
		const auto = { originalPageOrientation: 'auto' }

		runtime.pageResize({ bridgeId: unregisteredId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(1)

		runtime.pageResize({ bridgeId: mountedId, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(2)

		runtime.pageResize({ bridgeId: unregisteredId, size: LANDSCAPE, deviceOrientation: 'landscape', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(3)

		runtime.pageResize({ bridgeId: mountedId, size: PORTRAIT, deviceOrientation: 'portrait', pageOrientation: auto })
		vi.advanceTimersByTime(16)
		expect(listener).toHaveBeenCalledTimes(4)
	})
})
