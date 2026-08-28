Page({
	onShareAppMessage() {
		return {
			title: 'checkbox',
			path: 'page/component/pages/checkbox/checkbox'
		}
	},

	data: {
		items: [
			{ value: 'USA', name: '美国' },
			{ value: 'CHN', name: '中国', checked: 'true' },
			{ value: 'BRA', name: '巴西' },
			{ value: 'JPN', name: '日本' },
			{ value: 'ENG', name: '英国' },
			{ value: 'FRA', name: '法国' }
		]
	},

	checkboxChange(e) {
		console.log('checkbox发生change事件，携带value值为：', e.detail.value)
	}
})