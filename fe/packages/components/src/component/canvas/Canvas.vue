<script>
// 画布
// https://developers.weixin.qq.com/miniprogram/dev/component/canvas.html

// canvas-id 判重按“页面 + 宿主组件实例 + canvas-id”登记，与渲染层 getCanvasElement 的 moduleId
// 作用域一致：两个相同自定义组件的实例各自持有同名 canvas-id 是合法的。整页 DOM 查询做不到这件事，
// 而且它会把先挂载的那个也一起算成重复，两边同时被隐藏。
const claimedCanvasIds = new Set()
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

// 出错的实例从不登记，所以这里也只在登记成功时才归还；否则后来者会把先到者的 key 删掉。
let claimedKey = null

onMounted(() => {
	if (props.type) return
	const key = `${info.bridgeId}|${info.moduleId}|${props.canvasId}`
	let errMsg
	if (!props.canvasId) {
		errMsg = 'canvas-id attribute is undefined'
	}
	else if (claimedCanvasIds.has(key)) {
		errMsg = `canvas-id ${props.canvasId} in this page has already existed`
	}
	if (errMsg) {
		isError.value = true
		triggerEvent('error', { info, detail: { errMsg } })
		return
	}
	claimedKey = key
	claimedCanvasIds.add(key)
})

onUnmounted(() => {
	if (claimedKey === null) return
	claimedCanvasIds.delete(claimedKey)
	claimedKey = null
})
</script>

<template>
	<div ref="rootRef" v-bind="$attrs" class="dd-canvas" :style="isError ? { display: 'none' } : undefined" @touchmove="preventScroll">
		<canvas
			ref="canvasRef" :canvas-id="canvasId" :data-type="type || undefined"
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
