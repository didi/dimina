<script setup>
// 用于展示微信开放数据。
// https://developers.weixin.qq.com/miniprogram/dev/component/open-data.html

import { invokeAPIWithCallback, triggerEvent, useInfo } from '@/common/events'

const props = defineProps({
	type: { type: String, default: '' },
	openGid: { type: String, default: '' },
	lang: { type: String, default: 'en' },
	defaultText: { type: String, default: '' },
	defaultAvatar: { type: String, default: '' },
	keyList: { type: Array, default: () => [] },
})

const info = useInfo()
const displayText = ref('')
const avatarUrl = ref('')
let requestVersion = 0

function showFallback(errMsg) {
	avatarUrl.value = props.type === 'userAvatarUrl' ? props.defaultAvatar : ''
	displayText.value = avatarUrl.value ? '' : props.defaultText
	triggerEvent('error', { info, detail: { errMsg } })
}

function renderUserInfo(userInfo) {
	const field = props.type.replace(/^user/, '')
	const key = field ? field[0].toLowerCase() + field.slice(1) : ''
	const value = userInfo?.[key]
	if (!value) {
		showFallback(`${props.type} is empty.`)
		return
	}
	if (key === 'avatarUrl') {
		avatarUrl.value = value
		displayText.value = ''
	}
	else if (key === 'gender') {
		const genderText = {
			en: ['', 'Male', 'Female'],
			zh_CN: ['', '男', '女'],
			zh_TW: ['', '男', '女'],
		}
		displayText.value = genderText[props.lang]?.[value] || ''
	}
	else {
		displayText.value = String(value)
	}
}

function requestData() {
	const version = ++requestVersion
	avatarUrl.value = ''
	displayText.value = ''
	if (!props.type) return

	let apiName
	let params = {}
	if (props.type === 'groupName') {
		apiName = 'getGroupInfoByGId'
		params = { openGId: props.openGid }
	}
	else if (props.type.startsWith('user')) {
		apiName = 'getUserInfo'
		params = { lang: props.lang }
	}
	else if (props.type.endsWith('CloudStorage')) {
		apiName = `get${props.type[0].toUpperCase()}${props.type.slice(1)}`
		params = { keyList: props.keyList }
	}
	else {
		showFallback(`${props.type} is not supported.`)
		return
	}

	invokeAPIWithCallback(apiName, {
		bridgeId: info.bridgeId,
		params,
		success: (result = {}) => {
			if (version !== requestVersion) return
			if (props.type === 'groupName') {
				displayText.value = result.roomTopic || props.defaultText
				if (!result.roomTopic) triggerEvent('error', { info, detail: { errMsg: 'groupName is empty.' } })
				triggerEvent('getgroupname', { info, detail: result })
			}
			else if (props.type.startsWith('user')) {
				renderUserInfo(result.userInfo || result)
			}
			else {
				// Cloud storage normally renders through a generic component supplied by
				// the host. Preserve the data for custom styling and show the fallback
				// text when this host has no such renderer.
				displayText.value = props.defaultText
			}
		},
		fail: (error = {}) => {
			if (version === requestVersion) showFallback(error.errMsg || `${apiName}:fail`)
		},
	})
}

watch(
	() => [props.type, props.openGid, props.lang, props.defaultText, props.defaultAvatar, props.keyList],
	requestData,
	{ deep: true, immediate: true },
)

onBeforeUnmount(() => {
	requestVersion++
})
</script>

<template>
	<span v-bind="$attrs" class="dd-open-data">
		<img v-if="avatarUrl" :src="avatarUrl" alt="" class="dd-open-data-avatar">
		<template v-else>{{ displayText }}</template>
	</span>
</template>

<style lang="scss">
.dd-open-data[hidden] {
	display: none;
}

.dd-open-data-avatar {
	display: block;
	width: 100%;
	height: 100%;
}
</style>
