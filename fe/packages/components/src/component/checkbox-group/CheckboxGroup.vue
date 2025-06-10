<script setup>
// 多项选择器，内部由多个checkbox组成
// https://developers.weixin.qq.com/miniprogram/dev/component/checkbox-group.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * name，为表单使用
	 */
	name: {
		type: String,
	},
})

// 注入表单组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const selected = ref([])

function selectValue(value) {
	if (value !== undefined) {
		if (selected.value.includes(value)) {
			selected.value = selected.value.filter(item => item !== value)
		}
		else {
			selected.value.push(value)
		}
	}
	collectFormValue?.(props.name, toRaw(selected.value))
}

const info = useInfo()
function handleClicked(event) {
	const v = toRaw(selected.value)
	collectFormValue?.(props.name, v)
	triggerEvent('change', {
		event,
		info,
		detail: {
			value: v,
		},
	})
}

provide('selected', selected)
provide('selectValue', selectValue)
</script>

<template>
	<div :id="id" v-bind="$attrs" class="dd-checkbox-group" @click="handleClicked">
		<slot />
	</div>
</template>

<style lang="scss">
.dd-checkbox-group {
	display: block;

	&[hidden] {
		display: none;
	}
}
</style>
