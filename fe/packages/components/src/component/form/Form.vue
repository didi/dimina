<script setup>
// 表单。将组件内的用户输入的switch input checkbox slider radio picker 提交
// https://developers.weixin.qq.com/miniprogram/dev/component/form.html

import { triggerEvent, useInfo } from '@/common/events'

defineProps({
	/**
	 * 是否返回 formId 用于发送模板消息
	 */
	reportSubmit: {
		type: Boolean,
		default: false,
		required: false, // 由于“否”表示不是必填项，所以设置为 false
	},
	/**
	 * 等待一段时间（毫秒数）以确认 formId 是否生效。
	 * 如果未指定这个参数，formId 有很小的概率是无效的（如遇到网络失败的情况）。
	 * 指定这个参数将可以检测 formId 是否有效，以这个参数的时间作为这项检测的超时时间。
	 * 如果失败，将返回 requestFormId:fail 开头的 formId
	 */
	reportSubmitTimeout: {
		type: Number,
		default: 0,
		required: false, // 由于“否”表示不是必填项，所以设置为 false
	},
})

// 创建一个响应式对象来存储子组件的数据
const formValues = ref({})
const formControls = new Set()

// 提供一个方法来收集子组件的数据
function collectFormValue(name, value) {
	if (name) {
		formValues.value[name] = value
	}
}

function registerFormControl(control) {
	formControls.add(control)
	return () => formControls.delete(control)
}

function readFormValues() {
	const values = { ...toRaw(formValues.value) }
	for (const control of formControls) {
		const name = control.getName?.()
		if (name) {
			values[name] = control.getValue?.()
		}
	}
	return values
}

// 提供这个方法给子组件
provide('collectFormValue', collectFormValue)
provide('registerFormControl', registerFormControl)

const info = useInfo()
function handleEvent(event, formType) {
	event.stopPropagation()
	if (formType === 'submit') {
		triggerEvent('submit', {
			event,
			info,
			detail: {
				value: readFormValues(),
			},
		})
	}
	else if (formType === 'reset') {
		for (const control of formControls) {
			control.reset?.()
		}
		formValues.value = {}
		triggerEvent('reset', {
			event,
			info,
		})
	}
}

provide('formEvent', handleEvent)
</script>

<template>
	<span v-bind="$attrs">
		<slot />
	</span>
</template>
