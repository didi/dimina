<script setup>
// 设置 input / textarea 聚焦时键盘上方的工具栏视图。
// https://developers.weixin.qq.com/miniprogram/dev/component/keyboard-accessory.html

const props = defineProps({
	maxHeight: {
		type: Number,
		default: 200,
	},
})

const inputFocused = inject('keyboardAccessoryVisible', ref(false))
const visible = computed(() => inputFocused.value && window.innerWidth <= window.innerHeight)
const accessoryStyle = computed(() => ({
	bottom: 0,
	left: 0,
	maxHeight: `${props.maxHeight}px`,
	pointerEvents: visible.value ? 'auto' : 'none',
	position: 'fixed',
	visibility: visible.value ? 'visible' : 'hidden',
	width: '100%',
	zIndex: visible.value ? 1 : -1,
}))
</script>

<template>
	<Teleport to="body">
		<div v-bind="$attrs" class="dd-keyboard-accessory" :style="accessoryStyle">
			<slot />
		</div>
	</Teleport>
</template>

<style lang="scss">
.dd-keyboard-accessory {
	overflow: auto;
}
</style>
