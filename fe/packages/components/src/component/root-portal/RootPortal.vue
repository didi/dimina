<script setup>
// 使整个子树从页面中脱离出来，类似于在 CSS 中使用 fixed position 的效果。主要用于制作弹窗、弹出层等。
// https://developers.weixin.qq.com/miniprogram/dev/component/root-portal.html
defineProps({
	// 不能删除，避免组件名字为空
})
</script>

<template>
	<div v-bind="$attrs" />
</template>

<style lang="scss">
</style>
