Page({
  navigate() {
    wx.navigateTo({
      url: '/subPackageA/pages/index',
      complete: console.info
    })
  }
})