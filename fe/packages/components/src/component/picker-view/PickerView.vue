<script setup>
// 嵌入页面的滚动选择器。其中只可放置 picker-view-column组件，其它节点不会显示。
// https://developers.weixin.qq.com/miniprogram/dev/component/picker-view.html
import { triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * 数组中的数字依次表示 picker-view 内的 picker-view-column 选择的第几项（下标从 0 开始），数字大于 picker-view-column 可选项长度时，选择最后一项。
	 */
	value: {
		type: Array,
	},
	/**
	 * 设置蒙层的类名
	 */
	maskClass: {
		type: String,
	},
	/**
	 * 设置选择器中间选中框的样式
	 */
	indicatorStyle: {
		type: String,
	},
	/**
	 * 设置选择器中间选中框的类名
	 */
	indicatorClass: {
		type: String,
	},
	/**
	 * 设置蒙层的样式
	 */
	maskStyle: {
		type: String,
	},
	/**
	 * 是否在手指松开时立即触发 change 事件。若不开启则会在滚动动画结束后触发 change 事件。
	 */
	immediateChange: {
		type: Boolean,
		default: false,
	},
	name: {
		type: String,
	},
	autoFill: {
		type: String,
	},
})

let index = -1
const pickerView = ref(null)
const itemValue = ref([...(props.value || [])])

provide('getPickerHeight', () => {
	return pickerView.value.offsetHeight
})

provide('pickerItemStyle', computed(() => ({
	indicatorStyle: props.indicatorStyle,
	indicatorClass: props.indicatorClass,
	maskStyle: props.maskStyle,
	maskClass: props.maskClass,
})))

provide('itemValue', itemValue)
provide('pickerImmediateChange', computed(() => props.immediateChange))
provide('getItemIndex', () => {
	return ++index
})

provide('setPickerValue', (index, value) => {
	itemValue.value[index] = value
})

watch(() => props.value, (value = []) => {
	itemValue.value = [...value]
}, { deep: true })

const info = useInfo()
provide('pickerEvent', (type, event) => {
	const detail = type === 'change' ? { value: [...itemValue.value] } : {}
	triggerEvent(type, {
		event,
		info,
		detail,
	})
})

const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
watch(itemValue, value => collectFormValue?.(props.name, [...value]), { deep: true, immediate: true })
const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue: () => [...itemValue.value],
	reset: () => {
		itemValue.value = [...(props.value || [])]
	},
})
onBeforeUnmount(() => unregisterFormControl?.())
</script>

<template>
	<div ref="pickerView" v-bind="$attrs" class="dd-picker-view">
		<slot />
	</div>
</template>

<style lang="scss">
.dd-picker-view {
	display: flex;
	position: relative;
	overflow: hidden;

	&[hidden] {
		display: none;
	}
}
</style>
