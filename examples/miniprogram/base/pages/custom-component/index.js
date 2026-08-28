// index.js
const defaultAvatarUrl = 'https://img-hxy021.didistatic.com/static/starimg/img/6rhqNI7RsG1705304735877.png'

Page({
  data: {
    motto: 'change title visible',
    userInfo: {
      avatarUrl: defaultAvatarUrl,
      nickName: '',
    },
    hasUserInfo: false,
    canIUseGetUserProfile: wx.canIUse('getUserProfile'),
    canIUseNicknameComp: wx.canIUse('input.type.nickname'),
    showTitle: true,
    showDynamicProbe: false,
  },
  onLoad() {
    console.log('[Lifecycle][Page:custom-component] onLoad')
  },
  onShow() {
    console.log('[Lifecycle][Page:custom-component] onShow')
  },
  onReady() {
    console.log('[Lifecycle][Page:custom-component] onReady')
  },
  onHide() {
    console.log('[Lifecycle][Page:custom-component] onHide')
  },
  onUnload() {
    console.log('[Lifecycle][Page:custom-component] onUnload')
  },
  onResize(size) {
    console.log('[Lifecycle][Page:custom-component] onResize', size)
  },
  // 事件处理函数
  bindViewTap() {
    wx.navigateTo({
      url: '../logs/logs'
    })
  },
  onChooseAvatar(e) {
    const { avatarUrl } = e.detail
    const { nickName } = this.data.userInfo
    this.setData({
      "userInfo.avatarUrl": avatarUrl,
      hasUserInfo: nickName && avatarUrl && avatarUrl !== defaultAvatarUrl,
    })
  },
  onInputChange(e) {
    const nickName = e.detail.value
    const { avatarUrl } = this.data.userInfo
    this.setData({
      "userInfo.nickName": nickName,
      hasUserInfo: nickName && avatarUrl && avatarUrl !== defaultAvatarUrl,
    })
  },
  getUserProfile(e) {
    // 推荐使用wx.getUserProfile获取用户信息，开发者每次通过该接口获取用户个人信息均需用户确认，开发者妥善保管用户快速填写的头像昵称，避免重复弹窗
    wx.getUserProfile({
      desc: '展示用户信息', // 声明获取用户个人信息后的用途，后续会展示在弹窗中，请谨慎填写
      success: (res) => {
        console.log(res)
        this.setData({
          userInfo: res.userInfo,
          hasUserInfo: true
        })
      }
    })
  },
  toggleTitle() {
    this.setData({
      showTitle: !this.data.showTitle
    })
  },
  toggleDynamicProbe() {
    this.setData({
      showDynamicProbe: !this.data.showDynamicProbe
    })
  },
  openLifecycleTarget() {
    wx.navigateTo({
      url: '/pages/button/index'
    })
  }
})
