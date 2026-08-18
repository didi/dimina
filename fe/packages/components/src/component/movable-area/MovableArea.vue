<script setup>
// movable-area的可移动区域
// https://developers.weixin.qq.com/miniprogram/dev/component/movable-area.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * 当里面的movable-view设置为支持双指缩放时，设置此值可将缩放手势生效区域修改为整个movable-area
	 */
	scaleArea: {
		type: Boolean,
		default: false,
		require: false,
	},
})

const info = useInfo()
const movableViews = new Set()
provide('registerMovableView', (handlers) => {
	movableViews.add(handlers)
	return () => movableViews.delete(handlers)
})

function handleScaleGesture(event, phase) {
	if (!props.scaleArea || event.target.closest?.('.dd-movable-view')) return
	if (phase !== 'end' && event.touches?.length < 2) return
	for (const handlers of movableViews) handlers[phase]?.(event)
}

function onClicked(event) {
	triggerEvent('tap', { event, info })
}
</script>

<template>
	<div
		v-bind="$attrs" class="dd-movable-area" @click="onClicked"
		@touchstart="handleScaleGesture($event, 'start')" @touchmove="handleScaleGesture($event, 'move')"
		@touchend="handleScaleGesture($event, 'end')" @touchcancel="handleScaleGesture($event, 'end')"
	>
		<slot />
	</div>
</template>

<style lang="scss">
.dd-movable-area {
	display: block;
	position: relative;
	width: 10px;
	height: 10px;

	&[hidden] {
		display: none;
	}
}
</style>
