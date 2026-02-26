// api/openminiapp/openminiapp.js
Page({

  /**
   * 页面的初始数据
   */
  data: {

  },

  /**
   * 生命周期函数--监听页面加载
   */
  onLoad(options) {

  },

  /**
   * 生命周期函数--监听页面初次渲染完成
   */
  onReady() {

  },

  /**
   * 生命周期函数--监听页面显示
   */
  onShow() {

  },

  /**
   * 生命周期函数--监听页面隐藏
   */
  onHide() {

  },

  /**
   * 生命周期函数--监听页面卸载
   */
  onUnload() {

  },

  /**
   * 页面相关事件处理函数--监听用户下拉动作
   */
  onPullDownRefresh() {

  },

  /**
   * 页面上拉触底事件的处理函数
   */
  onReachBottom() {

  },

  /**
   * 用户点击右上角分享
   */
  onShareAppMessage() {

  },

  /**
   * 点击按钮打开另一个小程序的核心函数
   */
  openAnotherMiniProgram() {
    wx.navigateToMiniProgram({
      // 【必填】目标小程序的appid（替换为真实值）
      appId: 'wxc77007cc301be278',
      // 【可选】要打开的目标小程序页面路径（不传则打开首页）
      // 格式：pages/xxx/xxx?参数1=值1&参数2=值2
      path: 'pages/index/index?from=我的小程序&userId=123',
      // 【可选】传递给目标小程序的自定义数据
      extraData: {
        source: 'demoMiniProgram',
        timestamp: Date.now()
      },
      // 【可选】目标小程序版本（默认release正式版）
      // develop：开发版；trial：体验版；release：正式版
      envVersion: 'release',
      // 成功回调
      success(res) {
        console.log('打开小程序成功', res);
        wx.showToast({
          title: '打开成功',
          icon: 'success'
        });
      },
      // 失败回调（比如白名单配置错误、appid错误等）
      fail(err) {
        console.error('打开小程序失败', err);
        wx.showToast({
          title: '打开失败：' + err.errMsg,
          icon: 'none',
          duration: 3000
        });
      },
      // 完成回调（无论成功/失败都会执行）
      complete() {
        console.log('打开小程序操作完成');
      }
    });
  }




})