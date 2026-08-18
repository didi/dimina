<script setup>
// 图标组件
// https://developers.weixin.qq.com/miniprogram/dev/component/icon.html
// https://github.com/Tencent/weui/blob/master/src/example/icons/icons.html

import { transformRpx } from '@dimina/common'

const props = defineProps({
	/**
	 * icon的类型
	 * 合法值 success, success_no_circle, info, warn, waiting, cancel,
	 * download, search, clear, circle
	 */
	type: {
		type: String,
		required: true,
	},
	/**
	 * icon的大小，单位默认为px，支持传入单位(rpx/px/rem)
	 */
	size: {
		type: [Number, String],
		default: 23,
	},
	/**
	 * icon的颜色，同css的color
	 */
	color: {
		type: String,
	},
})

const iClass = computed(() => {
	switch (props.type) {
		case 'success':
			return 'dd-icon-success'
		case 'success_circle':
			return 'dd-icon-success_circle'
		case 'success_no_circle':
			return 'dd-icon-success_no_circle'
		case 'info':
			return 'dd-icon-info'
		case 'info_circle':
			return 'dd-icon-info_circle'
		case 'warn':
			return 'dd-icon-warn'
		case 'waiting':
			return 'dd-icon-waiting'
		case 'cancel':
			return 'dd-icon-cancel'
		case 'download':
			return 'dd-icon-download'
		case 'search':
			return 'dd-icon-search'
		case 'clear':
			return 'dd-icon-clear'
		case 'circle':
			return 'dd-icon-circle'
		default:
			return 'dd-icon-success'
	}
})

const iTitle = computed(() => {
	switch (props.type) {
		case 'success':
		case 'success_circle':
		case 'success_no_circle':
			return '成功'
		case 'info':
		case 'info_circle':
			return '信息'
		case 'warn':
			return '警告'
		case 'waiting':
			return '等待'
		case 'cancel':
			return '取消'
		case 'download':
			return '下载'
		case 'search':
			return '搜索'
		case 'clear':
			return '清除'
		case 'circle':
			return '空选'
		default:
			return '成功'
	}
})

const unit = /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|vw|vh|%)$/
const iSize = computed(() => {
	let size
	if (!props.size) {
		size = '23px'
	}
	else {
		size = transformRpx(props.size)
	}
	if (!unit.test(size)) {
		size += 'px'
	}
	return size
})

const iColor = computed(() => {
	return props.color || 'initial'
})
</script>

<template>
	<i v-bind="$attrs" :title="iTitle" class="dd-icon" :class="iClass" />
</template>

<style lang="scss">
.dd-icon {
	display: inline-block;
	font: normal normal normal 14px/1 'weui';
	font-size: v-bind('iSize');
	color: v-bind('iColor')

	&[hidden] {
		display: none;
	}
}

[class^='dd-icon-']:before,
[class*='dd-icon-']:before {
	margin: 0;
}
.dd-icon-success {
	color: #09bb07;
}
.dd-icon-success:before {
	content: '\EA06';
}
.dd-icon-info {
	color: #10aeff;
}
.dd-icon-info:before {
	content: '\EA03';
}
.dd-icon-warn {
	color: #f76260;
}
.dd-icon-warn:before {
	content: '\EA0B';
}
.dd-icon-waiting {
	color: #10aeff;
}
.dd-icon-waiting:before {
	content: '\EA09';
}
.dd-icon-safe_success {
	color: #09bb07;
}
.dd-icon-safe_success:before {
	content: '\EA04';
}
.dd-icon-safe_warn {
	color: #ffbe00;
}
.dd-icon-safe_warn:before {
	content: '\EA05';
}
.dd-icon-success_circle {
	color: #09bb07;
}
.dd-icon-success_circle:before {
	content: '\EA07';
}
.dd-icon-success_no_circle {
	color: #09bb07;
}
.dd-icon-success_no_circle:before {
	content: '\EA08';
}
.dd-icon-waiting_circle {
	color: #10aeff;
}
.dd-icon-waiting_circle:before {
	content: '\EA0A';
}
.dd-icon-circle {
	color: #c9c9c9;
}
.dd-icon-circle:before {
	content: '\EA01';
}
.dd-icon-download {
	color: #09bb07;
}
.dd-icon-download:before {
	content: '\EA02';
}
.dd-icon-info_circle {
	color: #09bb07;
}
.dd-icon-info_circle:before {
	content: '\EA0C';
}
.dd-icon-cancel {
	color: #f43530;
}
.dd-icon-cancel:before {
	content: '\EA0D';
}
.dd-icon-search {
	color: #b2b2b2;
}
.dd-icon-search:before {
	content: '\EA0E';
}
.dd-icon-clear {
	color: #b2b2b2;
}
.dd-icon-clear:before {
	content: '\EA0F';
}
[class^='dd-icon-']:before,
[class*='dd-icon-']:before {
	box-sizing: border-box;
}
</style>
