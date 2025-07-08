<script setup>
import { useInfo } from '@/common/events'

const props = defineProps({
	name: {
		type: String,
	},
})

useInfo()

// 将 path 转换为有效的 HTML 标签名
const componentName = computed(() => {
	if (!props.name) return 'wrapper-component'
	
	// 将路径转换为有效的标签名：
	// 1. 移除开头的斜杠
	// 2. 将斜杠替换为连字符
	// 3. 移除 /index 后缀
	// 4. 确保以字母开头
	let name = props.name
		.replace(/^\/+/, '') // 移除开头的斜杠
		.replace(/\/index$/, '') // 移除结尾的 /index
		.replace(/\//g, '-') // 将斜杠替换为连字符
		.replace(/[^a-zA-Z0-9-]/g, '-') // 将其他特殊字符替换为连字符
		.toLowerCase()
	
	// 确保以字母开头
	if (!/^[a-zA-Z]/.test(name)) {
		name = 'wrapper-' + name
	}
	
	return name || 'wrapper-component'
})

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
	<component :is="componentName" v-bind="$attrs" ref="wrapperRef">
		<slot />
	</component>
</template>
