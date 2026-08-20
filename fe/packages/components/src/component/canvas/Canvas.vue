<script>
// 画布
// https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html

// canvas-id 判重按“页面 + 宿主组件实例 + canvas-id”登记，与渲染层 getCanvasElement 的 moduleId
// 作用域一致：两个相同自定义组件的实例各自持有同名 canvas-id 是合法的。整页 DOM 查询做不到这件事，
// 而且它会把先挂载的那个也一起算成重复，两边同时被隐藏。
const claimedCanvasIds = new Map()

// 同一次更新里「一方让出、另一方接手」是常见写法（wx:if 掉一个 canvas，同时把另一个的 canvas-id
// 改成它让出的那个）。canvas-id 的 watch 是 pre-flush、onUnmounted 是 post-flush，接手方一定先跑，
// 看到的还是没让出的旧表。被挡下的实例登记在这里，谁让出 key 就地重试一次，否则它会永久停在
// error 态——而且结论会随两个实例的书写顺序反转。
const pendingClaims = new Set()
</script>

<script setup>
import {
	CANVAS_ACTIVE_PROP,
	CANVAS_CONTRACT_CHANGE_EVENT,
	CANVAS_NODE_PROP,
	CANVAS_OWNER_PROP,
	canvasPixelBudgetError,
	normalizeCanvasBitmapDimension,
} from '@dimina/common'
import { triggerEvent, useInfo } from '@/common/events'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	canvasId: {
		type: String,
		default: '',
	},
	disableScroll: {
		type: Boolean,
		default: false,
	},
	type: {
		type: String,
		default: '',
	},
	newTouchListener: {
		type: Boolean,
		default: false,
	},
	renderWidth: {
		type: Number,
		default: 300,
	},
	renderHeight: {
		type: Number,
		default: 150,
	},
})

const info = useInfo()
const canvasRef = ref(null)
const rootRef = ref(null)
const isError = ref(false)
let contractCanvas = null
let contractRoot = null
const defaultRenderSize = Object.freeze({ width: 300, height: 150 })
const safeRenderSize = computed(() => {
	try {
		const width = normalizeCanvasBitmapDimension(props.renderWidth, defaultRenderSize.width)
		const height = normalizeCanvasBitmapDimension(props.renderHeight, defaultRenderSize.height)
		return canvasPixelBudgetError(width, height, { allowZero: true })
			? defaultRenderSize
			: { width, height }
	}
	catch {
		return defaultRenderSize
	}
})

// 触摸点额外携带相对画布左上角的 x / y；传播和 currentTarget 与普通节点一致。
// 画布本身是组件搭出来的内部节点，小程序声明的 id 与 data-* 都在根节点上，所以事件源归到根节点；
// 覆盖层里的节点是开发者自己写的组件，保持它们自己的事件源。
// 相对坐标以根节点为基准：小程序写的 canvas 是根节点这一个节点，border 按 CSS 属于它，内层 canvas 绝对定位在 border 内侧。
// 拿内层算会让带 border 的画布上每个触摸点都偏移一个 border 宽度，而开发者说的「画布左上角」就是他写的那个节点的左上角。
useTouchEvents(info, rootRef, {
	relativeTo: rootRef,
	resolveTarget: target => (target === canvasRef.value ? rootRef.value : target),
})

function preventScroll(event) {
	if (props.disableScroll && event.cancelable) {
		event.preventDefault()
	}
}

// 表里存的是 owner 而不只是 key：归还时要确认这一项确实是自己占的，否则后来者会把先到者删掉。
const owner = {}
let claimedKey = null

function syncCanvasContract() {
	const active = desiredKey() !== null && !isError.value
	if (!contractCanvas) return
	const previousActive = contractCanvas[CANVAS_ACTIVE_PROP]
	const previousOwner = contractCanvas[CANVAS_OWNER_PROP]
	Object.defineProperty(contractCanvas, CANVAS_ACTIVE_PROP, {
		configurable: true,
		value: active,
	})
	if (!active) {
		if (contractCanvas[CANVAS_OWNER_PROP] === info.moduleId) {
			delete contractCanvas[CANVAS_OWNER_PROP]
		}
		return
	}
	Object.defineProperty(contractCanvas, CANVAS_OWNER_PROP, {
		configurable: true,
		value: info.moduleId,
	})
	if (previousActive !== contractCanvas[CANVAS_ACTIVE_PROP]
		|| previousOwner !== contractCanvas[CANVAS_OWNER_PROP]) {
		const EventConstructor = contractCanvas.ownerDocument?.defaultView?.Event
		if (EventConstructor) {
			contractCanvas.dispatchEvent(new EventConstructor(CANVAS_CONTRACT_CHANGE_EVENT, { bubbles: true }))
		}
	}
}

