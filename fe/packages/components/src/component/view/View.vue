<script setup>
// 视图容器
// https://developers.weixin.qq.com/miniprogram/dev/component/view.html
import { useInfo } from '@/common/events'
import { useNativeEvents } from '@/common/useNativeEvents'
import { useHover } from '@/common/useHover'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	inline: {
		type: Boolean,
		default: false,
	},
	hover: {
		type: Boolean,
		default: false,
	},
	sessionFrom: {
		type: String,
		default: 'wxapp',
	},
	hoverClass: {
		type: String,
		default: 'none',
	},
	hoverStopPropagation: {
		type: Boolean,
		default: false,
	},
	hoverStartTime: {
		type: Number,
		default: 50,
	},
	hoverStayTime: {
		type: Number,
		default: 400,
	},
})

const info = useInfo()
const viewRef = ref(null)

// owner 常驻，运行期新增或切换 bind/catch 时无需等待组件重建。
useTouchEvents(info, viewRef)

useNativeEvents(info, viewRef, ['transitionend', 'animationend'])

const { isHover, onHoverCancel, onHoverEnd, onHoverStart } = useHover(props)
</script>

<template>
	<div
		ref="viewRef" v-bind="$attrs" class="dd-view" :class="isHover ? hoverClass : undefined"
		:style="inline ? { display: 'inline' } : undefined" :data-session-from="sessionFrom"
		@touchstart="onHoverStart" @touchend="onHoverEnd" @touchcancel="onHoverCancel"
		@mousedown="onHoverStart" @mouseup="onHoverEnd" @mouseleave="onHoverCancel"
	>
		<slot />
	</div>
</template>

<style lang="scss">
.dd-view {
	display: block;

	&[hidden] {
		display: none;
	}
}
</style>
