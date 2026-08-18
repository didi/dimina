<script setup>
import { hasEvent, triggerEvent, useInfo } from '@/common/events'
import { useTapEvents } from '@/common/useTapEvents'
// 文本
// https://developers.weixin.qq.com/miniprogram/dev/component/text.html

const props = defineProps({
	/** @deprecated 请使用 user-select */
	selectable: {
		type: Boolean,
		default: false,
	},
	/**
	 * 文本是否可选，该属性会使文本节点显示为 inline-block
	 */
	userSelect: {
		type: Boolean,
		default: false,
	},
	/**
	 * 显示连续空格
	 * ensp	中文字符空格一半大小
	 * emsp	中文字符空格大小
	 * nbsp	根据字体设置的空格大小
	 */
	space: {
		type: String,
		validator: (value) => {
			return ['ensp', 'emsp', 'nbsp'].includes(value)
		},
	},
	/**
	 * 是否解码
	 * decode可以解析的有 &nbsp; &lt; &gt; &amp; &apos; &ensp; &emsp;
	 */
	decode: {
		type: Boolean,
		default: false,
	},
})

const textRef = ref(null)

function htmlDecode(e) {
	// 处理空格替换
	const spaces = {
		nbsp: '\u00A0',
		ensp: '\u2002',
		emsp: '\u2003',
	}
	if (spaces[props.space]) {
		e = e.replace(/ /g, spaces[props.space])
	}

	// 处理解码
	if (props.decode) {
		e = e
			.replace(/&nbsp;/g, '\u00A0')
			.replace(/&ensp;/g, '\u2002')
			.replace(/&emsp;/g, '\u2003')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, '\'')
			.replace(/&amp;/g, '&')
	}

	return e
}

function transformTextNodes() {
	if (textRef.value) {
		const walker = document.createTreeWalker(textRef.value, NodeFilter.SHOW_TEXT)
		const nodes = []
		let node = walker.nextNode()
		while (node) {
			nodes.push(node)
			node = walker.nextNode()
		}
		for (const textNode of nodes) {
				// 获取文本内容
				const text = textNode.nodeValue
				// 解码文本内容
				const decodedText = htmlDecode(text)
				const splitText = decodedText.split('\\n')
				// 存在换行符
				if (splitText.length > 1) {
					const newNode = document.createDocumentFragment()
					for (let i = 0; i < splitText.length; i++) {
						newNode.appendChild(document.createTextNode(splitText[i]))
						if (i < splitText.length - 1) {
							newNode.appendChild(document.createElement('br'))
						}
					}
					textNode.parentNode.replaceChild(newNode, textNode)
				}
				else {
					// 如果解码后的文本不同，则替换原始文本节点
					if (decodedText !== text) {
						// 创建一个新的文本节点
						const newNode = document.createTextNode(decodedText)
						// 替换原始文本节点
						textNode.parentNode.replaceChild(newNode, textNode)
					}
				}
		}
	}
}

onMounted(transformTextNodes)
onUpdated(transformTextNodes)

const info = useInfo()

// 判断是否有tap事件属性
const hasTapEvent = hasEvent(info, 'tap')
if (hasTapEvent) {
	useTapEvents(textRef, (event) => {
		triggerEvent('tap', { event, info })
	})
}

const canSelect = computed(() => props.userSelect || props.selectable)
</script>

<template>
	<span
		ref="textRef" v-bind="$attrs" class="dd-text" :class="{ 'dd-text-selectable': canSelect }"
	>
		<slot />
	</span>
</template>

<style lang="scss">
.dd-text {
	user-select: none;
	display: inline;

	&[hidden] {
		display: none;
	}
}

.dd-text-selectable {
	cursor: auto;
	display: inline-block;
	user-select: text;
}
</style>
