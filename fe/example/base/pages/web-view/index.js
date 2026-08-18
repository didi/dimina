Page({
	data: {
		src: 'https://example.com/',
	},
	bindLoad(e) {
		console.log('web-view 加载成功', e.detail)
	},
	bindError(e) {
		console.error('web-view 加载失败', e.detail)
	},
	bindMessage(e) {
		console.log('web-view 收到消息', e.detail)
	},
})
