<script setup>
// 视频
// https://developers.weixin.qq.com/miniprogram/dev/component/video.html
import { isAndroid, isDesktop, isHarmonyOS, isIOS } from '@dimina/common'
import { invokeAPI, onEvent, triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	/**
	 * 组件 id
	 */
	id: {
		type: String,
		default: () => `video-${Math.random().toString(36).slice(2, 10)}`,
	},
	/**
	 * 要播放视频的资源地址，支持网络路径、本地临时路径
	 */
	src: {
		type: String,
		default: '',
	},
	/**
	 * 指定视频时长
	 */
	duration: {
		type: Number,
		required: false,
	},
	/**
	 * 是否显示默认播放控件（播放/暂停按钮、播放进度、时间）
	 */
	controls: {
		type: Boolean,
		required: false,
		default: true,
	},
	autoplay: {
		type: Boolean,
		default: false,
	},
	loop: {
		type: Boolean,
		default: false,
	},
	muted: {
		type: Boolean,
		default: false,
	},
	initialTime: {
		type: Number,
		default: 0,
	},
	objectFit: {
		type: String,
		default: 'contain',
	},
	poster: {
		type: String,
		default: '',
	},
	pageGesture: {
		type: Boolean,
		default: false,
	},
	direction: {
		type: [Number, String],
	},
	showProgress: {
		type: Boolean,
		default: true,
	},
	showFullscreenBtn: {
		type: Boolean,
		default: true,
	},
	showPlayBtn: {
		type: Boolean,
		default: true,
	},
	showCenterPlayBtn: {
		type: Boolean,
		default: true,
	},
	enableProgressGesture: {
		type: Boolean,
		default: true,
	},
	showMuteBtn: {
		type: Boolean,
		default: false,
	},
	title: {
		type: String,
		default: '',
	},
	playBtnPosition: {
		type: String,
		default: 'bottom',
	},
	enablePlayGesture: {
		type: Boolean,
		default: false,
	},
	autoPauseIfNavigate: {
		type: Boolean,
		default: true,
	},
	autoPauseIfOpenNative: {
		type: Boolean,
		default: true,
	},
	vslideGesture: {
		type: Boolean,
		default: false,
	},
	vslideGestureInFullscreen: {
		type: Boolean,
		default: true,
	},
	adUnitId: {
		type: String,
		default: '',
	},
	pictureInPictureMode: {
		type: [Array, String],
		default: () => [],
	},
	enableAutoRotation: {
		type: Boolean,
		default: false,
	},
	showScreenLockButton: {
		type: Boolean,
		default: false,
	},
	showSnapshotButton: {
		type: Boolean,
		default: false,
	},
	showBackgroundPlaybackButton: {
		type: Boolean,
		default: false,
	},
	backgroundPoster: {
		type: String,
		default: '',
	},
	referrerPolicy: {
		type: String,
		default: 'no-referrer',
	},
})

const rootRef = ref()
const info = useInfo()
const type = 'native/video'
const isNativeVideo = computed(() => isAndroid || isIOS || isHarmonyOS)
let syncFrameId = 0
let lastRectKey = ''
const nativeEventOffs = []
let resizeObserver

function getRect() {
	const element = rootRef.value
	if (!element) {
		return {}
	}
	const rect = element.getBoundingClientRect()
	return {
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
		pageLeft: rect.left + window.scrollX,
		pageTop: rect.top + window.scrollY,
		scrollX: window.scrollX,
		scrollY: window.scrollY,
		viewportWidth: window.innerWidth,
		viewportHeight: window.innerHeight,
	}
}

