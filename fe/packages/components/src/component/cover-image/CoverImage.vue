<script setup>
// 覆盖在原生组件之上的图片视图。
// 可覆盖的原生组件同cover-view，支持嵌套在cover-view里
// https://developers.weixin.qq.com/miniprogram/dev/component/cover-image.html
import { useNativeOverlayComponent } from '@/common/useNativeOverlayComponent'
import Image from '../image/Image.vue'

const props = defineProps({
	src: {
		type: String,
		default: '',
	},
	mode: {
		type: String,
		default: '',
	},
})
const rootRef = ref()
const { isAndroid, nativeId } = useNativeOverlayComponent({
	type: 'native/cover-image',
	rootRef,
	getParams: () => ({
		src: props.src,
		mode: props.mode,
	}),
	watchSources: () => [props.src, props.mode],
})
</script>

<template>
	<span v-if="isAndroid" :id="nativeId" ref="rootRef" v-bind="$attrs" class="dd-cover-image-native-placeholder">
		<img :src="props.src" alt="" />
	</span>
	<Image v-else v-bind="$attrs" :src="props.src" :mode="props.mode" />
</template>

<style lang="scss">
.dd-cover-image-native-placeholder {
	display: inline-block;
	pointer-events: none !important;
	visibility: hidden !important;

	img {
		width: inherit;
		height: inherit;
	}
}
</style>
