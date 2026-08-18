<script setup>
import { triggerEvent, useInfo } from '@/common/events'

// 进度条。组件属性的长度单位默认为px
// https://developers.weixin.qq.com/miniprogram/dev/component/progress.html

const props = defineProps({
	/**
	 * 百分比0~100
	 */
	percent: {
		type: [Number, String],
		required: false,
	},
	/**
	 * 在进度条右侧显示百分比
	 */
	showInfo: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * 圆角大小
	 */
	borderRadius: {
		type: [Number, String],
		default: 0,
		required: false,
	},
	/**
	 * 右侧百分比字体大小
	 */
	fontSize: {
		type: [Number, String],
		default: 16,
		required: false,
	},
	/**
	 * 进度条线的宽度
	 */
	strokeWidth: {
		type: [Number, String],
		default: 6,
		required: false,
	},
	/**
	 * 进度条颜色
	 * @deprecated 请使用activeColor属性
	 */
	color: {
		type: String,
		default: '#09BB07',
		required: false,
	},
	/**
	 * 已选择的进度条的颜色
	 */
	activeColor: {
		type: String,
		default: '#09BB07',
		required: false,
	},
	/**
	 * 未选择的进度条的颜色
	 */
	backgroundColor: {
		type: String,
		default: '#EBEBEB',
		required: false,
	},
	/**
	 * 进度条从左往右的动画
	 */
	active: {
		type: Boolean,
		default: false,
		required: false,
	},
	/**
	 * backwards: 动画从头播；forwards：动画从上次结束点接着播
	 */
	activeMode: {
		type: String,
		default: 'backwards',
		required: false,
	},
	/**
	 * 进度增加1%所需毫秒数
	 */
	duration: {
		type: Number,
		default: 30,
		required: false,
	},
})

const info = useInfo()
const currentPercent = ref(0)
let animationTimer
let previousTarget = 0

function normalizePercent(value) {
	const number = Number(value)
	return Number.isFinite(number) ? Math.min(Math.max(number, 0), 100) : 0
}

function clearAnimation() {
	if (animationTimer !== undefined) {
		clearInterval(animationTimer)
		animationTimer = undefined
	}
}

function runAnimation() {
	clearAnimation()
	const target = normalizePercent(props.percent)
	if (!props.active) {
		currentPercent.value = target
		previousTarget = target
		return
	}

	currentPercent.value = props.activeMode === 'forwards' ? previousTarget : 0
	const tick = () => {
		if (target <= currentPercent.value + 1) {
			currentPercent.value = target
			previousTarget = target
			clearAnimation()
			triggerEvent('activeend', {
				info,
				detail: { curPercent: currentPercent.value },
			})
			return
		}
		currentPercent.value += 1
	}

	tick()
	if (currentPercent.value < target) {
		animationTimer = setInterval(tick, Math.max(Number(props.duration) || 0, 0))
	}
}

watch(
	[() => props.percent, () => props.active, () => props.activeMode, () => props.duration],
	runAnimation,
	{ immediate: true },
)
onBeforeUnmount(clearAnimation)

const progressColor = computed(() => {
	const attrs = info.attrs || {}
	if ('activeColor' in attrs || 'active-color' in attrs) return props.activeColor
	if ('color' in attrs) return props.color
	return props.activeColor
})
</script>

<template>
<div
	v-bind="$attrs" class="dd-progress" role="progressbar"
	:aria-valuenow="currentPercent" aria-valuemin="0" aria-valuemax="100"
>
		<div
			class="dd-progress-bar" aria-label="" :aria-valuenow="`${percent}%`" :style="{
				borderRadius: `${borderRadius}px`,
				backgroundColor,
				height: `${strokeWidth}px`,
			}"
		>
			<div
				class="dd-progress-inner-bar"
				:style="{ width: `${currentPercent}%`, backgroundColor: progressColor }"
			/>
		</div>
		<p class="dd-progress-info" :style="{ fontSize }" :hidden="!showInfo">
			{{ currentPercent }}%
		</p>
	</div>
</template>

<style lang="scss">
.dd-progress {
	display: flex;
	align-items: center;

	&[hidden] {
		display: none;
	}

	.dd-progress-bar {
		flex: 1;
		overflow: hidden;
	}

	.dd-progress-inner-bar {
		width: 0;
		height: 100%;
	}

	.dd-progress-info {
		margin-top: 0;
		margin-bottom: 0;
		min-width: 2em;
		margin-left: 15px;
		font-size: 16px;
	}
}
</style>
