<script setup>
// 使整个子树从页面中脱离出来。组件只改变挂载位置，不替业务添加
// fixed、尺寸或 z-index；这与 exparser 的 root-portal-content 语义一致。
// https://developers.weixin.qq.com/miniprogram/dev/component/root-portal.html

defineProps({
	enable: {
		type: Boolean,
		default: true,
	},
})
</script>

<template>
	<template v-if="enable">
		<span v-bind="$attrs" class="dd-root-portal-host" />
		<Teleport to="html">
			<slot />
		</Teleport>
	</template>
	<span v-else v-bind="$attrs" class="dd-root-portal-content">
		<slot />
	</span>
</template>

<style lang="scss">
.dd-root-portal-host {
	display: none;
}

.dd-root-portal-content[hidden] {
	display: none;
}
</style>
