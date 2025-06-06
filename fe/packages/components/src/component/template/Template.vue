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
})

const tplCom = computed(() => {
	return `dd-tpl-${props.is}`
})
</script>

<template>
	<component :is="tplCom" v-bind="$attrs" :data="data" />
</template>
