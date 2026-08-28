// redirect.js navigator.js
Page({
	data: {
		title: ''
	},
	onLoad: function (options) {
		this.setData({
			title: options.title
		})
	}
})