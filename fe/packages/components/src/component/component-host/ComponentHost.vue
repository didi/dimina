<script setup>
import { useInfo } from '@/common/events'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	name: {
		type: String,
	},
})

const info = useInfo()
const hostRef = ref(null)

// 宿主节点承载的是父级模板里写的那个节点，它的 bind/catch 由声明这次使用的页面或自定义组件
// 处理，不属于组件自身的模块，所以 moduleId 取注入的 pageId。
const hostInfo = {
	attrs: info.attrs,
	bridgeId: info.bridgeId,
	moduleId: inject(info.path)?.pageId ?? info.moduleId,
}

// 宿主节点必须和普通组件走同一条手势链路：tap 由触摸序列合成、catch 靠共享的停止标记生效。
// 靠原生 click 派发会排在祖先合成 tap 之后，后代的 catchtap 再也拦不住祖先的 bindtap。
useTouchEvents(hostInfo, hostRef)

// 将 path 转换为有效的 HTML 标签名
const componentName = computed(() => {
	if (!props.name) return 'component-host'
	
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
		name = 'component-host-' + name
	}
	
	return name || 'component-host'
})

</script>

<template>
	<component :is="componentName" ref="hostRef" v-bind="$attrs">
		<slot />
	</component>
</template>
