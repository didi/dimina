<script setup>
// 按钮
// https://developers.weixin.qq.com/miniprogram/dev/component/button.html
// https://github.com/Tencent/weui/blob/master/src/example/button/button_default.html

import { invokeAPIWithCallback, triggerEvent, useInfo } from '@/common/events'
import { useHover } from '@/common/useHover'

const props = defineProps({
	/**
	 * id，为 label 使用
	 */
	id: {
		type: String,
	},
	/**
	 * 按钮的大小
	 * 合法值 default, mini
	 */
	size: {
		type: String,
		default: 'default',
		validator: (value) => {
			return ['default', 'mini'].includes(value)
		},
	},
	/**
	 * 按钮的样式类型
	 * 合法值 primary default warn
	 */
	type: {
		type: String,
		default: 'default',
		validator: (value) => {
			return ['primary', 'default', 'warn'].includes(value)
		},
	},
	/**
	 * 按钮是否镂空，背景色透明
	 */
	plain: {
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
	 * 名称前是否带 loading 图标
	 */
	loading: {
		type: Boolean,
	},
	/**
	 * 用于 form 组件，点击分别会触发 form 组件的 submit/reset 事件
	 * 合法值 submit, reset
	 */
	formType: {
		type: String,
		validator: (value) => {
			return ['submit', 'reset'].includes(value)
		},
	},
	/**
	 * 开放能力，暂不实现
	 */
	openType: {
		type: String,
		validator: (value) => {
			return [
				'contact',
				'liveActivity',
				'share',
				'getPhoneNumber',
				'getRealtimePhoneNumber',
				'getUserInfo',
				'launchApp',
				'openSetting',
				'feedback',
				'chooseAvatar',
				'agreePrivacyAuthorization',
			].includes(value)
		},
	},
	appParameter: { type: String, default: '' },
	launchAppid: { type: String, default: '' },
	withCredentials: { type: Boolean, default: true },
	lang: { type: String, default: 'en' },
	sessionFrom: { type: String, default: 'wxapp' },
	businessId: { type: String, default: '' },
	sendMessageTitle: { type: String, default: '' },
	sendMessagePath: { type: String, default: '' },
	sendMessageImg: { type: String, default: '' },
	showMessageCard: { type: Boolean, default: false },
	categoryId: { type: Array, default: () => [] },
	needPhoneNumber: { type: Boolean, default: false },
	native: { type: Boolean, default: false },
	phoneNumber: { type: String, default: '' },
	smsType: { type: Number, default: 0 },
	/**
	 * 指定按钮按下去的样式类。当 hover-class="none" 时，没有点击态效果
	 */
	hoverClass: {
		type: String,
		default: 'button-hover',
	},
	hover: {
		type: Boolean,
		default: false,
	},
	/**
	 * 指定是否阻止本节点的祖先节点出现点击态
	 */
	hoverStopPropagation: {
		type: Boolean,
		default: false,
	},
	/**
	 * 按住后多久出现点击态，单位毫秒
	 */
	hoverStartTime: {
		type: Number,
		default: 20,
	},
	/**
	 * 手指松开后点击态保留时间，单位毫秒
	 */
	hoverStayTime: {
		type: Number,
		default: 70,
	},
})

// const emit = defineEmits(['form-event'])

const plainParsed = computed(() => {
	return Boolean(props.plain) === true ? true : undefined
})

const disabledParsed = computed(() => {
	return Boolean(props.disabled) === true ? true : undefined
})

const loadingParsed = computed(() => {
	return Boolean(props.loading) === true ? true : undefined
})

const { isHover, onHoverCancel, onHoverEnd, onHoverStart } = useHover(props)
const info = useInfo()
const handleFormEvent = inject('formEvent', undefined)
function handleClicked(event) {
	if (!props.disabled) {
		if (props.formType) {
			handleFormEvent?.(event, props.formType)
		}
		else {
			triggerEvent('tap', { event, info })
			handleOpenType(event)
		}
	}
}

function invokeOpenTypeAPI(apiName, eventName, event, params = {}) {
	const preservedEvent = { ...event, currentTarget: event.currentTarget, target: event.target }
	invokeAPIWithCallback(apiName, {
		bridgeId: info.bridgeId,
		params,
		success: (result = {}) => triggerEvent(eventName, { event: preservedEvent, info, detail: result }),
		fail: (result = {}) => triggerEvent(eventName, { event: preservedEvent, info, detail: result }),
	})
}

function handleOpenType(event) {
	switch (props.openType) {
		case 'openSetting':
			invokeOpenTypeAPI('openSetting', 'opensetting', event)
			break
		case 'getUserInfo':
			invokeOpenTypeAPI('getUserInfo', 'getuserinfo', event, {
				lang: props.lang,
				withCredentials: props.withCredentials,
			})
			break
	}
}

</script>

<template>
	<span
		:id="id" v-bind="$attrs" class="dd-button" data-dd-label-target role="button" :tabindex="disabled ? -1 : 0"
		:aria-disabled="disabled" :type="type" :size="size" :loading="loadingParsed"
		:plain="plainParsed" :disabled="disabledParsed" :class="[
			`dd-button--${type}`,
			size === 'mini' && 'dd-button--mini',
			plainParsed && 'dd-button--plain',
			disabledParsed && 'dd-button--disabled',
			loadingParsed && 'dd-button--loading',
			isHover ? hoverClass : undefined,
		]"
		@click="handleClicked"
		@keydown.enter.prevent="handleClicked" @keydown.space.prevent="handleClicked"
		@touchstart="onHoverStart" @touchend="onHoverEnd" @touchcancel="onHoverCancel"
		@mousedown="onHoverStart" @mouseup="onHoverEnd" @mouseleave="onHoverCancel"
	>
		<slot />
	</span>
