<script setup>
// 覆盖在原生组件之上的文本视图。
// 可覆盖的原生组件包括 map、video、canvas、camera、live-player、live-pusher
// 只支持嵌套 cover-view、cover-image，可在 cover-view 中使用 button。组件属性的长度单位默认为px
// https://developers.weixin.qq.com/miniprogram/dev/component/cover-view.html
import { useNativeOverlayComponent } from '@/common/useNativeOverlayComponent'
import View from '../view/View.vue'

const rootRef = ref()
const { isAndroid, nativeId } = useNativeOverlayComponent({
	type: 'native/cover-view',
	rootRef,
	getParams: () => ({
		text: rootRef.value?.textContent?.replace(/\s+/g, ' ').trim() || '',
	}),
})
</script>

<template>
	<div v-if="isAndroid" :id="nativeId" ref="rootRef" v-bind="$attrs" class="dd-cover-view-native-placeholder">
		<slot />
	</div>
	<View v-else v-bind="$attrs">
		<slot />
	</View>
</template>

<style lang="scss">
.dd-cover-view-native-placeholder {
	pointer-events: none !important;
	visibility: hidden !important;
}
</style>
