const app = getApp()

Page({
	data: {

	},
	onLoad: function () {
		console.log('代码片段是一种迷你、可分享的小程序或小游戏项目，可用于分享小程序和小游戏的开发经验、展示组件和 API 的使用、复现开发问题和 Bug 等。可点击以下链接查看代码片段的详细文档：')
		console.log('https://mp.weixin.qq.com/debug/wxadoc/dev/devtools/devtools.html')
		
		// 测试 globalData
		console.log('Page onLoad - app.globalData:', app.globalData)
		
		// 修改 globalData
		app.globalData = 'Modified by page'
		console.log('Page onLoad - after modify:', app.globalData)
	},
	onShow: function() {
		// 再次读取 globalData
		console.log('Page onShow - app.globalData:', app.globalData)
	}
})
