Component({
	data: {
		nothing: ''
	},
	methods: {
		selectIcon() {
			console.log('bar icon select')
			this.triggerEvent('selectIcon', {
				type: 'icon'
			})
		}
	},
	lifetimes: {
		created() {
		  console.log('123321 icon bar created')
		},
		ready() {
		  console.log('123321 icon bar ready')
		},
		attached() {
		  console.log('123321 icon bar attached')
		},
	  },
	  pageLifetimes: {
		show() {
		  console.log('123321 icon bar show')
		},
		hide() {
		  console.log('123321 icon bar hide')
		},
	  },
})
