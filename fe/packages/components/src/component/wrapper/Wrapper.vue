<script setup>
import { useInfo } from '@/common/events'

useInfo()

const wrapperRef = ref(null)

// 创建 shadow DOM 的函数
function createShadowDOM() {
	if (!wrapperRef.value) return
	
	const shadowRoot = wrapperRef.value.attachShadow({ mode: 'open' })
	
	const slot = document.createElement('slot')
	shadowRoot.appendChild(slot)
}

onMounted(() => {
	createShadowDOM()
})
// 自定义组件需要该组件接收点击事件定义，相关事件将在 render 中处理
</script>

<template>
	<wrapper-component v-bind="$attrs" ref="wrapperRef">
		<slot />
	</wrapper-component>
</template>
