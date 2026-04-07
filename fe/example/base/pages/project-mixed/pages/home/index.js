const { sum, uuid } = require('../../utils/util');

Page({
	data: {
		condition: 4,
		text: '跳转详情页',
		a: {
			b: {
				c: [{ text: 'nested data' }]
			}
		},
		res: 0,
		show: true,
		color: 'red',
		list: [
			{
				key: 'a',
				message: 'item1'
			},
			{
				key: 'b',
				message: 'item2'
			},
			{
				key: 'c',
				message: 'item3'
			}
		],
		imageList: 'https://dart.dev/assets/img/logo/logo-white-text.svg'
	},
	onLoad: function (options) {
		// 页面创建时执行
		console.log('page onLoad: ', options);
	},
	onShow: function () {
		// 页面出现在前台时执行
		console.log('page onShow');
	},
	onReady: function () {
		// 页面首次渲染完毕时执行
		console.log('page onReady');
	},
	onHide: function () {
		// 页面从前台变为后台时执行
		console.log('onHide');
	},
	onUnload: function () {
		// 页面销毁时执行
	},
	onPageScroll: function (opts) {
		// 页面滚动时执行
		console.log('scroll:', opts);
	},

	viewTap: function () {
		console.log('viewTap click');
	},

	hide() {
		this.setData({
			show: false
		});
	},

	show() {
		this.setData({
			show: true
		});
		this.setData({
			'a.b.c[0].text': this.data.a.b.c[0].text + '!'
		});
		console.log(this.data);
	},

	addItem() {
		this.setData({
			list: this.data.list.concat({
				key: uuid(),
				message: '新增列表项'
			})
		});
	},

	sumRes() {
		this.setData({
			res: sum(2, 3)
		});
	},

	changeColor() {
		this.setData({
			color: 'green'
		});
	},

	goDetail: function (opts) {
		dd.navigateTo({
			url: '/pages/project-mixed/pages/detail/index?a=1',
			success: function () {
				console.log('详情页跳转成功');
			}
		});
	},

	openComponents() {
		dd.navigateToMiniProgram({
			appId: 'playground',
			path: 'pages/index/index?id=123',
			extraData: {
				foo: 'bar'
			},
			envVersion: 'develop',
			success(res) {
				// 打开成功
			}
		});
	},

	showToast() {
		dd.showToast({
			title: 'I am title',
			icon: 'success',
			duration: 2000
		});
	},

	swiperChange(e) {
		console.log('change', e);
	}
});
