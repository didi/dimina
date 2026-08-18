<script setup>
// 从底部弹起的滚动选择器
// https://developers.weixin.qq.com/miniprogram/dev/component/picker.html

import { triggerEvent, useInfo } from '@/common/events'
import PickerColumn from './PickerColumn.vue'

const props = defineProps({
	/**
	 * 选择器的标题
	 */
	headerText: {
		type: String,
	},
	/**
	 * 选择器类型
	 */
	mode: {
		type: String,
		default: 'selector',
		validator: (value) => {
			return ['selector', 'multiSelector', 'time', 'date', 'region'].includes(value)
		},
	},
	/**
	 * 是否禁用
	 */
	disabled: {
		type: Boolean,
		default: false,
	},
	// 普通选择器：mode = selector, 多列选择器：mode = multiSelector
	/**
	 * mode 为 selector 或 multiSelector 时，range 有效
	 */
	range: {
		type: [Array, Object],
		default: () => [],
	},
	/**
	 * 当 range 是一个 Object Array 时，通过 range-key 来指定 Object 中 key 的值作为选择器显示内容
	 */
	rangeKey: {
		type: String,
	},
	// 时间选择器：mode = time, 日期选择器：mode = date
	/**
	 * 表示有效时间范围的开始，字符串格式为"hh:mm"
	 * 表示有效日期范围的开始，字符串格式为"YYYY-MM-DD"
	 */
	start: {
		type: String,
	},
	/**
	 * 表示有效时间范围的结束，字符串格式为"hh:mm"
	 * 表示有效日期范围的结束，字符串格式为"YYYY-MM-DD"
	 */
	end: {
		type: String,
	},
	/**
	 * 有效值 year,month,day，表示选择器的粒度
	 */
	fields: {
		type: String,
		default: 'day',
		validator: (value) => {
			return ['year', 'month', 'day'].includes(value)
		},
	},
	/**
	 * 表示选择了 range 中的第几个（下标从 0 开始）
	 */
	value: {
		type: [Number, String, Array],
		default: (props) => {
			switch (props.mode) {
				case 'selector':
					return 0
				case 'multiSelector':
					return []
				case 'time': {
					const now = new Date()
					const hours = String(now.getHours()).padStart(2, '0')
					const minutes = String(now.getMinutes()).padStart(2, '0')
					return `${hours}:${minutes}`
				}
				case 'date': {
					const now = new Date()
					const year = now.getFullYear()
					const month = String(now.getMonth() + 1).padStart(2, '0') // 月份是从0开始的，所以需要加1
					const day = String(now.getDate()).padStart(2, '0') // getDate()返回的是1-31的数字
					return `${year}-${month}-${day}`
				}
			}
		},
	},
	customItem: {
		type: String,
		default: '',
	},
	level: {
		type: String,
		default: '',
	},
	name: {
		type: String,
	},
	autoFill: {
		type: String,
	},
})


// 响应式数据
const showPicker = ref(false)
const currentValue = ref(props.value)
const tempValue = ref(props.value)
// 多列选择器的列值缓存，使用对象存储避免数组响应式问题
const columnValues = ref({})

// 监听value变化
watch(() => props.value, (newVal) => {
	currentValue.value = newVal
	tempValue.value = newVal
})

// 初始化tempValue，确保多列选择器有正确的初始值
watch(() => props.mode, () => {
	if (props.mode === 'multiSelector' && (!Array.isArray(tempValue.value) || tempValue.value.length === 0)) {
		tempValue.value = props.range.map(() => 0)
		// 使用对象存储每列的值
		const values = {}
		tempValue.value.forEach((val, idx) => {
			values[idx] = val
		})
		columnValues.value = values
	}
}, { immediate: true })

// 点击触发选择器显示
const handleTriggerClick = () => {
	if (props.disabled) return
	if (props.mode === 'region') {
		triggerEvent('error', {
			info,
			detail: { errMsg: 'picker:fail region mode is not supported by the current container' },
		})
		return
	}
	showPicker.value = true
	
	// 确保多列选择器有正确的初始值
	if (props.mode === 'multiSelector') {
		if (!Array.isArray(currentValue.value) || currentValue.value.length === 0) {
			tempValue.value = props.range.map(() => 0)
		} else {
			tempValue.value = [...currentValue.value]
		}
		// 使用对象存储每列的值
		const values = {}
		tempValue.value.forEach((val, idx) => {
			values[idx] = val
		})
		columnValues.value = values
	} else {
		tempValue.value = currentValue.value
	}
}

// 取消选择
const handleCancel = (event) => {
	showPicker.value = false

	triggerEvent('cancel', {
			event,
			info,
			detail: {},
		})
}

