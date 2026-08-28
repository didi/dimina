Page({
  data: {
    isConnected: false,
  },
  onLoad: function () {
    var that = this
    wx.onNetworkStatusChange(function (res) {
      that.setData({
        isConnected: res.isConnected,
        networkType: res.networkType
      })
    })
  },
  onShow: function () {
    var that = this
    wx.getNetworkType({
      success: function (res) {
        that.setData({
          isConnected: res.networkType !== 'none',
          networkType: res.networkType
        })
      }
    })
  }
})
