<script setup>
import { useInfo } from '@/common/events'
// 覆盖在原生组件之上的图片视图。
// 可覆盖的原生组件同cover-view，支持嵌套在cover-view里
// https://developers.weixin.qq.com/miniprogram/dev/component/cover-image.html
import Image from '../image/Image.vue'

const props = defineProps({
	src: {
		type: String,
		default: '',
	},
})
useInfo()
</script>

<template>
	<Image v-bind="$attrs" :src="props.src" />
</template>
