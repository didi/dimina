<script setup>
// 开关选择器
// https://developers.weixin.qq.com/miniprogram/dev/component/switch.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	name: {
		type: String,
	},
	/**
	 * 是否选中
	 */
	checked: {
		type: Boolean,
		default: false,
	},
	/**
	 * 是否禁用
	 */
	disabled: {
		type: Boolean,
		default: false,
	},
	/**
	 * 样式，有效值 switch, checkbox
	 */
	type: {
		type: String,
		default: 'switch',
		validator: (value) => {
			return ['switch', 'checkbox'].includes(value)
		},
	},
	/**
	 * switch 的颜色，同 css 的 color
	 */
	color: {
		type: String,
		default: '#04BE02',
	},
	autoFill: {
		type: String,
		default: '',
	},
})

const isOn = ref(props.checked)

// 注入父组件提供的方法
const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
watch(
	() => props.checked,
	(newVal) => {
		isOn.value = newVal
		collectFormValue?.(props.name, isOn.value)
	},
	{ immediate: true }, // 立即执行一次回调
)

const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue: () => isOn.value,
	reset: () => {
		isOn.value = false
		collectFormValue?.(props.name, isOn.value)
	},
})
onBeforeUnmount(() => unregisterFormControl?.())

const computedStyle = computed(() => {
	const checkedColor = isOn.value ? (props.color ?? '#04BE02') : undefined
	if (props.type === 'checkbox') {
		return { color: checkedColor }
	}
	else {
		return { backgroundColor: checkedColor }
	}
})

const info = useInfo()
function handleClicked(event) {
	if (!props.disabled) {
		isOn.value = !isOn.value
		collectFormValue?.(props.name, isOn.value)
		triggerEvent('change', {
			event,
			info,
			detail: {
				value: isOn.value,
			},
		})
	}
}
</script>

<template>
	<div
		v-if="type === 'checkbox'" :id="id" v-bind="$attrs" class="dd-checkbox-input" data-dd-label-target
		role="checkbox" :tabindex="disabled ? -1 : 0" :aria-checked="isOn" :aria-disabled="disabled"
		:class="{ 'dd-checkbox-input-checked': isOn, 'dd-checkbox-input-disabled': disabled }" @click="handleClicked"
		@keydown.enter.prevent="handleClicked" @keydown.space.prevent="handleClicked"
	>
		<i
			class="dd-checkbox-input-inner" :style="computedStyle"
		/>
	</div>
	<div
		v-else :id="id" v-bind="$attrs" class="dd-switch-input" data-dd-label-target role="switch"
		:tabindex="disabled ? -1 : 0" :aria-checked="isOn" :aria-disabled="disabled" :class="{ 'dd-switch-input-checked': isOn, 'dd-switch-input-disabled': disabled }"
		@click="handleClicked"
		@keydown.enter.prevent="handleClicked" @keydown.space.prevent="handleClicked"
	>
		<i class="dd-switch-input-inner" :style="computedStyle" />
	</div>
</template>

<style lang="scss">
.dd-switch-input {
	appearance: none;
	position: relative;
	width: 52px;
	height: 32px;
	margin-right: 5px;
	border: 1px solid #dfdfdf;
	outline: 0;
	border-radius: 16px;
	box-sizing: border-box;
	background-color: #dfdfdf;
	transition: background-color 0.1s, border 0.1s;
	display: inline-block;

	&::before {
		content: ' ';
		position: absolute;
		top: 0;
		left: 0;
		width: 50px;
		height: 30px;
		border-radius: 15px;
		background-color: #fdfdfd;
		transition: transform 0.3s;
	}

	&::after {
		content: ' ';
		position: absolute;
		top: 0;
		left: 0;
		width: 30px;
		height: 30px;
		border-radius: 15px;
		background-color: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
		transition: transform 0.3s;
	}
}

.dd-switch-input-inner {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	border-radius: inherit;
}

.dd-switch-input-checked {

	&::before {
		transform: scale(0);
	}

	&::after {
		transform: translateX(20px);
	}
}

.dd-switch-input-disabled {
	opacity: 0.3;
}

.dd-checkbox-input {
	margin-right: 5px;
	appearance: none;
	outline: 0;
	border: 1px solid #d1d1d1;
	background-color: #ffffff;
	border-radius: 3px;
	width: 22px;
	height: 22px;
	position: relative;
	display: inline-block;
}

.dd-checkbox-input-inner {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	border-radius: inherit;
}

.dd-checkbox-input-checked .dd-checkbox-input-inner::before {
	font: normal normal normal 14px / 1 'weui';
	content: '\EA08';
	color: inherit;
	font-size: 22px;
	position: absolute;
	top: 50%;
	left: 50%;
	transform: translate(-50%, -48%) scale(0.73);
}

.dd-checkbox-input-disabled {
	background-color: #e1e1e1;
}

.dd-checkbox-input-disabled:before {
	color: #adadad;
}
</style>
