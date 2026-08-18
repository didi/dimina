<script setup>
import { renderRichTextNodes, sanitizeRichText } from './richTextSanitizer.js'

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

/**
 * 为已经清理过的 HTML 注入组件 scopeId（如 data-v-xxx）。
 */
function injectScopeIdToHtml(html, id) {
	if (!html || !id) return html

	const parser = new DOMParser()
	const doc = parser.parseFromString(html, 'text/html')
	for (const element of doc.body.querySelectorAll('*')) {
		element.setAttribute(id, '')
	}
	return doc.body.innerHTML
}

watchEffect(() => {
	const nodes = toRaw(props.nodes)
	const htmlContent = typeof nodes === 'string'
		? nodes
		: renderRichTextNodes(Array.isArray(nodes) ? nodes : [], props.space)

	// Sanitization must happen before v-html and before adding framework-owned
	// attributes. This blocks event handlers, scriptable URLs, SVG/MathML and
	// unsupported rich-text nodes for both string and array inputs.
	sanitizedHtml.value = injectScopeIdToHtml(sanitizeRichText(htmlContent), scopeId)
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
