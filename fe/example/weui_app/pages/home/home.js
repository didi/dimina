Page({
  data: {
    statusBarHeight: 0,
    navBarHeight: 0,
    safeHeight: 0,
    bottomSafeHeight: 0,
  },
  onLoad() {
    // 获取的数值单位是px
    const windowInfo = wx.getWindowInfo();
    const menuButtonInfo = wx.getMenuButtonBoundingClientRect();
    console.log(windowInfo);
    console.log(menuButtonInfo);

    let statusBarHeight = windowInfo.statusBarHeight;
    let navBarHeight =
      menuButtonInfo.height + (menuButtonInfo.top - statusBarHeight) * 2;
    let safeHeight = windowInfo.safeArea.height;
    let bottomSafeHeight =
      windowInfo.screenHeight - windowInfo.safeArea.height - statusBarHeight;
    this.setData({
      statusBarHeight,
      navBarHeight,
      safeHeight,
      bottomSafeHeight,
    });
    console.log("statusBarHeight", statusBarHeight);
    console.log("navBarHeight", navBarHeight);
    console.log("safeHeight", safeHeight);
    console.log("bottomSafeHeight", bottomSafeHeight);
  },
});


