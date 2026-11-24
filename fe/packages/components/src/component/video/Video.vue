<script setup>
// 视频
// https://developers.weixin.qq.com/miniprogram/dev/component/video.html
import { onEvent, triggerEvent, useInfo } from '@/common/events'

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
		default: 0,
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
		default: -1,
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
	unitId: {
		type: String,
		default: '',
	},
	adPlayTime: {
		type: Number,
		default: 0,
	},
	danmuBtn: {
		type: Boolean,
		default: false,
	},
	enableDanmu: {
		type: Boolean,
		default: false,
	},
	danmuList: {
		type: Array,
		default: () => [],
	},
	live: {
		type: [Number, Boolean],
		default: false,
	},
	customCache: {
		type: Boolean,
		default: true,
	},
	blockSize: {
		type: Number,
		default: 0,
	},
	posterForCrawler: {
		type: String,
		default: '',
	},
	showLiveBtn: {
		type: Boolean,
		default: true,
	},
	showBottomProgress: {
		type: Boolean,
		default: true,
	},
	showCenterProgressDuration: {
		type: Boolean,
		default: false,
	},
	showVolumeBtn: {
		type: Boolean,
		default: false,
	},
	showCastingButton: {
		type: Boolean,
		default: false,
	},
	seekType: {
		type: String,
		default: 'accurate',
	},
	pictureInPictureMode: {
		type: [Array, String],
		default: '',
	},
	pictureInPictureShowProgress: {
		type: Boolean,
		default: false,
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
	isDrm: {
		type: Boolean,
		default: false,
	},
	provisionUrl: {
		type: String,
		default: '',
	},
	certificateUrl: {
		type: String,
		default: '',
	},
	licenseUrl: {
		type: String,
		default: '',
	},
	preferredPeakBitRate: {
		type: Number,
		default: -1,
	},
})

const root = ref()
const video = ref()
const info = useInfo()
const controlsVisible = ref(true)
const playing = ref(false)
const position = ref(0)
const mediaDuration = ref(0)
const muted = ref(props.muted)
const duration = computed(() => mediaDuration.value || props.duration)
let pendingSeek
let offVideoContext

function resolveMediaSource(source) {
	if (!source) return undefined
	if (/^(?:https?:|blob:|data:|resource:|\/\/)/i.test(source)) return source
	const bridge = window.DiminaRenderBridge
	const resourcePath = window.__diminaLocalMediaUrl || bridge?.localMediaUrl
	const prefix = typeof resourcePath === 'function' ? bridge.localMediaUrl() : resourcePath
	if (!prefix) return source

	// Let each native host resolve its own package and virtual file paths.
	return `${prefix}?source=${encodeURIComponent(source)}`
}

const source = computed(() => resolveMediaSource(props.src))
const poster = computed(() => resolveMediaSource(props.poster || props.posterForCrawler))

function emitVideoEvent(type, event, detail = {}) {
	triggerEvent(type, {
		event,
		info,
		currentTarget: root.value,
		detail: type === 'timeupdate' ? detail : { id: props.id, src: props.src, ...detail },
	})
}

function play() {
	const element = video.value
	const playbackSource = source.value
	element?.play()?.catch((error) => {
		if (error?.name !== 'AbortError' && video.value === element && source.value === playbackSource) {
			emitVideoEvent('error', undefined, { errMsg: error?.message || 'video play failed' })
		}
	})
}

function togglePlayback() {
	if (video.value.paused) play()
	else video.value.pause()
}

function seek(time) {
	const target = Math.max(0, Number(time) || 0)
	if (video.value.readyState === 0) {
		pendingSeek = target
		return
	}
	video.value.currentTime = target
}

function requestFullscreen(direction = props.direction) {
	const element = root.value
	if (document.fullscreenEnabled && element.requestFullscreen) {
		element.requestFullscreen().then(() => {
			const orientation = { 0: 'portrait', 90: 'landscape-primary', '-90': 'landscape-secondary' }[Number(direction)]
			if (orientation) return screen.orientation?.lock?.(orientation)
		}, () => video.value?.webkitEnterFullscreen?.()).catch(() => {})
	} else {
		video.value.webkitEnterFullscreen?.()
	}
}

