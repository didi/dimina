Page({
  data: {
    enabled: true,
    direction: 0
  },
  onReady: function () {
    var that = this
    wx.onCompassChange(function (res) {
      that.setData({
        direction: parseInt(res.direction)
      })
    })
  },
  startCompass: function () {
    if (this.data.enabled) {
      return
    }
    var that = this
    wx.startCompass({
      success: function () {
        that.setData({
          enabled: true
        })
      }
    })
  },
  stopCompass: function () {
    if (!this.data.enabled) {
      return
    }
    var that = this
    wx.stopCompass({
      success: function () {
        that.setData({
          enabled: false
        })
      }
    })
  }
})