function getNativeParams() {
	return {
		type,
		id: props.id,
		src: props.src,
		controls: props.controls,
		autoplay: props.autoplay,
		loop: props.loop,
		muted: props.muted,
		initialTime: props.initialTime,
		objectFit: props.objectFit,
		poster: props.poster,
		pageGesture: props.pageGesture,
		direction: props.direction,
		showProgress: props.showProgress,
		showFullscreenBtn: props.showFullscreenBtn,
		showPlayBtn: props.showPlayBtn,
		showCenterPlayBtn: props.showCenterPlayBtn,
		enableProgressGesture: props.enableProgressGesture,
		showMuteBtn: props.showMuteBtn,
		title: props.title,
		playBtnPosition: props.playBtnPosition,
		enablePlayGesture: props.enablePlayGesture,
		autoPauseIfNavigate: props.autoPauseIfNavigate,
		autoPauseIfOpenNative: props.autoPauseIfOpenNative,
		vslideGesture: props.vslideGesture,
		vslideGestureInFullscreen: props.vslideGestureInFullscreen,
		adUnitId: props.adUnitId,
		pictureInPictureMode: props.pictureInPictureMode,
		enableAutoRotation: props.enableAutoRotation,
		showScreenLockButton: props.showScreenLockButton,
		showSnapshotButton: props.showSnapshotButton,
		showBackgroundPlaybackButton: props.showBackgroundPlaybackButton,
		backgroundPoster: props.backgroundPoster,
		referrerPolicy: props.referrerPolicy,
		hidden: rootRef.value?.hasAttribute('hidden') || false,
		rect: getRect(),
	}
}

function invokeNative(apiName) {
	if (!isNativeVideo.value) {
		return
	}
	invokeAPI(apiName, {
		bridgeId: info.bridgeId,
		params: getNativeParams(),
	})
}

function syncRect(force = false) {
	const rectKey = JSON.stringify({
		...getRect(),
		hidden: rootRef.value?.hasAttribute('hidden') || false,
	})
	if (force || rectKey !== lastRectKey) {
		lastRectKey = rectKey
		invokeNative('propsUpdate')
	}
}

function scheduleSyncRect() {
	if (syncFrameId) {
		return
	}
	syncFrameId = requestAnimationFrame(() => {
		syncFrameId = 0
		syncRect()
	})
}

function bindNativeEvent(nativeEvent, eventType, detailFactory = msg => msg) {
	const off = onEvent(nativeEvent, (msg) => {
		if (msg.id !== props.id) {
			return
		}
		triggerEvent(eventType, {
			type: eventType,
			info,
			detail: detailFactory(msg),
		})
	})
	nativeEventOffs.push(off)
}

function executeWebVideoCommand(msg) {
	const video = rootRef.value
	if (!video || msg.id !== props.id) {
		return
	}

	switch (msg.command) {
		case 'play':
			video.play()?.catch((error) => {
				triggerEvent('error', {
					info,
					detail: {
						errMsg: error?.message || 'video play failed',
					},
				})
			})
			break
		case 'pause':
			video.pause()
			break
		case 'stop':
			video.pause()
			video.currentTime = 0
			break
		case 'seek':
			video.currentTime = Number(msg.position) || 0
			break
		case 'playbackRate':
			video.playbackRate = Number(msg.rate) || 1
			break
		case 'requestFullScreen':
			video.requestFullscreen?.() || video.webkitRequestFullscreen?.()
			break
		case 'exitFullScreen':
			document.exitFullscreen?.() || document.webkitExitFullscreen?.()
			break
		case 'exitPictureInPicture':
			document.pictureInPictureElement && document.exitPictureInPicture?.()
			break
		default:
			break
	}
}

function bindVideoContextEvent() {
	const off = onEvent('videoContext', (msg) => {
		if (msg.id !== props.id) {
			return
		}
		if (isNativeVideo.value) {
			invokeAPI('videoContext', {
				bridgeId: info.bridgeId,
				params: msg,
			})
			return
		}
		executeWebVideoCommand(msg)
	})
	nativeEventOffs.push(off)
}

function triggerVideoEvent(type, event, detail = {}) {
	triggerEvent(type, {
		event,
		info,
		detail,
	})
}

onMounted(() => {
	bindVideoContextEvent()

	if (!isAndroid) {
		if (isNativeVideo.value) {
			invokeNative('componentMount')
		}
		return
	}

	bindNativeEvent('bindplay', 'play')
	bindNativeEvent('bindpause', 'pause')
	bindNativeEvent('bindended', 'ended')
	bindNativeEvent('bindwaiting', 'waiting')
	bindNativeEvent('binderror', 'error')
	bindNativeEvent('bindloadedmetadata', 'loadedmetadata')
	bindNativeEvent('bindfullscreenchange', 'fullscreenchange')
	bindNativeEvent('bindprogress', 'progress')
	bindNativeEvent('bindcontrolstoggle', 'controlstoggle')
	bindNativeEvent('bindenterpictureinpicture', 'enterpictureinpicture')
	bindNativeEvent('bindleavepictureinpicture', 'leavepictureinpicture')
	bindNativeEvent('bindtimeupdate', 'timeupdate', msg => ({
		currentTime: msg.currentTime,
		duration: msg.duration,
	}))

	nextTick(() => {
		syncRect(true)
		invokeNative('componentMount')
		window.addEventListener('resize', scheduleSyncRect)
		if (window.ResizeObserver && rootRef.value) {
			resizeObserver = new ResizeObserver(scheduleSyncRect)
			resizeObserver.observe(rootRef.value)
		}
	})
})

