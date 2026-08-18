<script setup>
// 仅可放置在swiper组件中，宽高自动设置为100%。
// https://developers.weixin.qq.com/miniprogram/dev/component/swiper-item.html

const props = defineProps({
	/**
	 * 该 swiper-item 的标识符
	 */
	itemId: {
		type: String,
	},
})
</script>

<template>
	<div v-bind="$attrs" class="dd-swiper-item" :item-id="props.itemId">
		<slot />
	</div>
</template>

<style lang="scss">
.dd-swiper-item {
	display: block;
	flex: 0 0 100%;
	width: 100%;
    will-change: transform;

	&[hidden] {
		display: none;
	}
}
</style>
