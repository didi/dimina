<script setup>
// 用来改进表单组件的可用性
// 使用for属性找到对应的id，或者将控件放在该标签下，当点击时，就会触发对应的控件。
// for优先级高于内部控件，内部有多个控件的时候默认触发第一个控件。
// 目前可以绑定的控件有：button, checkbox, radio, switch, input。
// https://developers.weixin.qq.com/miniprogram/dev/component/label.html

import { triggerEvent, useInfo } from '@/common/events'
import { activateLabelTarget, LABEL_TARGET_SELECTOR } from '@/common/labelActivation'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	/**
	 * 绑定控件的 id
	 */
	for: {
		type: String,
	},
})

const labelRef = ref(null)

function isLabelTarget(element) {
	if (!(element instanceof Element)) {
		return false
	}
	// 这个判断只看被点节点到 label 之间的这一段：label 外层若是个可激活控件
	// （button 包 label），它不参与判断，也就不会抑制 label 对内部控件的激活。
	const control = element.closest(LABEL_TARGET_SELECTOR)
	return Boolean(control && labelRef.value?.contains(control))
}

function findTarget() {
	if (props.for) {
		return document.getElementById(props.for)
	}
	return labelRef.value?.querySelector(LABEL_TARGET_SELECTOR)
}

function activateTarget(event) {
	// 直接点在控件自己身上时它已经响应过了，label 不再激活第二次
	if (isLabelTarget(event.target)) {
		return
	}

	const target = findTarget()
	if (!target || target === labelRef.value) {
		return
	}

	activateLabelTarget(target, event)
}

/**
 * 原生 <label> 会把 click 转发给内部或 for 指向的真实 input/textarea，
 * 转发出来的 click 会被手势层当成一次独立交互再合成一次 tap，
 * 并沿 DOM 冒泡把 tap 派给目标控件的祖先（for 指向远处时尤其明显）。
 * 激活已经由 activateTarget 显式完成，这里取消默认行为。
 */
function suppressNativeActivation(event) {
	event.preventDefault()
}

const info = useInfo()
function handleTap({ event }) {
	// 激活先于 label 自己的 tap 回调
	activateTarget(event)
	triggerEvent('tap', { event, info })
}

useTouchEvents(info, labelRef, { tapHandler: handleTap })
</script>

<template>
	<label ref="labelRef" v-bind="$attrs" :for="props.for" @click="suppressNativeActivation">
		<slot />
	</label>
</template>
