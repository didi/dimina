const AirBattleGame = require('./js/game')

const canvas = wx.createCanvas()
const game = new AirBattleGame(canvas)

wx.onTouchStart(event => game.handleTouchStart(event))
wx.onTouchMove(event => game.handleTouchMove(event))
wx.onTouchEnd(event => game.handleTouchEnd(event))
wx.onTouchCancel(event => game.handleTouchEnd(event))

wx.onHide(() => game.pause())
wx.onShow(() => game.resume())
wx.onError((message, stack) => {
  console.error('[Dimina Air Battle]', message, stack || '')
})

game.start()
