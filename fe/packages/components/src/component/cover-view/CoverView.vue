<script setup>
import { useInfo } from '@/common/events'
// 覆盖在原生组件之上的文本视图。
// 可覆盖的原生组件包括 map、video、canvas、camera、live-player、live-pusher
// 只支持嵌套 cover-view、cover-image，可在 cover-view 中使用 button。组件属性的长度单位默认为px
// https://developers.weixin.qq.com/miniprogram/dev/component/cover-view.html
import View from '../view/View.vue'

useInfo()
</script>

<template>
	<View v-bind="$attrs">
		<slot />
	</View>
</template>
