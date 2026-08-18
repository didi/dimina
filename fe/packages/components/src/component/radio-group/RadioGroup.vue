<script setup>
// 单项选择器，内部由多个 radio 组成。
// https://developers.weixin.qq.com/miniprogram/dev/component/radio-group.html

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
	autoFill: {
		type: String,
	},
})

// 注入表单组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
const items = new Set()

function getSelectedItem() {
	return [...items].find(item => item.isChecked())
}

function getValue() {
	return getSelectedItem()?.getValue() ?? ''
}

function registerRadio(item) {
	items.add(item)
	if (item.isChecked()) {
		for (const other of items) {
			if (other !== item) other.setChecked(false)
		}
	}
	collectFormValue?.(props.name, getValue())
	return () => items.delete(item)
}

const info = useInfo()
function selectRadio(item, event) {
	if (item.isChecked()) return
	for (const other of items) {
		other.setChecked(other === item)
	}
	const value = getValue()
	collectFormValue?.(props.name, value)
	triggerEvent('change', {
		event,
		info,
		detail: {
			value,
		},
	})
}

function reset() {
	for (const item of items) item.reset()
	const selectedItems = [...items].filter(item => item.isChecked())
	selectedItems.slice(1).forEach(item => item.setChecked(false))
	collectFormValue?.(props.name, getValue())
}

const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue,
	reset,
})
onBeforeUnmount(() => unregisterFormControl?.())

provide('radioGroup', { registerRadio, selectRadio })
</script>

<template>
	<div :id="id" v-bind="$attrs" class="dd-radio-group">
		<slot />
	</div>
</template>

<style lang="scss">
.dd-radio-group {
	display: block;

	&[hidden] {
		display: none;
	}
}
</style>
