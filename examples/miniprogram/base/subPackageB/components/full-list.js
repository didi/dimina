Component({
  properties: {
    items: Array
  },
  methods: {
    show(e) {
      wx.showModal({
        content: e.currentTarget.dataset.content || ''
      })
    }
  }
})