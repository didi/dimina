<script setup>
// 视图容器
// https://developers.weixin.qq.com/miniprogram/dev/component/view.html
import { hasEvent, triggerEvent, useInfo } from '@/common/events'
import { useNativeEvents } from '@/common/useNativeEvents'
import { useHover } from '@/common/useHover'
import { useTapEvents } from '@/common/useTapEvents'
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

// 判断是否有tap事件属性
const hasTapEvent = hasEvent(info, 'tap')
if (hasTapEvent) {
	useTapEvents(viewRef, (event) => {
		triggerEvent('tap', { event, info })
	})
}

// 判断是否有触摸相关事件属性
const hasTouchEvents = hasEvent(info, 'touchstart') || hasEvent(info, 'touchmove')
	|| hasEvent(info, 'touchend') || hasEvent(info, 'touchcancel')
	|| hasEvent(info, 'longpress') || hasEvent(info, 'longtap')

// 只有当存在触摸相关事件属性时，才使用触摸事件处理逻辑
if (hasTouchEvents) {
	useTouchEvents(info, viewRef)
}

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
