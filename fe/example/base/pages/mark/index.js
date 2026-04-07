const app = getApp()

Page({
	data: {
		myMarkValue: 'last',
		anotherMarkValue: 'leaf'
	},
	bindViewTap: function (e) {
		console.log('触发了 view 的 tap 事件，e.mark = ' + JSON.stringify(e.mark))
	},
	bindButtonTap: function (e) {
		console.log('触发了 button 的 tap 事件，e.mark = ' + JSON.stringify(e.mark))
	},
})
