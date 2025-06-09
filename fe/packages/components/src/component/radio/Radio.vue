<script setup>
// 单选项目
// https://developers.weixin.qq.com/miniprogram/dev/component/radio.html

import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * radio 标识。当该radio 选中时，radio-group 的 change 事件会携带radio的value
	 */
	value: {
		type: String,
		default: '',
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
	 * switch 的颜色，同 css 的 color
	 */
	color: {
		type: String,
		default: '#09BB07',
	},
})
const selectValue = inject('selectValue', undefined)
// 父级 radio-group 的选中值
const selected = inject('selected', undefined)

if (props.checked) {
	selectValue?.(props.value)
}

const isOn = computed(() => {
	if (selected) {
		return selected.value === props.value
	}
	else {
		return Boolean(props.checked)
	}
})

const computedStyle = computed(() => {
	if (props.color && isOn.value) {
		return {
			backgroundColor: props.color,
			borderColor: props.color,
		}
	}
	else {
		return undefined
	}
})

// 父级 radio-group 的 change 事件
const handleValueChange = inject('handleValueChange', undefined)
const info = useInfo()
function handleClicked(event) {
	if (!props.disabled) {
		if (typeof selectValue === 'function') {
			selectValue(props.value)
		}
		handleValueChange?.(event)

		triggerEvent('tap', {
			event,
			info,
			detail: {},
		})
	}
}
</script>

<template>
	<div v-bind="$attrs" class="dd-radio" @click="handleClicked">
		<div class="dd-radio-wrapper">
			<div
				class="dd-radio-input" :class="{ 'dd-radio-input-checked': isOn, 'dd-radio-input-disabled': disabled }"
				:style="computedStyle"
			/>
			<slot />
		</div>
	</div>
</template>

<style lang="scss">
.dd-radio {
	display: inline-block;

	&[hidden] {
		display: none;
	}
}

.dd-radio-wrapper {
	display: inline-flex;
	align-items: center;
	vertical-align: middle;
}

.dd-radio-input {
	appearance: none;
	margin-right: 5px;
	outline: 0;
	border: 1px solid #d1d1d1;
	background-color: #ffffff;
	border-radius: 50%;
	width: 22px;
	height: 22px;
	position: relative;
}

.dd-radio-input-checked {
	background-color: #09bb07;
	border-color: #09bb07;

	&::before {
		font: normal normal normal 14px/1 'weui';
		content: '\EA08';
		color: #ffffff;
		font-size: 18px;
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -48%) scale(0.73);
	}
}

.dd-radio-input-disabled {
	background-color: #e1e1e1;
	border-color: #d1d1d1;

	&::before {
		color: #adadad;
	}
}
</style>
