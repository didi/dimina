Page({
  data: {
    background: ['demo-text-1', 'demo-text-2'],
    // 'demo-text-3'
    indicatorDots: true,
    vertical: false,
    autoplay: true,
    interval: 10000,
    duration: 500,
    circular: true
  },
  changeIndicatorDots: function (e) {
    this.setData({
      indicatorDots: !this.data.indicatorDots
    })
  },
  changeAutoplay: function (e) {
    this.setData({
      autoplay: !this.data.autoplay
    })
  },
  intervalChange: function (e) {
    this.setData({
      interval: e.detail.value
    })
  },
  durationChange: function (e) {
    this.setData({
      duration: e.detail.value
    })
  }
})