const info = useInfo()
// 确认选择
const handleConfirm = (event) => {
	currentValue.value = tempValue.value
	collectFormValue?.(props.name, currentValue.value)
	showPicker.value = false
	triggerEvent('change', {
			event,
			info,
			detail: {
				value: tempValue.value
			},
		})
}

const collectFormValue = inject('collectFormValue', undefined)
const registerFormControl = inject('registerFormControl', undefined)
watch(currentValue, value => collectFormValue?.(props.name, value), { deep: true, immediate: true })
const unregisterFormControl = registerFormControl?.({
	getName: () => props.name,
	getValue: () => currentValue.value,
	reset: () => {
		currentValue.value = props.mode === 'selector' ? -1 : ''
		tempValue.value = currentValue.value
		collectFormValue?.(props.name, currentValue.value)
	},
})
onBeforeUnmount(() => unregisterFormControl?.())

// 遮罩层点击
const handleMaskClick = () => {
	handleCancel()
}

// 阻止事件冒泡
const stopPropagation = (e) => {
	e.stopPropagation()
}

// 计算显示的选项数据
const displayOptions = computed(() => {
	switch (props.mode) {
		case 'selector':
			return getDisplayRange(props.range)
		case 'multiSelector':
			return props.range.map(column => getDisplayRange(column))
		case 'time':
			return getTimeOptions()
		case 'date':
			return getDateOptions()
		default:
			return []
	}
})

// 获取显示范围
const getDisplayRange = (range) => {
	// 处理类数组对象（对象的key是数字索引，框架可能会把数组转换成这种格式）
	if (!Array.isArray(range) && typeof range === 'object' && range !== null) {
		return Object.values(range)
	}
	
	if (!Array.isArray(range)) {
		return []
	}
	
	// 处理对象数组
	if (range.length > 0 && typeof range[0] === 'object') {
		if (props.rangeKey) {
			return range.map(item => item[props.rangeKey] || '')
		}
		// 没有rangeKey时，尝试使用常见的key
		return range.map(item => {
			return item.name || item.label || item.text || item.value || String(item)
		})
	}
	
	return range
}

// 获取时间选项
const getTimeOptions = () => {
	const hours = []
	const minutes = []
	
	for (let i = 0; i < 24; i++) {
		hours.push(String(i).padStart(2, '0'))
	}
	
	for (let i = 0; i < 60; i++) {
		minutes.push(String(i).padStart(2, '0'))
	}
	
	return [hours, minutes]
}

// 获取日期选项
const getDateOptions = () => {
	const years = []
	const months = []
	const days = []
	
	const currentYear = new Date().getFullYear()
	const startYear = props.start ? Number.parseInt(props.start.split('-')[0]) : currentYear - 10
	const endYear = props.end ? Number.parseInt(props.end.split('-')[0]) : currentYear + 10
	
	for (let i = startYear; i <= endYear; i++) {
		years.push(String(i))
	}
	
	for (let i = 1; i <= 12; i++) {
		months.push(String(i).padStart(2, '0'))
	}
	
	for (let i = 1; i <= 31; i++) {
		days.push(String(i).padStart(2, '0'))
	}
	
	switch (props.fields) {
		case 'year':
			return [years]
		case 'month':
			return [years, months]
		default:
			return [years, months, days]
	}
}


// 处理列变化（多列选择器）
const handleColumnChange = (event, columnIndex, value) => {
	if (props.mode === 'multiSelector' && columnValues.value[columnIndex] !== value) {
		// 更新对象属性
		columnValues.value[columnIndex] = value
		
		// 同步到tempValue用于最终提交
		const tempArray = []
		for (let i = 0; i < props.range.length; i++) {
			tempArray[i] = columnValues.value[i] || 0
		}
		tempValue.value = tempArray
		
		triggerEvent('columnchange', {
			event,
			info,
			detail: {
				column: columnIndex,
				value: value
			}
		})
	}
}

// 处理单列变化
const handleSingleChange = (_event, value) => {
	if (props.mode === 'selector') {
		tempValue.value = value
	}
}

// 获取时间值
const getTimeValue = (index) => {
	if (typeof tempValue.value === 'string' && tempValue.value.includes(':')) {
		const parts = tempValue.value.split(':')
		if (index === 0) return Number.parseInt(parts[0]) || 0
		if (index === 1) return Number.parseInt(parts[1]) || 0
	}
	return 0
}

// 处理时间变化
const handleTimeChange = (_event, index, value) => {
	const parts = tempValue.value.split(':')
	if (index === 0) {
		parts[0] = displayOptions.value[0][value]
	} else if (index === 1) {
		parts[1] = displayOptions.value[1][value]
	}
	tempValue.value = parts.join(':')
}

