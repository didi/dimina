const order = ['demo1', 'demo2', 'demo3']

Page({
	data: {
		toView: 'green'
	},

	upper(e) {
		console.log('upper', e.detail)
	},

	lower(e) {
		console.log('lower', e.detail)
	},

	scroll(e) {
		console.log('scroll', e.detail.deltaX, e.detail.deltaY)
	},

	scrollToTop() {
		this.setAction({
			scrollTop: 0
		})
	},

	tap() {
		for (let i = 0; i < order.length; ++i) {
			if (order[i] === this.data.toView) {
				this.setData({
					toView: order[i + 1],
					scrollTop: (i + 1) * 200
				})
				break
			}
		}
	},

	tapMove() {
		this.setData({
			scrollTop: this.data.scrollTop + 10
		})
	}
})