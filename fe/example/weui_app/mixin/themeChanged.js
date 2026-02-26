module.exports = {
  data: {
    theme: '',
  },
  themeChanged(theme) {
    this.setData({
      theme,
    });
  },
  onLoad() {
    const app = getApp();
    this.themeChanged(app.globalData.theme);
    app.watchGlobalDataChanged(this.themeChanged);
  },
  onUnload() {
    getApp().unWatchGlobalDataChanged(this.themeChanged);
  },
};
