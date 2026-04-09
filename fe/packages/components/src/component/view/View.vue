<script setup>
// 视图容器
// https://developers.weixin.qq.com/miniprogram/dev/component/view.html
import { hasEvent, triggerEvent, useInfo } from '@/common/events'
import { useNativeEvents } from '@/common/useNativeEvents'
import { useTapEvents } from '@/common/useTapEvents'
import { useTouchEvents } from '@/common/useTouchEvents'

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
	|| hasEvent(info, 'longpress')

// 只有当存在触摸相关事件属性时，才使用触摸事件处理逻辑
if (hasTouchEvents) {
	useTouchEvents(info, viewRef)
}

useNativeEvents(info, viewRef, ['transitionend', 'animationend'])
</script>

<template>
	<div ref="viewRef" v-bind="$attrs" class="dd-view">
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
