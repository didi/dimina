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

// 触摸点额外携带相对画布左上角的 x / y；传播和 currentTarget 与普通节点一致。
useTouchEvents(info, rootRef, { relativeTo: canvasRef })

function preventScroll(event) {
	if (props.disableScroll && event.cancelable) {
		event.preventDefault()
	}
}

// 表里存的是 owner 而不只是 key：归还时要确认这一项确实是自己占的，否则后来者会把先到者删掉。
const owner = {}
let claimedKey = null

function canvasKey() {
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
	const key = canvasKey()
	if (!key || claimedCanvasIds.has(key)) return
	pendingClaims.delete(retryClaim)
	claimedKey = key
	claimedCanvasIds.set(key, owner)
	isError.value = false
}

// canvas-id 是可以改的，模板上的 canvas-id 会跟着改，登记表也必须跟着改：不然旧 id 一直被自己占着，
// 新 id 谁都没占。先归还再登记，中间不留窗口。
function claimCanvasId() {
	releaseCanvasId()
	const key = canvasKey()
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

onMounted(() => {
	if (props.type) return
	claimCanvasId()
})

watch(() => props.canvasId, () => {
	if (props.type) return
	claimCanvasId()
})

onUnmounted(releaseCanvasId)
</script>

<template>
	<div ref="rootRef" v-bind="$attrs" class="dd-canvas" :style="isError ? { display: 'none' } : undefined" @touchmove="preventScroll">
		<canvas
			ref="canvasRef" :canvas-id="canvasId" :data-type="type || undefined"
			:data-canvas-owner="info.moduleId"
			:width="renderWidth" :height="renderHeight"
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
