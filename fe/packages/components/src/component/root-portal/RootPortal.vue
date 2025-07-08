<script setup>
// 使整个子树从页面中脱离出来，类似于在 CSS 中使用 fixed position 的效果。主要用于制作弹窗、弹出层等。
// https://developers.weixin.qq.com/miniprogram/dev/component/root-portal.html

// 全局 z-index 计数器，确保每个 portal 都有唯一的 z-index
let globalZIndex = 1000

const props = defineProps({
	/**
	 * 是否启用 portal 功能，禁用时组件表现为普通容器
	 */
	enable: {
		type: Boolean,
		default: true,
	},
})

const currentZIndex = ref(null)

// 计算最终的 z-index
const computedZIndex = computed(() => {
	if (currentZIndex.value !== null) {
		return currentZIndex.value
	}
	return globalZIndex++
})

// 计算 portal 样式
const portalStyle = computed(() => {
	return {
		position: 'fixed',
		top: '0',
		left: '0',
		width: '100%',
		height: '100%',
		'z-index': computedZIndex.value,
	}
})

onMounted(() => {
	// 分配 z-index
	if (currentZIndex.value === null) {
		currentZIndex.value = globalZIndex++
	}
})
</script>

<template>
	<!-- 禁用状态：渲染为普通容器 -->
	<div v-if="!enable" v-bind="$attrs" class="dd-root-portal-disabled">
		<slot />
	</div>
	
	<!-- 启用状态：使用 Teleport 传送到 body -->
	<Teleport v-else to="body">
		<div 
			class="dd-root-portal"
			:style="portalStyle"
			v-bind="$attrs"
		>
			<slot />
		</div>
	</Teleport>
</template>

<style lang="scss">
.dd-root-portal {
	position: fixed;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	z-index: 1000;
}

.dd-root-portal-disabled {
	display: block;
}
</style>
