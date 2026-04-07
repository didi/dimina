Page({
  data: {
    buttonLoaded: false,
    showList: false,
    items: []
  },
  async onLoad() {
    const { items } = this.data;
    require('../../subPackageB/utils.js', utils => {
      items.push(utils.whoami)
      this.setData({ items })
    })

    const pkg = await require.async('../../commonPackage/index.js')
    items.push(pkg.getPackageName())
    this.setData({ items })
  },
  buttonClicked() {
    this.setData({
      showList: !this.data.showList
    })
  },
  buttonAttached() {
    this.setData({
      buttonLoaded: true
    })
  },
})