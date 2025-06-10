<script setup>
// 多选项目
// https://developers.weixin.qq.com/miniprogram/dev/component/checkbox.html

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * checkbox标识，选中时触发checkbox-group的 change 事件，并携带 checkbox 的 value。
	 */
	value: {
		type: String,
	},
	/**
	 * 是否禁用 checkbox。
	 */
	disabled: {
		type: Boolean,
		default: false,
	},
	/**
	 * 当前是否选中，可用来设置默认选中。
	 */
	checked: {
		type: Boolean,
		default: false,
	},
	/**
	 * checkbox颜色，同css的color。
	 */
	color: {
		type: String,
		default: '#09BB07',
	},
})

const selectValue = inject('selectValue', undefined)
const selected = inject('selected', ref(props.checked ? [props.value] : []))
const isOn = ref(props.checked)

if (props.checked) {
	selectValue?.(props.value)
}
else {
	selectValue?.(undefined)
}

const computedStyle = computed(() => {
	if (props.color) {
		return {
			color: props.color,
		}
	}
	else {
		return undefined
	}
})

function handleClicked(event) {
	if (!props.disabled) {
		if (typeof selectValue === 'function') {
			selectValue(props.value)
		}
		else {
			if (selected.value.includes(props.value)) {
				selected.value = selected.value.filter(item => item !== props.value)
			}
			else {
				selected.value.push(props.value)
			}
		}
		isOn.value = !isOn.value
	}
}
</script>

<template>
	<div v-bind="$attrs" class="dd-checkbox" @click="handleClicked">
		<div class="dd-checkbox-wrapper">
			<div
				class="dd-checkbox-input"
				:class="{ 'dd-checkbox-input-checked': isOn, 'dd-checkbox-input-disabled': disabled }"
				:style="computedStyle"
			/>
		</div>
	</div>
</template>

<style lang="scss">
.dd-checkbox {
	display: inline-block;

	&[hidden] {
		display: none;
	}
}

.dd-checkbox-wrapper {
	display: inline-flex;
	align-items: center;
	vertical-align: middle;
}

.dd-checkbox-input {
	margin-right: 5px;
	appearance: none;
	outline: 0;
	text-indent: 0;
	border: 1px solid #d1d1d1;
	background-color: #ffffff;
	border-radius: 3px;
	width: 22px;
	height: 22px;
	position: relative;
}

.dd-checkbox-input-checked {
	color: #09bb07;

	&::before {
		font: normal normal normal 14px/1 'weui';
		content: '\EA08';
		font-size: 22px;
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -48%) scale(0.73);
	}
}

.dd-checkbox-input-disabled {
	background-color: #e1e1e1;

	&::before {
		color: #adadad;
	}
}
</style>
