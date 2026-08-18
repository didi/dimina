<script setup>
// 用来改进表单组件的可用性
// 使用for属性找到对应的id，或者将控件放在该标签下，当点击时，就会触发对应的控件。
// for优先级高于内部控件，内部有多个控件的时候默认触发第一个控件。
// 目前可以绑定的控件有：button, checkbox, radio, switch, input。
// https://developers.weixin.qq.com/miniprogram/dev/component/label.html

const props = defineProps({
	/**
	 * 绑定控件的 id
	 */
	for: {
		type: String,
	},
})

const labelRef = ref(null)
const targetSelector = '[data-dd-label-target], input, textarea'

function isLabelTarget(element) {
	return element instanceof Element && Boolean(element.closest(targetSelector))
}

function findTarget() {
	if (props.for) {
		return document.getElementById(props.for)
	}
	return labelRef.value?.querySelector(targetSelector)
}

function handleClick(event) {
	// A tap originating from a control must not activate it a second time.
	if (isLabelTarget(event.target)) {
		return
	}

	const target = findTarget()
	if (!target || target === labelRef.value) {
		return
	}

	// Native label activation already handles actual form elements referenced by for.
	if (props.for && target.matches('input, textarea, button, select')) {
		return
	}

	event.preventDefault()
	target.click()
	if (target.matches('input, textarea')) {
		target.focus()
	}
}
</script>

<template>
	<label ref="labelRef" v-bind="$attrs" :for="props.for" @click="handleClick">
		<slot />
	</label>
</template>
