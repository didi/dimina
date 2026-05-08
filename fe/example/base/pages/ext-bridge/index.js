const MODULE_NAME = 'DemoNativeModule'

Page({
  data: {
    // extBridge 结果
    bridgeResult: '',
    bridgeStatus: '',
    // extOnBridge 订阅状态与收到的事件数
    subscribeStatus: '未订阅',
    subscribeCount: 0,
    lastEvent: '',
    isSubscribed: false,
  },

  // ── extBridge demo ──────────────────────────────────────────────

  /**
   * 调用一次性 extBridge，请求 native 模块返回数据
   */
  callExtBridge() {
    this.setData({ bridgeStatus: '调用中…', bridgeResult: '' })

    wx.extBridge({
      module: MODULE_NAME,
      event: 'getUserInfo',
      data: { uid: 'demo_001' },
      success: (res) => {
        console.log('[extBridge] success:', res)
        this.setData({
          bridgeStatus: 'success',
          bridgeResult: JSON.stringify(res, null, 2),
        })
      },
      fail: (err) => {
        console.error('[extBridge] fail:', err)
        this.setData({
          bridgeStatus: 'fail',
          bridgeResult: err.errMsg || JSON.stringify(err),
        })
      },
      complete: () => {
        console.log('[extBridge] complete')
      },
    })
  },

  /**
   * 调用会触发 fail 的 extBridge（模块未注册场景）
   */
  callExtBridgeFail() {
    this.setData({ bridgeStatus: '调用中（预期失败）…', bridgeResult: '' })

    wx.extBridge({
      module: 'NotExistModule',
      event: 'doSomething',
      data: {},
      fail: (err) => {
        console.warn('[extBridge fail demo]', err)
        this.setData({
          bridgeStatus: 'fail（模块未注册）',
          bridgeResult: err.errMsg || JSON.stringify(err),
        })
      },
    })
  },

  // ── extOnBridge demo ─────────────────────────────────────────────

  /**
   * 开始订阅 native 事件
   */
  startSubscribe() {
    if (this.data.isSubscribed) return

    wx.extOnBridge({
      module: MODULE_NAME,
      event: 'onTickEvent',
      callBack: (res) => {
        console.log('[extOnBridge] event received:', res)
        this.setData({
          subscribeCount: this.data.subscribeCount + 1,
          lastEvent: JSON.stringify(res),
        })
      },
    })

    this.setData({ isSubscribed: true, subscribeStatus: '已订阅，等待事件…' })
  },

  // ── extOffBridge demo ────────────────────────────────────────────

  /**
   * 取消订阅 native 事件
   */
  stopSubscribe() {
    if (!this.data.isSubscribed) return

    wx.extOffBridge({
      module: MODULE_NAME,
      event: 'onTickEvent',
    })

    this.setData({ isSubscribed: false, subscribeStatus: '已取消订阅' })
  },

  onUnload() {
    // 页面销毁时确保取消订阅，避免内存泄漏
    if (this.data.isSubscribed) {
      wx.extOffBridge({ module: MODULE_NAME, event: 'onTickEvent' })
    }
  },
})
