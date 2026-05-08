Page({
	onShareAppMessage() {
		return {
			title: 'movable-view',
			path: 'page/component/pages/movable-view/movable-view'
		}
	},

	data: {
		x: 0,
		y: 0,
		scale: 2,
		damping: 20, // 阻尼系数，用于控制回弹动画
		friction: 2, // 摩擦系数，用于控制惯性滑动
	},

	tap() {
		this.setData({
			x: 30,
			y: 30
		})
	},

	tap2() {
		this.setData({
			scale: 3
		})
	},

	onChange(e) {
		console.log(e.detail)
	},

	onScale(e) {
		console.log(e.detail)
	},

	// 调整阻尼系数
	adjustDamping() {
		const newDamping = this.data.damping === 20 ? 5 : 20
		this.setData({
			damping: newDamping
		})
	},

	// 调整摩擦系数
	adjustFriction() {
		const newFriction = this.data.friction === 2 ? 10 : 2
		this.setData({
			friction: newFriction
		})
	}
})