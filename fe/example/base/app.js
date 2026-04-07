App({
	onLaunch(options) {
		console.log("app onLaunch===this.globalData=", this.globalData)
		// 修改 globalData 以测试
		this.globalData = 'I am modified global data'
	},
	onShow(options) {
		console.log("app onShow===this.globalData=", this.globalData) // 这里不应该是undefined

	},
	onHide() {
		console.log("app onHide===this.globalData=", this.globalData)
	},
	onError(msg) {
		console.log(msg)
	},
	globalData: 'I am global data'
})