function exitFullscreen() {
	if (document.fullscreenElement === root.value) document.exitFullscreen?.()
	else if (video.value.webkitDisplayingFullscreen) video.value.webkitExitFullscreen?.()
}

function handleFullscreenChange(event) {
	emitVideoEvent('fullscreenchange', event, {
		fullScreen: event.type === 'webkitbeginfullscreen' || document.fullscreenElement === root.value,
		direction: props.direction,
	})
}

function handleVideoContext(msg) {
	const element = video.value
	if (!element || msg.id !== props.id || (msg.moduleId && msg.moduleId !== info.moduleId)) return
	switch (msg.command) {
		case 'play':
			play()
			break
		case 'pause':
			element.pause()
			break
		case 'stop':
			element.pause()
			seek(0)
			break
		case 'seek':
			seek(msg.position)
			break
		case 'playbackRate':
			element.playbackRate = Number(msg.rate) || 1
			break
		case 'requestFullScreen':
			requestFullscreen(msg.direction)
			break
		case 'exitFullScreen':
			exitFullscreen()
			break
		case 'exitPictureInPicture':
			if (document.pictureInPictureElement === element) document.exitPictureInPicture?.()
			break
		default:
			break
	}
}

function handleLoadedMetadata(event) {
	const element = event.target
	mediaDuration.value = Number.isFinite(element.duration) ? element.duration : 0
	const start = pendingSeek ?? props.initialTime
	pendingSeek = undefined
	if (start > 0) seek(mediaDuration.value ? Math.min(start, mediaDuration.value) : start)
	emitVideoEvent('loadedmetadata', event, {
		width: element.videoWidth,
		height: element.videoHeight,
		duration: mediaDuration.value,
	})
}

function handleTimeUpdate(event) {
	position.value = event.target.currentTime
	emitVideoEvent('timeupdate', event, {
		currentTime: position.value,
		duration: duration.value,
	})
}

function handleProgress(event) {
	const buffered = event.target.buffered
	emitVideoEvent('progress', event, {
		buffered: buffered.length ? buffered.end(buffered.length - 1) : 0,
		duration: duration.value,
	})
}

function handlePlaybackChange(event) {
	playing.value = event.type === 'play'
	emitVideoEvent(event.type, event)
}

function handleVideoClick() {
	if (props.controls) controlsVisible.value = !controlsVisible.value
}

function formatTime(seconds) {
	const elapsed = Math.floor(seconds)
	const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0')
	const remainder = (elapsed % 60).toString().padStart(2, '0')
	return `${minutes}:${remainder}`
}

watch(() => props.controls, (visible) => {
	if (visible) controlsVisible.value = true
})
watch(() => props.muted, (value) => { muted.value = value })
watch(source, () => {
	pendingSeek = undefined
	position.value = 0
	mediaDuration.value = 0
	playing.value = false
}, { flush: 'sync' })

onMounted(() => { offVideoContext = onEvent('videoContext', handleVideoContext) })
onBeforeUnmount(() => {
	offVideoContext?.()
	if (video.value && !video.value.paused) video.value.pause()
})
</script>

