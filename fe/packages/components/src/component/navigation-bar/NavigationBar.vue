<script setup>
// 页面导航条配置节点，用于指定导航栏的一些属性。只能是 page-meta 组件内的第一个节点，需要配合它一同使用。
// 通过这个节点可以获得类似于调用 wx.setNavigationBarTitle wx.setNavigationBarColor 等接口调用的效果。
// https://developers.weixin.qq.com/miniprogram/dev/component/navigation-bar.html

import { invokeAPI, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * 导航条标题
	 */
	title: {
		type: String,
		required: false,
	},
	/**
	 * 是否在导航条显示 loading 加载提示
	 */
	loading: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 导航条前景颜色值，包括按钮、标题、状态栏的颜色，仅支持 #ffffff 和 #000000
	 */
	frontColor: {
		type: String,
		required: false,
		validator: value => ['#ffffff', '#000000'].includes(value),
	},
	/**
	 * 导航条背景颜色值，有效值为十六进制颜色
	 */
	backgroundColor: {
		type: String,
		required: false,
		validator: value => /^#(?:[0-9A-F]{6}|[0-9A-F]{3})$/i.test(value),
	},
	/**
	 * 改变导航栏颜色时的动画时长，默认为 0 （即没有动画效果）
	 */
	colorAnimationDuration: {
		type: Number,
		default: 0,
		required: false,
	},
	/**
	 * 改变导航栏颜色时的动画方式，支持 linear 、 easeIn 、 easeOut 和 easeInOut
	 */
	colorAnimationTimingFunc: {
		type: String,
		default: 'linear',
		required: false,
		validator: value => ['linear', 'easeIn', 'easeOut', 'easeInOut'].includes(value),
	},
})

const info = useInfo()
function updateTitle() {
	invokeAPI('setNavigationBarTitle', {
		bridgeId: info.bridgeId,
		params: { title: props.title },
	})
}

function updateColor() {
	invokeAPI('setNavigationBarColor', {
		bridgeId: info.bridgeId,
		params: {
			frontColor: props.frontColor,
			backgroundColor: props.backgroundColor,
			animation: {
				duration: props.colorAnimationDuration,
				timingFunc: props.colorAnimationTimingFunc,
			},
		},
	})
}

function updateLoading() {
	invokeAPI(props.loading ? 'showNavigationBarLoading' : 'hideNavigationBarLoading', {
		bridgeId: info.bridgeId,
		params: {},
	})
}

watch(() => props.title, updateTitle, { immediate: true })
watch(
	() => [props.frontColor, props.backgroundColor, props.colorAnimationDuration, props.colorAnimationTimingFunc],
	updateColor,
	{ immediate: true },
)
watch(() => props.loading, updateLoading, { immediate: true })
</script>

<template>
	<slot />
</template>