</template>

<style lang="scss">
.dd-button {
	position: relative;
	display: block;
	margin-left: auto;
	margin-right: auto;
	padding-left: 14px;
	padding-right: 14px;
	box-sizing: border-box;
	font-size: 18px;
	text-align: center;
	text-decoration: none;
	line-height: 2.55555556;
	border-radius: 5px;
	-webkit-tap-highlight-color: transparent;
	overflow: hidden;
	color: #000000;
	background-color: #f8f8f8;

	&[hidden] {
		display: none;
	}
}

.dd-button:after {
	content: ' ';
	width: 200%;
	height: 200%;
	position: absolute;
	top: 0;
	left: 0;
	border: 1px solid rgba(0, 0, 0, 0.2);
	transform: scale(0.5);
	transform-origin: 0 0;
	box-sizing: border-box;
	border-radius: 10px;
}
.dd-button[native] {
	padding-left: 0;
	padding-right: 0;
}
.dd-button[native] .dd-button-cover-view-wrapper {
	border: inherit;
	border-color: inherit;
	border-radius: inherit;
	background-color: inherit;
}
.dd-button[native] .dd-button-cover-view-inner {
	padding-left: 14px;
	padding-right: 14px;
}
.dd-button .dd-cover-view {
	line-height: inherit;
	white-space: inherit;
}
.dd-button--default {
	color: #000000;
	background-color: #f8f8f8;
}
.dd-button--primary {
	color: #ffffff;
	background-color: #1aad19;
}
.dd-button--warn {
	color: #ffffff;
	background-color: #e64340;
}
.dd-button--disabled {
	color: rgba(255, 255, 255, 0.6);
}
.dd-button--disabled.dd-button--default {
	color: rgba(0, 0, 0, 0.3);
	background-color: #f7f7f7;
}
.dd-button--disabled.dd-button--primary {
	background-color: #9ed99d;
}
.dd-button--disabled.dd-button--warn {
	background-color: #ec8b89;
}
.dd-button--primary.dd-button--plain {
	color: #1aad19;
	border: 1px solid #1aad19;
	background-color: transparent;
}
.dd-button--primary.dd-button--plain.dd-button--disabled {
	color: rgba(0, 0, 0, 0.2);
	border-color: rgba(0, 0, 0, 0.2);
}
.dd-button--primary.dd-button--plain:after {
	border-width: 0;
}
.dd-button--default.dd-button--plain {
	color: #353535;
	border: 1px solid #353535;
	background-color: transparent;
}
.dd-button--default.dd-button--plain.dd-button--disabled {
	color: rgba(0, 0, 0, 0.2);
	border-color: rgba(0, 0, 0, 0.2);
}
.dd-button--default.dd-button--plain:after {
	border-width: 0;
}
.dd-button--plain {
	color: #353535;
	border: 1px solid #353535;
	background-color: transparent;
}
.dd-button--plain.dd-button--disabled {
	color: rgba(0, 0, 0, 0.2);
	border-color: rgba(0, 0, 0, 0.2);
}
.dd-button--plain:after {
	border-width: 0;
}
.dd-button--plain[native] .dd-button-cover-view-inner {
	padding: 0;
}
.dd-button--warn.dd-button--plain {
	color: #e64340;
	border: 1px solid #e64340;
	background-color: transparent;
}
.dd-button--warn.dd-button--plain.dd-button--disabled {
	color: rgba(0, 0, 0, 0.2);
	border-color: rgba(0, 0, 0, 0.2);
}
.dd-button--warn.dd-button--plain:after {
	border-width: 0;
}
.dd-button--mini {
	display: inline-block;
	line-height: 2.3;
	font-size: 13px;
	padding: 0 1.34em;
}
.dd-button--mini[native] {
	padding: 0;
}
.dd-button--mini[native] .dd-button-cover-view-inner {
	padding: 0 1.34em;
}
.dd-button--loading:before {
	content: ' ';
	display: inline-block;
	width: 18px;
	height: 18px;
	vertical-align: middle;
	animation: dd-button-loading-animate 1s steps(12, end) infinite;
	background: transparent
		url(data:image/svg+xml;base64,PHN2ZyBjbGFzcz0iciIgd2lkdGg9JzEyMHB4JyBoZWlnaHQ9JzEyMHB4JyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj4KICAgIDxyZWN0IHg9IjAiIHk9IjAiIHdpZHRoPSIxMDAiIGhlaWdodD0iMTAwIiBmaWxsPSJub25lIiBjbGFzcz0iYmsiPjwvcmVjdD4KICAgIDxyZWN0IHg9JzQ2LjUnIHk9JzQwJyB3aWR0aD0nNycgaGVpZ2h0PScyMCcgcng9JzUnIHJ5PSc1JyBmaWxsPScjRTlFOUU5JwogICAgICAgICAgdHJhbnNmb3JtPSdyb3RhdGUoMCA1MCA1MCkgdHJhbnNsYXRlKDAgLTMwKSc+CiAgICA8L3JlY3Q+CiAgICA8cmVjdCB4PSc0Ni41JyB5PSc0MCcgd2lkdGg9JzcnIGhlaWdodD0nMjAnIHJ4PSc1JyByeT0nNScgZmlsbD0nIzk4OTY5NycKICAgICAgICAgIHRyYW5zZm9ybT0ncm90YXRlKDMwIDUwIDUwKSB0cmFuc2xhdGUoMCAtMzApJz4KICAgICAgICAgICAgICAgICByZXBlYXRDb3VudD0naW5kZWZpbml0ZScvPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyM5Qjk5OUEnCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSg2MCA1MCA1MCkgdHJhbnNsYXRlKDAgLTMwKSc+CiAgICAgICAgICAgICAgICAgcmVwZWF0Q291bnQ9J2luZGVmaW5pdGUnLz4KICAgIDwvcmVjdD4KICAgIDxyZWN0IHg9JzQ2LjUnIHk9JzQwJyB3aWR0aD0nNycgaGVpZ2h0PScyMCcgcng9JzUnIHJ5PSc1JyBmaWxsPScjQTNBMUEyJwogICAgICAgICAgdHJhbnNmb3JtPSdyb3RhdGUoOTAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNBQkE5QUEnCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgxMjAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNCMkIyQjInCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgxNTAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNCQUI4QjknCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgxODAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNDMkMwQzEnCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgyMTAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNDQkNCQ0InCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgyNDAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNEMkQyRDInCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgyNzAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNEQURBREEnCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgzMDAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0PgogICAgPHJlY3QgeD0nNDYuNScgeT0nNDAnIHdpZHRoPSc3JyBoZWlnaHQ9JzIwJyByeD0nNScgcnk9JzUnIGZpbGw9JyNFMkUyRTInCiAgICAgICAgICB0cmFuc2Zvcm09J3JvdGF0ZSgzMzAgNTAgNTApIHRyYW5zbGF0ZSgwIC0zMCknPgogICAgPC9yZWN0Pgo8L3N2Zz4=)
		no-repeat;
	background-size: 100%;
}
.dd-button--loading.dd-button--primary {
	color: rgba(255, 255, 255, 0.6);
	background-color: #179b16;
}
.dd-button--loading.dd-button--primary.dd-button--plain {
	color: #1aad19;
	background-color: transparent;
}
.dd-button--loading.dd-button--default {
	color: rgba(0, 0, 0, 0.6);
	background-color: #dedede;
}
.dd-button--loading.dd-button--default.dd-button--plain {
	color: #353535;
	background-color: transparent;
}
.dd-button--loading.dd-button--warn {
	color: rgba(255, 255, 255, 0.6);
	background-color: #ce3c39;
}
.dd-button--loading.dd-button--warn.dd-button--plain {
	color: #e64340;
	background-color: transparent;
}
.dd-button--loading[native]:before {
	content: none;
}
@keyframes dd-button-loading-animate {
	0% {
		transform: rotate3d(0, 0, 1, 0deg);
	}
	100% {
		transform: rotate3d(0, 0, 1, 360deg);
	}
}
.button-hover {
	color: rgba(0, 0, 0, 0.6);
	background-color: #dedede;
}
.button-hover.dd-button--plain {
	color: rgba(53, 53, 53, 0.6);
	border-color: rgba(53, 53, 53, 0.6);
	background-color: transparent;
}
.button-hover.dd-button--primary {
	color: rgba(255, 255, 255, 0.6);
	background-color: #179b16;
}
.button-hover.dd-button--primary.dd-button--plain {
	color: rgba(26, 173, 25, 0.6);
	border-color: rgba(26, 173, 25, 0.6);
	background-color: transparent;
}
.button-hover.dd-button--default {
	color: rgba(0, 0, 0, 0.6);
	background-color: #dedede;
}
.button-hover.dd-button--default.dd-button--plain {
	color: rgba(53, 53, 53, 0.6);
	border-color: rgba(53, 53, 53, 0.6);
	background-color: transparent;
}
.button-hover.dd-button--warn {
	color: rgba(255, 255, 255, 0.6);
	background-color: #ce3c39;
}
.button-hover.dd-button--warn.dd-button--plain {
	color: rgba(230, 67, 64, 0.6);
	border-color: rgba(230, 67, 64, 0.6);
	background-color: transparent;
}
</style>