<template>
	<div
		:id="id"
		ref="root"
		v-bind="$attrs"
		class="dd-video"
		@fullscreenchange.self="handleFullscreenChange"
	>
		<video
			ref="video"
			class="dd-video-media"
			:src="source"
			:autoplay="autoplay"
			:loop="loop"
			:muted="muted"
			:poster="poster"
			:referrerpolicy="referrerPolicy"
			playsinline
			webkit-playsinline
			:style="{ objectFit }"
			@click="handleVideoClick"
			@dblclick="enablePlayGesture && togglePlayback()"
			@play="handlePlaybackChange"
			@pause="handlePlaybackChange"
			@ended="handlePlaybackChange"
			@waiting="emitVideoEvent('waiting', $event)"
			@error="emitVideoEvent('error', $event, { errMsg: $event.target.error?.message || 'video error' })"
			@loadstart="emitVideoEvent('loadstart', $event)"
			@loadeddata="emitVideoEvent('loadeddata', $event)"
			@loadedmetadata="handleLoadedMetadata"
			@progress="handleProgress"
			@seeking="emitVideoEvent('seeking', $event, { currentTime: $event.target.currentTime })"
			@seeked="emitVideoEvent('seeked', $event, { currentTime: $event.target.currentTime })"
			@webkitbeginfullscreen="handleFullscreenChange"
			@webkitendfullscreen="handleFullscreenChange"
			@enterpictureinpicture="emitVideoEvent('enterpictureinpicture', $event)"
			@leavepictureinpicture="emitVideoEvent('leavepictureinpicture', $event)"
			@timeupdate="handleTimeUpdate"
		/>
		<template v-if="controls && controlsVisible">
			<button
				v-if="showCenterPlayBtn && !playing"
				type="button"
				class="dd-video-control dd-video-center"
				aria-label="播放"
				@click.stop="play"
			>
				<span class="dd-video-play-icon" aria-hidden="true" />
			</button>
			<div class="dd-video-controls" @click.stop>
				<button
					v-if="showPlayBtn"
					type="button"
					class="dd-video-control"
					:aria-label="playing ? '暂停' : '播放'"
					@click="togglePlayback"
				>
					<span :class="playing ? 'dd-video-pause-icon' : 'dd-video-play-icon'" aria-hidden="true" />
				</button>
				<template v-if="showProgress">
					<input
						class="dd-video-seek"
						type="range"
						min="0"
						:max="duration || 1"
						step="0.01"
						:value="position"
						:disabled="!duration"
						aria-label="播放进度"
						@input="seek($event.target.value)"
					>
					<span class="dd-video-time">{{ formatTime(position) }}/{{ formatTime(duration) }}</span>
				</template>
				<button
					v-if="showMuteBtn"
					type="button"
					class="dd-video-control"
					:aria-label="muted ? '取消静音' : '静音'"
					@click="muted = !muted"
				>
					{{ muted ? '×' : '♪' }}
				</button>
				<button
					v-if="showFullscreenBtn"
					type="button"
					class="dd-video-control"
					aria-label="全屏"
					@click="requestFullscreen()"
				>
					<span aria-hidden="true">⛶</span>
				</button>
			</div>
		</template>
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
	background: #000;

	&[hidden] {
		display: none;
	}
}

.dd-video-media {
	display: block;
	width: 100%;
	height: 100%;
}

.dd-video-controls {
	position: absolute;
	inset: auto 0 0;
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 44px;
	padding: 0 8px;
	color: #fff;
	background: rgb(0 0 0 / 43%);
}

.dd-video-control {
	display: grid;
	place-items: center;
	flex: 0 0 32px;
	width: 32px;
	height: 32px;
	padding: 0;
	border: 0;
	color: inherit;
	background: transparent;
	font: inherit;
	cursor: pointer;
}

.dd-video-center {
	position: absolute;
	top: 50%;
	left: 50%;
	width: 56px;
	height: 56px;
	transform: translate(-50%, -50%);
	border-radius: 50%;
	color: #fff;
	background: rgb(0 0 0 / 47%);
}

.dd-video-play-icon {
	display: block;
	width: 0;
	height: 0;
	border-block: 6px solid transparent;
	border-left: 10px solid currentColor;
}

.dd-video-pause-icon {
	display: block;
	width: 10px;
	height: 12px;
	box-sizing: border-box;
	border-inline: 3px solid currentColor;
}

.dd-video-seek {
	flex: 1;
	min-width: 0;
	margin: 0;
	accent-color: #fff;
}

.dd-video-time {
	font: 12px/1 monospace;
	white-space: nowrap;
}
</style>
