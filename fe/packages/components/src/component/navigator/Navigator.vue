<script setup>
// https://developers.weixin.qq.com/miniprogram/dev/component/navigator.html

import { parsePath } from '@dimina/common'
import { invokeAPIWithCallback, triggerEvent, useInfo } from '@/common/events'
import { useHover } from '@/common/useHover'
import { useTouchEvents } from '@/common/useTouchEvents'

const props = defineProps({
	/**
	 * 在哪个目标上发生跳转，默认当前小程序
	 * 合法值 self|miniProgram
	 */
	target: {
		type: String,
		default: 'self',
	},
	url: {
		type: String,
	},
	redirect: {
		type: Boolean,
		default: false,
	},
	/**
	 * 跳转方式
	 * 合法值: navigate, redirect, switchTab, reLaunch, navigateBack, exit
	 */
	openType: {
		type: String,
		default: 'navigate',
	},
	/**
	 * 当 open-type 为 'navigateBack' 时有效，表示回退的层数
	 */
	delta: {
		type: Number,
		default: 1,
	},
	/**
	 * 当target="miniProgram"且open-type="navigate"时有效，要打开的小程序 appId
	 */
	appId: {
		type: String,
	},
	// 当target="miniProgram"且open-type="navigate"时有效，打开的页面路径，如果为空则打开首页
	path: {
		type: String,
	},
	// 当target="miniProgram"且open-type="navigate/navigateBack"时有效，需要传递给目标小程序的数据，目标小程序可在 App.onLaunch()，App.onShow() 中获取到这份数据
	extraData: {
		type: Object,
	},
	/**
	 * 当target="miniProgram"且open-type="navigate"时有效，要打开的小程序版本
	 * 合法值 develop|trial|release
	 */
	version: {
		type: String,
		default: 'release',
	},
	/**
	 * 当target="miniProgram"时有效，当传递该参数后，可以不传 app-id 和 path。链接可以通过【小程序菜单】->【复制链接】获取。
	 */
	shortLink: {
		type: String,
	},
	scene: {
		type: Number,
		default: 1037,
	},
	sceneNote: {
		type: String,
		default: '',
	},
	/**
	 * 指定点击时的样式类，当hover-class="none"时，没有点击态效果
	 */
	hoverClass: {
		type: String,
		default: 'navigator-hover',
	},
	hover: {
		type: Boolean,
		default: true,
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
		default: 50,
	},
	/**
	 * 手指松开后点击态保留时间，单位毫秒
	 */
	hoverStayTime: {
		type: Number,
		default: 600,
	},
})

const { isHover, onHoverCancel, onHoverEnd, onHoverStart } = useHover(props)

const info = useInfo()
function invokeNavigationAPI(apiName, params, event) {
	const preservedEvent = { ...event, currentTarget: event.currentTarget, target: event.target }
	invokeAPIWithCallback(apiName, {
		bridgeId: info.bridgeId,
		params,
		success: (result = {}) => triggerEvent('success', { event: preservedEvent, info, detail: result }),
		fail: (result = {}) => triggerEvent('fail', { event: preservedEvent, info, detail: result }),
		complete: (result = {}) => triggerEvent('complete', { event: preservedEvent, info, detail: result }),
	})
}

function navigate(event) {
	const { openType, target, url, redirect } = props
	if (url?.includes('javascript:')) {
		return
	}
	if (redirect) {
		invokeNavigationAPI('redirectTo', { url: parsePath(info.path, url) }, event)
		return
	}
	if (target === 'miniProgram') {
		if (openType === 'navigate') {
			invokeNavigationAPI('navigateToMiniProgram', {
				appId: props.appId,
				path: props.path,
				shortLink: props.shortLink,
				extraData: props.extraData,
				envVersion: props.version,
				scene: props.scene,
				sceneNote: props.sceneNote,
			}, event)
		}
		else if (openType === 'navigateBack') {
			invokeNavigationAPI('navigateBackMiniProgram', { extraData: props.extraData }, event)
		}
		else if (openType === 'exit') {
			invokeNavigationAPI('exitMiniProgram', {}, event)
		}
		return
	}

	switch (openType) {
		case 'navigate': {
			invokeNavigationAPI('navigateTo', { url: parsePath(info.path, url) }, event)
			break
		}
		case 'redirect': {
			invokeNavigationAPI('redirectTo', { url: parsePath(info.path, url) }, event)
			break
		}
		case 'switchTab': {
			invokeNavigationAPI('switchTab', { url: parsePath(info.path, url) }, event)
			break
		}
		case 'reLaunch': {
			invokeNavigationAPI('reLaunch', { url: parsePath(info.path, url) }, event)
			break
		}
		case 'navigateBack': {
			invokeNavigationAPI('navigateBack', { delta: props.delta }, event)
			break
		}
		case 'exit':
			break
	}
}

const rootRef = ref(null)
function handleTap({ event }) {
	triggerEvent('tap', { event, info })
	navigate(event)
}

function handleKeyboard() {
	rootRef.value?.click()
}

useTouchEvents(info, rootRef, { tapHandler: handleTap })
</script>

<template>
	<span
		ref="rootRef" v-bind="$attrs" class="dd-navigator" role="link" tabindex="0" :class="[isHover ? hoverClass : undefined]"
		@keydown.enter.prevent="handleKeyboard"
		@touchstart="onHoverStart" @touchend="onHoverEnd" @touchcancel="onHoverCancel"
		@mousedown="onHoverStart" @mouseup="onHoverEnd" @mouseleave="onHoverCancel"
	>
		<slot />
	</span>
</template>

<style lang="scss">
.dd-navigator {
	height: auto;
	width: auto;
	display: block;

	&.navigator-hover {
		background-color: rgba(0, 0, 0, 0.1);
		opacity: 0.7;
	}

	&[hidden] {
		display: none;
	}
}
</style>
