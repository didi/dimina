Page({
  data: {
    text: '返回首页',
    item: {
      index: 0,
      msg: 'this is a msg',
      time: '2016-09-15'
    },
    myTime: '2024-02-28'
  },
  onLoad: function (options) {
    // 页面创建时执行
    console.log('详情页 page onLoad: ', options);
  },
  onShow: function () {
    // 页面出现在前台时执行
    console.log('详情页 page onShow');
  },
  onReady: function () {
    // 页面首次渲染完毕时执行
    console.log('详情页 page onReady');
  },
  onHide: function () {
    // 页面从前台变为后台时执行
    console.log('详情页 onHide');
  },
  onUnload: function () {
    // 页面销毁时执行
    console.log('详情页 onUnload');
  },
  onPageScroll: function (opts) {
    // 页面滚动时执行
    console.log(opts);
  },
  back() {
    dd.navigateBack({});
  },
});
