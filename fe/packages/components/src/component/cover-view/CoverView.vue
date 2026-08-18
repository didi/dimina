<script setup>
// 覆盖在原生组件之上的文本视图。
// 可覆盖的原生组件包括 map、video、canvas、camera、live-player、live-pusher
// 只支持嵌套 cover-view、cover-image，可在 cover-view 中使用 button。组件属性的长度单位默认为px
// https://developers.weixin.qq.com/miniprogram/dev/component/cover-view.html
import View from '../view/View.vue'

const props = defineProps({
	scrollTop: {
		type: [Number, String],
	},
	scrollLeft: {
		type: [Number, String],
	},
	markerId: {
		type: [Number, String],
	},
	hoverClass: {
		type: String,
		default: 'none',
	},
	hover: {
		type: Boolean,
		default: false,
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

const viewRef = ref(null)
watch(
	[() => props.scrollTop, () => props.scrollLeft],
	([top, left]) => {
		const element = viewRef.value?.$el
		if (!element) return
		if (top !== undefined) element.scrollTop = Number(top) || 0
		if (left !== undefined) element.scrollLeft = Number(left) || 0
	},
	{ flush: 'post', immediate: true },
)
</script>

<template>
	<View
		ref="viewRef" v-bind="$attrs" :marker-id="markerId" :hover="hover" :hover-class="hoverClass"
		:hover-stop-propagation="hoverStopPropagation" :hover-start-time="hoverStartTime" :hover-stay-time="hoverStayTime"
	>
		<slot />
	</View>
</template>
