Page({
  data: {
    logText: ''
  },

  onReady: function () {
    var self = this
    self.log('onReady: querying canvas node...')

    wx.createSelectorQuery()
      .select('#testCanvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) {
          self.log('ERROR: canvas node not found! res=' + JSON.stringify(res))
          return
        }

        var canvas = res[0].node
        self.canvas = canvas
        self.log('canvas node acquired: ' + canvas.nodeId + ' size=' + res[0].width + 'x' + res[0].height)

        // Set canvas buffer size (match CSS size * dpr for sharp rendering)
        var dpr = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : (wx.getSystemInfoSync().pixelRatio || 2)
        self.dpr = dpr
        canvas.width = res[0].width * dpr
        canvas.height = res[0].height * dpr
        self.log('buffer size set: ' + canvas.width + 'x' + canvas.height + ' dpr=' + dpr)

        var ctx = canvas.getContext('2d')
        self.ctx = ctx
        ctx.scale(dpr, dpr)
        self.log('context acquired, scale(' + dpr + ') applied')

        // Auto-run fillRect test
        self.testFillRect()
      })
  },

  log: function (msg) {
    console.log('[canvas-native] ' + msg)
    this.setData({
      logText: msg + '\n' + (this.data.logText || '')
    })
  },

  testFillRect: function () {
    var ctx = this.ctx
    if (!ctx) {
      this.log('ERROR: ctx not ready')
      return
    }
    this.log('testFillRect: drawing 3 colored rects...')

    // Red rect
    ctx.fillStyle = '#FF0000'
    ctx.fillRect(10, 10, 80, 80)

    // Green rect
    ctx.fillStyle = '#00FF00'
    ctx.fillRect(110, 10, 80, 80)

    // Blue rect
    ctx.fillStyle = '#0000FF'
    ctx.fillRect(210, 10, 80, 80)

    this.log('testFillRect: done')
  },

  testStrokeRect: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testStrokeRect...')

    ctx.strokeStyle = '#FF6600'
    ctx.lineWidth = 3
    ctx.strokeRect(10, 110, 80, 80)

    ctx.strokeStyle = '#6600FF'
    ctx.lineWidth = 5
    ctx.strokeRect(110, 110, 80, 80)

    this.log('testStrokeRect: done')
  },

  testPath: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testPath: arc + lines...')

    // Circle
    ctx.beginPath()
    ctx.arc(50, 250, 30, 0, Math.PI * 2)
    ctx.fillStyle = '#FF00FF'
    ctx.fill()

    // Triangle
    ctx.beginPath()
    ctx.moveTo(130, 220)
    ctx.lineTo(180, 280)
    ctx.lineTo(80, 280)
    ctx.closePath()
    ctx.strokeStyle = '#009900'
    ctx.lineWidth = 2
    ctx.stroke()

    this.log('testPath: done')
  },

  testText: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testText...')

    ctx.font = '20px sans-serif'
    ctx.fillStyle = '#333333'
    ctx.fillText('Hello Canvas', 200, 250)

    ctx.font = '14px serif'
    ctx.fillStyle = '#FF0000'
    ctx.fillText('Native 2D Test', 200, 275)

    this.log('testText: done')
  },

  testGradient: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testGradient...')

    var gradient = ctx.createLinearGradient(10, 110, 90, 190)
    gradient.addColorStop(0, '#FF0000')
    gradient.addColorStop(0.5, '#00FF00')
    gradient.addColorStop(1, '#0000FF')

    ctx.fillStyle = gradient
    ctx.fillRect(210, 110, 80, 80)

    this.log('testGradient: done')
  },

  testTransform: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testTransform: save/translate/rotate/restore...')

    ctx.save()

    ctx.translate(150, 150)
    ctx.rotate(Math.PI / 4)
    ctx.fillStyle = 'rgba(255, 165, 0, 0.7)'
    ctx.fillRect(-25, -25, 50, 50)

    ctx.restore()

    this.log('testTransform: done')
  },

  testCreateImage: function () {
    var self = this
    var canvas = this.canvas
    var ctx = this.ctx
    if (!canvas || !ctx) {
      self.log('ERROR: canvas/ctx not ready')
      return
    }
    self.log('testCreateImage: loading network image...')

    var img = canvas.createImage()
    img.onload = function () {
      self.log('image loaded: ' + img.width + 'x' + img.height)
      ctx.drawImage(img, 10, 110, 80, 80)
      self.log('drawImage: done')
    }
    img.onerror = function (e) {
      self.log('image ERROR: ' + JSON.stringify(e))
    }
    img.src = 'https://www.baidu.com/img/flexible/logo/pc/result.png'
  },

  testClear: function () {
    var ctx = this.ctx
    if (!ctx) return
    this.log('testClear...')

    ctx.clearRect(0, 0, 300, 300)

    this.log('testClear: done')
  }
})
