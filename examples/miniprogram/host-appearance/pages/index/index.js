Page({
  data: { top: 0, rightInset: 0, barHeight: 44 },

  onLoad() {
    this.updateNavigation()
  },

  onResize() {
    this.updateNavigation()
  },

  updateNavigation() {
    const windowInfo = wx.getWindowInfo() || {}
    const capsule = wx.getMenuButtonBoundingClientRect() || {}
    const top = Math.max(windowInfo.statusBarHeight || 0, windowInfo.safeArea?.top || 0)
    const rightInset = capsule.width && windowInfo.windowWidth
      ? Math.max(0, windowInfo.windowWidth - capsule.left)
      : 0
    const barHeight = Math.max(44, (capsule.bottom || 0) - top + Math.max(0, (capsule.top || 0) - top))
    this.setData({ top, rightInset, barHeight })
  },

  close() {
    wx.exitMiniProgram({
      fail: () => wx.showToast({ title: '暂时无法退出', icon: 'none' }),
    })
  },
})
