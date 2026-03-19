<script setup>
// 富文本
// https://developers.weixin.qq.com/miniprogram/dev/component/rich-text.html
const props = defineProps({
	/**
	 * 节点列表/HTML String
	 */
	nodes: {
		type: [Array, String],
		default: () => [],
	},
	/**
	 * 显示连续空格
	 * ensp	中文字符空格一半大小
	 * emsp	中文字符空格大小
	 * nbsp	根据字体设置的空格大小
	 */
	space: {
		type: String,
		validator: value => ['ensp', 'emsp', 'nbsp'].includes(value),
	},
	/**
	 * 文本是否可选，该属性会使节点显示为 block
	 */
	userSelect: {
		type: Boolean,
		default: false,
	},
})

const sanitizedHtml = ref('')
const info = inject('info', {})
const scopeId = info?.sId

function renderNode(node) {
	const spaceType = props.space
	let html = `<${node.name}`
	// 处理属性
	if (node.attrs) {
		for (const key in node.attrs) {
			if (Object.hasOwn(node.attrs, key)) {
				let value = node.attrs[key]
				// 如果值是空格，根据 space 属性替换为不同的空格字符
				if (value === ' ') {
					value = `&${spaceType};`
				}
				html += ` ${key}="${value}"`
			}
		}
	}

	if (node.children && node.children.length > 0) {
		html += '>'
		node.children.forEach((child) => {
			if (child.type === 'text') {
				// 替换文本节点中的空格
				const textContent = child.text.replace(/ /g, `&${spaceType};`)
				html += textContent
			}
			else {
				html += renderNode(child, spaceType)
			}
		})
		html += `</${node.name}>`
	}
	else if (node.type === 'text') {
		// 对于文本节点，直接添加文本内容，并替换空格
		const textContent = node.text.replace(/ /g, `&${spaceType};`)
		html += `>${textContent}</${node.name}>`
	}
	else {
		html += '/>'
	}

	return html
}

/**
 * 为 HTML 字符串的所有标签注入 scopeId 属性（如 data-v-xxx）
 */
function injectScopeIdToHtml(html, scopeId) {
	if (!html || !scopeId) return html
	
	// 使用 DOMParser 解析 HTML 字符串
	const parser = new DOMParser()
	const doc = parser.parseFromString(html, 'text/html')
	const body = doc.body
	
	// 递归遍历所有元素节点并添加 scopeId
	function injectAttrs(element) {
		if (element.nodeType === Node.ELEMENT_NODE) {
			element.setAttribute(scopeId, '')
			// 递归处理子元素
			for (const child of element.children) {
				injectAttrs(child)
			}
		}
	}
	
	injectAttrs(body)

	return body.innerHTML
}

onMounted(() => {
	let htmlContent = ''
	const nodes = toRaw(props.nodes)
	if (typeof nodes === 'string') {
		htmlContent = injectScopeIdToHtml(nodes, scopeId)
	}
	else if (typeof nodes === 'object' && Array.isArray(nodes)) {
		nodes.forEach((node) => {
			htmlContent += renderNode(node)
		})
		if (htmlContent) {
			htmlContent = injectScopeIdToHtml(htmlContent, scopeId)
		}
	}
	// HTML 清理逻辑 来避免 XSS 攻击。考虑使用像 DOMPurify 这样的库来清理 HTML。
	sanitizedHtml.value = htmlContent.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
})
</script>

<template>
	<div v-bind="$attrs" :class="{ 'dd-rich-text': userSelect }" v-html="sanitizedHtml" />
</template>

<style lang="scss">
.dd-rich-text {
	user-select: text; /* 允许文本被选择 */

	&[hidden] {
		display: none;
	}
}
</style>