watch(
	() => [
		props.src,
		props.controls,
		props.autoplay,
		props.loop,
		props.muted,
		props.initialTime,
		props.objectFit,
		props.poster,
		props.pageGesture,
		props.direction,
		props.showProgress,
		props.showFullscreenBtn,
		props.showPlayBtn,
		props.showCenterPlayBtn,
		props.enableProgressGesture,
		props.showMuteBtn,
		props.title,
		props.playBtnPosition,
		props.enablePlayGesture,
		props.autoPauseIfNavigate,
		props.autoPauseIfOpenNative,
		props.vslideGesture,
		props.vslideGestureInFullscreen,
		props.adUnitId,
		props.pictureInPictureMode,
		props.enableAutoRotation,
		props.showScreenLockButton,
		props.showSnapshotButton,
		props.showBackgroundPlaybackButton,
		props.backgroundPoster,
		props.referrerPolicy,
	],
	() => invokeNative('propsUpdate'),
)

onBeforeUnmount(() => {
	if (syncFrameId) {
		cancelAnimationFrame(syncFrameId)
	}
	resizeObserver?.disconnect()
	window.removeEventListener('resize', scheduleSyncRect)
	invokeNative('componentUnmount')
	nativeEventOffs.splice(0).forEach(off => off())
})
</script>

<template>
	<embed
		v-if="isAndroid"
		:id="id"
		ref="rootRef"
		width="300"
		height="225"
		v-bind="$attrs"
		class="dd-video"
		type="application/view"
		:comp_type="type"
	/>
	<div v-else-if="isIOS" v-bind="$attrs" class="dd-video">
		<div class="dd-video-container">
			<div style="width: 101%; height: 101%" />
		</div>
	</div>
	<embed
		v-else-if="isHarmonyOS"
		:id="id"
		v-bind="$attrs"
		class="dd-video"
		:type="type"
	/>
	<video
		v-else-if="isDesktop"
		:id="id"
		ref="rootRef"
		width="300"
		height="225"
		v-bind="$attrs"
		class="dd-video"
		:src="src"
		:controls="controls"
		:autoplay="autoplay"
		:loop="loop"
		:muted="muted"
		:poster="poster"
		:playsinline="true"
		:webkit-playsinline="true"
		:style="{ objectFit }"
		@play="triggerVideoEvent('play', $event)"
		@pause="triggerVideoEvent('pause', $event)"
		@ended="triggerVideoEvent('ended', $event)"
		@waiting="triggerVideoEvent('waiting', $event)"
		@error="triggerVideoEvent('error', $event, { errMsg: $event.target?.error?.message || 'video error' })"
		@loadedmetadata="triggerVideoEvent('loadedmetadata', $event, { duration: $event.target?.duration || 0 })"
		@timeupdate="triggerVideoEvent('timeupdate', $event, { currentTime: $event.target?.currentTime || 0, duration: $event.target?.duration || 0 })"
	/>
	<div v-else v-bind="$attrs" class="dd-video dd-video-placeholder">
		未实现组件
	</div>
</template>

<style lang="scss">
.dd-video {
	display: inline-block;
	position: relative;
	z-index: 0;
	overflow: hidden;
	width: 300px;
	height: 225px;
	line-height: 0;

	&[hidden] {
		display: none;
	}

	.dd-video-container {
		overflow: scroll;
		-webkit-overflow-scrolling: touch;
		width: 100%;
		height: 100%;
	}
}

.dd-video-placeholder {
	color: white;
	background-color: gray;
	display: flex;
	align-items: center;
	justify-content: center;
}
</style>
