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
	autoFill: {
		type: String,
	},
})

// 注入表单组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
const items = new Set()

function getValue() {
	return [...items].filter(item => item.isChecked()).map(item => item.getValue())
}

function syncFormValue() {
	collectFormValue?.(props.name, getValue())
}

function registerCheckbox(item) {
	items.add(item)
	syncFormValue()
	return () => {
		items.delete(item)
		syncFormValue()
	}
}

const info = useInfo()
const rootRef = ref(null)
function toggleCheckbox(item, event) {
	item.setChecked(!item.isChecked())
	const value = getValue()
	collectFormValue?.(props.name, value)
	triggerEvent('change', {
		event,
		info,
		// change 绑在 checkbox-group 上，事件的 id / dataset 要取自 group 自己；
		// 转发过来的这个事件的 currentTarget 还停在被勾选的那个 checkbox 上。
		currentTarget: rootRef.value,
		detail: {
			value,
		},
	})
}

function reset() {
	for (const item of items) {
		item.reset()
	}
	syncFormValue()
}

const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue,
	reset,
})
onBeforeUnmount(() => unregisterFormControl?.())

provide('checkboxGroup', { registerCheckbox, toggleCheckbox })
</script>

<template>
	<div :id="id" ref="rootRef" v-bind="$attrs" class="dd-checkbox-group" role="group">
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