// 获取日期值
const getDateValue = (index) => {
	if (typeof tempValue.value === 'string') {
		const parts = tempValue.value.split('-')
		if (index === 0 && parts[0]) return displayOptions.value[0].indexOf(parts[0])
		if (index === 1 && parts[1]) return displayOptions.value[1].indexOf(parts[1])
		if (index === 2 && parts[2]) return displayOptions.value[2].indexOf(parts[2])
	}
	return 0
}

// 处理日期变化
const handleDateChange = (_event, index, value) => {
	const parts = tempValue.value.split('-')
	if (index === 0) {
		parts[0] = displayOptions.value[0][value]
	} else if (index === 1) {
		parts[1] = displayOptions.value[1][value]
	} else if (index === 2) {
		parts[2] = displayOptions.value[2][value]
	}
	
	if (props.fields === 'year') {
		tempValue.value = parts[0]
	} else if (props.fields === 'month') {
		tempValue.value = `${parts[0]}-${parts[1]}`
	} else {
		tempValue.value = parts.join('-')
	}
}
</script>

<template>
	<div v-bind="$attrs" class="dd-picker" @click="handleTriggerClick">
		<slot />
	</div>
	
	<!-- 选择器弹窗 -->
	<div v-if="showPicker" class="dd-picker-overlay" @click="handleMaskClick">
		<div class="dd-picker-container" @click="stopPropagation">
			<!-- 标题栏 -->
			<div class="dd-picker-header">
				<div class="dd-picker-action dd-picker-cancel" @click="handleCancel">取消</div>
				<div class="dd-picker-title">{{ headerText || '' }}</div>
				<div class="dd-picker-action dd-picker-confirm" @click="handleConfirm">确定</div>
			</div>
			
			<!-- 选择器内容 -->
			<div class="dd-picker-body">
				<!-- 普通选择器 -->
				<template v-if="mode === 'selector'">
					<PickerColumn
						:options="displayOptions"
						:value="tempValue"
						@change="handleSingleChange"
					/>
				</template>
				
				<!-- 多列选择器 -->
				<template v-else-if="mode === 'multiSelector'">
					<div class="dd-picker-columns">
						<PickerColumn
							v-for="(column, index) in displayOptions"
							:key="`column-${index}`"
							:options="column"
							:value="columnValues[index] ?? 0"
							@change="(event, value) => handleColumnChange(event, index, value)"
						/>
					</div>
				</template>
				
				<!-- 时间选择器 -->
				<template v-else-if="mode === 'time'">
					<div class="dd-picker-columns">
						<PickerColumn
							v-for="(column, index) in displayOptions"
							:key="index"
							:options="column"
							:value="getTimeValue(index)"
							@change="(event, value) => handleTimeChange(event, index, value)"
						/>
					</div>
				</template>
				
				<!-- 日期选择器 -->
				<template v-else-if="mode === 'date'">
					<div class="dd-picker-columns">
						<PickerColumn
							v-for="(column, index) in displayOptions"
							:key="index"
							:options="column"
							:value="getDateValue(index)"
							@change="(event, value) => handleDateChange(event, index, value)"
						/>
					</div>
				</template>
				
			</div>
		</div>
	</div>
</template>

<style lang="scss">
.dd-picker {
	display: block;
	cursor: pointer;

	&[hidden] {
		display: none;
	}
}

// 选择器弹窗样式
.dd-picker-overlay {
	position: fixed;
	top: 0;
	left: 0;
	right: 0;
	bottom: 0;
	background-color: rgba(0, 0, 0, 0.6);
	z-index: 1000;
	display: flex;
	align-items: flex-end;
	animation: fadeIn 0.3s ease;
}

.dd-picker-container {
	width: 100%;
	background-color: #ffffff;
	border-radius: 12px 12px 0 0;
	max-height: 80vh;
	animation: slideUp 0.3s ease;
}

.dd-picker-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 16px 20px;
	border-bottom: 1px solid #e5e5e5;
	background-color: #fafafa;
	border-radius: 12px 12px 0 0;
}

.dd-picker-action {
	font-size: 16px;
	cursor: pointer;
	padding: 4px 8px;
	border-radius: 4px;
	transition: background-color 0.2s ease;
	
	&:hover {
		background-color: rgba(0, 0, 0, 0.05);
	}
}

.dd-picker-cancel {
	color: #999999;
}

.dd-picker-confirm {
	color: #09bb07;
	font-weight: 500;
}

.dd-picker-title {
	font-size: 16px;
	font-weight: 500;
	color: #333333;
}

.dd-picker-body {
	padding: 20px 0;
	background-color: #ffffff;
}

.dd-picker-columns {
	display: flex;
	align-items: center;
	gap: 0;
}

// 动画效果
@keyframes fadeIn {
	from {
		opacity: 0;
	}
	to {
		opacity: 1;
	}
}

@keyframes slideUp {
	from {
		transform: translateY(100%);
	}
	to {
		transform: translateY(0);
	}
}
</style>