// 该占哪个 key 是一个由当前属性算出来的值，不是若干次属性变化累积出来的状态：指定 type 的画布
// 用 id 定位、不参与 canvas-id 判重，所以 type 和 canvas-id 一起决定结果。逐个属性挂监听时，
// 每漏一个属性就多一条不会重算的路径，而算式漏不掉自己读到的东西。
// null 表示不参与判重，'' 表示参与判重但没给 canvas-id。
function desiredKey() {
	if (props.type) {
		return null
	}
	return props.canvasId ? `${info.bridgeId}|${info.moduleId}|${props.canvasId}` : ''
}

function releaseCanvasId() {
	pendingClaims.delete(retryClaim)
	if (claimedKey === null) return
	const key = claimedKey
	claimedKey = null
	if (claimedCanvasIds.get(key) === owner) claimedCanvasIds.delete(key)
	// 让出之后同一 tick 内被这个 key 挡下的实例就能接手了。重试只会成功或维持原状，不会级联。
	for (const pending of [...pendingClaims]) pending()
}

// 重试不报错也不撤销别人的登记：拿到就转正，拿不到就继续等。
function retryClaim() {
	const key = desiredKey()
	if (!key || claimedCanvasIds.has(key)) return
	pendingClaims.delete(retryClaim)
	claimedKey = key
	claimedCanvasIds.set(key, owner)
	isError.value = false
}

// 属性变了就把登记改到当前该占的那个 key 上：不然旧 id 一直被自己占着，新 id 谁都没占。
// 先归还再登记，中间不留窗口。
function syncClaim() {
	const key = desiredKey()
	// 已经占着该占的那个 key 时不能重新登记：归还会放走排在后面等这个 key 的实例。
	if (key && claimedKey === key) {
		return
	}
	releaseCanvasId()
	// 不参与判重的画布既不占 key，也不该停在上一次的错误态上。
	if (key === null) {
		isError.value = false
		return
	}
	if (!key) {
		isError.value = true
		triggerEvent('error', { info, detail: { errMsg: 'canvas-id attribute is undefined' } })
		return
	}
	if (!claimedCanvasIds.has(key)) {
		claimedKey = key
		claimedCanvasIds.set(key, owner)
		isError.value = false
		return
	}
	isError.value = true
	pendingClaims.add(retryClaim)
	// 冲突结论要等本次 flush 把所有让出都结算完再报：同一 tick 里的接手方在这一刻看到的表是旧的，
	// 立即报错会给出一条随后就被撤销的假 error。
	queueMicrotask(() => {
		if (claimedKey !== null) return
		triggerEvent('error', { info, detail: { errMsg: `canvas-id ${props.canvasId} in this page has already existed` } })
	})
}

// 依赖由 desiredKey() 自己读到的属性决定，新增属性参与判重时不需要再补一条监听。
watchEffect(syncClaim)
watchEffect(syncCanvasContract)

// 根节点承载小程序声明的 id、dataset 和布局，内部 canvas 承载真正的 Canvas API。两者通过
// 共享 DOM contract 关联，SelectorQuery 不需要猜组件子树，也不会误取 slot 里的 canvas。
onMounted(() => {
	contractCanvas = canvasRef.value
	contractRoot = rootRef.value
	syncCanvasContract()
	Object.defineProperty(contractRoot, CANVAS_NODE_PROP, {
		configurable: true,
		value: contractCanvas,
	})
})

onUnmounted(() => {
	releaseCanvasId()
	if (contractRoot?.[CANVAS_NODE_PROP] === contractCanvas) {
		delete contractRoot[CANVAS_NODE_PROP]
	}
	if (contractCanvas?.[CANVAS_OWNER_PROP] === info.moduleId) {
		delete contractCanvas[CANVAS_OWNER_PROP]
	}
	if (contractCanvas && CANVAS_ACTIVE_PROP in contractCanvas) {
		delete contractCanvas[CANVAS_ACTIVE_PROP]
	}
})
</script>

<template>
	<div ref="rootRef" v-bind="$attrs" class="dd-canvas" :style="isError ? { display: 'none' } : undefined" @touchmove="preventScroll">
		<canvas
			ref="canvasRef" :canvas-id="canvasId" :type="type || undefined"
			:width="safeRenderSize.width" :height="safeRenderSize.height"
		/>
		<div class="dd-canvas-slot">
			<slot />
		</div>
	</div>
</template>

<style lang="scss">
.dd-canvas {
	display: block;
	position: relative;
	width: 300px;
	height: 150px;

	> canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	&[hidden] {
		display: none;
	}
}

.dd-canvas-slot {
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	overflow: hidden;
	pointer-events: none;

	* {
		pointer-events: auto;
	}
}
</style>
