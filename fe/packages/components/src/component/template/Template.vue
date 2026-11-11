<script setup>
// https://developers.weixin.qq.com/miniprogram/dev/reference/wxml/template.html

const props = defineProps({
	is: {
		type: String,
		required: true,
	},
	data: {
		type: Object,
	},
	diminaTemplateScope: Object,
})

const templateComponents = inject('dimina-template-components', null)
const tplCom = computed(() => {
	const scope = props.diminaTemplateScope
	const name = scope
		? (Object.prototype.hasOwnProperty.call(scope, props.is) ? scope[props.is] : '')
		: (props.is ? `tpl-${props.is}` : '')
	if (!name) return null
	const key = `dd-${name}`
	// A template keeps its caller's custom-component registry while its names
	// are resolved in the declaring WXML file. Missing lexical names render nothing.
	if (templateComponents?.[key]) return templateComponents[key]
	return scope ? null : key
})

const bindProps = computed(() => {
	return {
		...(props.data || {}),
	}
})
</script>

<template>
	<component :is="tplCom" v-bind="{ ...$attrs, data: bindProps }" />
</template>
