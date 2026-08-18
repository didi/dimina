const { COLORS } = require('./config')

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + width - r, y)
  ctx.quadraticCurveTo(x + width, y, x + width, y + r)
  ctx.lineTo(x + width, y + height - r)
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height)
  ctx.lineTo(x + r, y + height)
  ctx.quadraticCurveTo(x, y + height, x, y + height - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function drawPlayer(ctx, player, time) {
  ctx.save()
  ctx.translate(player.x, player.y)
  if (player.invincible > 0 && Math.floor(time * 14) % 2 === 0) {
    ctx.globalAlpha = 0.3
  }

  const flame = 12 + Math.sin(time * 24) * 5
  ctx.fillStyle = COLORS.cyan
  ctx.beginPath()
  ctx.moveTo(-6, 13)
  ctx.quadraticCurveTo(0, 16 + flame, 6, 13)
  ctx.closePath()
  ctx.fill()

  ctx.shadowColor = COLORS.cyan
  ctx.shadowBlur = 12
  ctx.fillStyle = '#dffbff'
  ctx.beginPath()
  ctx.moveTo(0, -24)
  ctx.lineTo(9, 4)
  ctx.lineTo(27, 15)
  ctx.lineTo(12, 18)
  ctx.lineTo(5, 10)
  ctx.lineTo(0, 20)
  ctx.lineTo(-5, 10)
  ctx.lineTo(-12, 18)
  ctx.lineTo(-27, 15)
  ctx.lineTo(-9, 4)
  ctx.closePath()
  ctx.fill()

  ctx.shadowBlur = 0
  ctx.fillStyle = COLORS.blue
  ctx.beginPath()
  ctx.moveTo(0, -16)
  ctx.lineTo(6, 7)
  ctx.lineTo(0, 15)
  ctx.lineTo(-6, 7)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = COLORS.cyan
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(-22, 13)
  ctx.lineTo(-8, 7)
  ctx.moveTo(22, 13)
  ctx.lineTo(8, 7)
  ctx.stroke()
  ctx.restore()
}

function drawScout(ctx, enemy, time) {
  ctx.save()
  ctx.translate(enemy.x, enemy.y)
  ctx.rotate(Math.sin(time * 3 + enemy.phase) * 0.12)
  ctx.shadowColor = COLORS.red
  ctx.shadowBlur = 9
  ctx.fillStyle = '#ff6d83'
  ctx.beginPath()
  ctx.moveTo(0, 17)
  ctx.lineTo(16, -12)
  ctx.lineTo(7, -8)
  ctx.lineTo(0, -18)
  ctx.lineTo(-7, -8)
  ctx.lineTo(-16, -12)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = '#7d1837'
  ctx.beginPath()
  ctx.arc(0, -3, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawFighter(ctx, enemy, time) {
  ctx.save()
  ctx.translate(enemy.x, enemy.y)
  ctx.rotate(Math.sin(time * 2 + enemy.phase) * 0.08)
  ctx.shadowColor = COLORS.orange
  ctx.shadowBlur = 12
  ctx.fillStyle = '#ffb354'
  ctx.beginPath()
  ctx.moveTo(0, 22)
  ctx.lineTo(10, 7)
  ctx.lineTo(25, -3)
  ctx.lineTo(16, -15)
  ctx.lineTo(5, -11)
  ctx.lineTo(0, -22)
  ctx.lineTo(-5, -11)
  ctx.lineTo(-16, -15)
  ctx.lineTo(-25, -3)
  ctx.lineTo(-10, 7)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = '#923e2d'
  ctx.fillRect(-5, -9, 10, 19)
  ctx.restore()
}

function drawHeavy(ctx, enemy, time) {
  ctx.save()
  ctx.translate(enemy.x, enemy.y)
  ctx.rotate(Math.sin(time * 1.4 + enemy.phase) * 0.04)
  ctx.shadowColor = COLORS.purple
  ctx.shadowBlur = 15
  ctx.fillStyle = '#b394ff'
  ctx.beginPath()
  ctx.moveTo(0, 27)
  ctx.lineTo(14, 13)
  ctx.lineTo(31, 9)
  ctx.lineTo(25, -15)
  ctx.lineTo(10, -20)
  ctx.lineTo(0, -29)
  ctx.lineTo(-10, -20)
  ctx.lineTo(-25, -15)
  ctx.lineTo(-31, 9)
  ctx.lineTo(-14, 13)
  ctx.closePath()
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = '#4d278c'
  roundedRect(ctx, -10, -14, 20, 28, 6)
  ctx.fill()

  const healthWidth = 40
  ctx.fillStyle = 'rgba(7, 17, 39, 0.75)'
  ctx.fillRect(-healthWidth / 2, -39, healthWidth, 4)
  ctx.fillStyle = COLORS.purple
  ctx.fillRect(-healthWidth / 2, -39, healthWidth * enemy.hp / enemy.maxHp, 4)
  ctx.restore()
}

function drawEnemy(ctx, enemy, time) {
  if (enemy.type === 'heavy') {
    drawHeavy(ctx, enemy, time)
  }
  else if (enemy.type === 'fighter') {
    drawFighter(ctx, enemy, time)
  }
  else {
    drawScout(ctx, enemy, time)
  }
}

function drawBullet(ctx, bullet) {
  ctx.save()
  ctx.shadowColor = COLORS.cyan
  ctx.shadowBlur = 9
  ctx.fillStyle = COLORS.white
  roundedRect(ctx, bullet.x - 2, bullet.y - 9, 4, 18, 2)
  ctx.fill()
  ctx.restore()
}

function drawPowerUp(ctx, powerUp, time) {
  const pulse = 1 + Math.sin(time * 6 + powerUp.phase) * 0.12
  ctx.save()
  ctx.translate(powerUp.x, powerUp.y)
  ctx.scale(pulse, pulse)
  ctx.shadowColor = powerUp.kind === 'repair' ? COLORS.red : COLORS.cyan
  ctx.shadowBlur = 15
  ctx.fillStyle = powerUp.kind === 'repair' ? '#ff6680' : '#5be9ff'
  ctx.beginPath()
  ctx.arc(0, 0, 11, 0, Math.PI * 2)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.fillStyle = COLORS.ink
  if (powerUp.kind === 'repair') {
    ctx.fillRect(-2, -7, 4, 14)
    ctx.fillRect(-7, -2, 14, 4)
  }
  else {
    ctx.beginPath()
    ctx.moveTo(2, -8)
    ctx.lineTo(-5, 1)
    ctx.lineTo(0, 1)
    ctx.lineTo(-2, 8)
    ctx.lineTo(6, -2)
    ctx.lineTo(1, -2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

function drawParticle(ctx, particle) {
  ctx.save()
  ctx.globalAlpha = Math.max(0, particle.life / particle.maxLife)
  ctx.fillStyle = particle.color
  ctx.beginPath()
  ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function getTitleButtonRect(game) {
  const centerX = game.width / 2
  const centerY = game.height * 0.42
  return { x: centerX - 102, y: centerY + 36, width: 204, height: 54 }
}

function getGameOverButtonRect(game) {
  const centerX = game.width / 2
  const centerY = game.height * 0.44
  return { x: centerX - 92, y: centerY + 83, width: 184, height: 50 }
}

function containsPoint(rect, x, y) {
  return x >= rect.x
    && x <= rect.x + rect.width
    && y >= rect.y
    && y <= rect.y + rect.height
}

function drawHud(ctx, game) {
  const top = game.topInset
  const rightTop = Math.max(top + 18, (Number(game.menuBottom) || top) + 8)
  ctx.save()
  ctx.fillStyle = 'rgba(5, 12, 31, 0.58)'
  roundedRect(ctx, 14, top + 12, 138, 52, 14)
  ctx.fill()
  ctx.strokeStyle = 'rgba(89, 230, 255, 0.25)'
  ctx.lineWidth = 1
  ctx.stroke()

  ctx.fillStyle = COLORS.cyanSoft
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('SCORE', 29, top + 32)
  ctx.fillStyle = COLORS.white
  ctx.font = 'bold 21px sans-serif'
  ctx.fillText(String(game.score).padStart(6, '0'), 28, top + 54)

  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(185, 246, 255, 0.75)'
  ctx.font = '11px sans-serif'
  ctx.fillText(`WAVE ${game.wave}`, game.width - 18, rightTop + 11)
  ctx.fillStyle = COLORS.white
  ctx.font = 'bold 15px sans-serif'
  ctx.fillText(`BEST ${String(game.highScore).padStart(6, '0')}`, game.width - 18, rightTop + 32)

  const heartY = top + 82
  for (let i = 0; i < game.player.maxHp; i += 1) {
    const x = 25 + i * 23
    ctx.globalAlpha = i < game.player.hp ? 1 : 0.22
    ctx.fillStyle = COLORS.red
    ctx.beginPath()
    ctx.moveTo(x, heartY + 5)
    ctx.bezierCurveTo(x - 12, heartY - 2, x - 9, heartY - 11, x, heartY - 5)
    ctx.bezierCurveTo(x + 9, heartY - 11, x + 12, heartY - 2, x, heartY + 5)
    ctx.fill()
  }

  if (game.rapidFire > 0) {
    ctx.globalAlpha = 1
    ctx.fillStyle = 'rgba(5, 12, 31, 0.7)'
    roundedRect(ctx, game.width - 105, rightTop + 50, 87, 24, 12)
    ctx.fill()
    ctx.fillStyle = COLORS.cyan
    ctx.font = 'bold 11px sans-serif'
    ctx.fillText(`RAPID ${Math.ceil(game.rapidFire)}s`, game.width - 29, rightTop + 66)
  }
  ctx.restore()
}

function drawTitle(ctx, game) {
  const centerX = game.width / 2
  const centerY = game.height * 0.42
  const button = getTitleButtonRect(game)
  ctx.save()
  ctx.fillStyle = 'rgba(61, 123, 255, 0.14)'
  ctx.beginPath()
  ctx.arc(centerX, centerY - 40, game.width * 0.58, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(61, 123, 255, 0.08)'
  ctx.fillRect(0, 0, game.width, game.height)

  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.cyan
  ctx.font = 'bold 13px sans-serif'
  ctx.fillText('DIMINA MINI GAME', centerX, centerY - 115)
  ctx.shadowColor = COLORS.cyan
  ctx.shadowBlur = 18
  ctx.fillStyle = COLORS.white
  ctx.font = `bold ${Math.min(46, game.width * 0.12)}px sans-serif`
  ctx.fillText('星河空战', centerX, centerY - 61)
  ctx.shadowBlur = 0
  ctx.fillStyle = 'rgba(185, 246, 255, 0.78)'
  ctx.font = '14px sans-serif'
  ctx.fillText('移动战机 · 自动射击 · 坚持到更高波次', centerX, centerY - 25)

  ctx.fillStyle = 'rgba(89, 230, 255, 0.16)'
  roundedRect(ctx, button.x, button.y, button.width, button.height, button.height / 2)
  ctx.fill()
  ctx.strokeStyle = COLORS.cyan
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.fillStyle = COLORS.white
  ctx.font = 'bold 16px sans-serif'
  ctx.fillText('点击开始', centerX, centerY + 69)

  if (game.highScore > 0) {
    ctx.fillStyle = 'rgba(185, 246, 255, 0.7)'
    ctx.font = '12px sans-serif'
    ctx.fillText(`历史最高分  ${game.highScore}`, centerX, centerY + 124)
  }
  ctx.restore()
}

function drawGameOver(ctx, game) {
  const centerX = game.width / 2
  const centerY = game.height * 0.44
  const button = getGameOverButtonRect(game)
  ctx.save()
  ctx.fillStyle = 'rgba(3, 8, 24, 0.72)'
  ctx.fillRect(0, 0, game.width, game.height)

  ctx.textAlign = 'center'
  ctx.fillStyle = COLORS.red
  ctx.font = 'bold 13px sans-serif'
  ctx.fillText('MISSION ENDED', centerX, centerY - 80)
  ctx.fillStyle = COLORS.white
  ctx.font = 'bold 38px sans-serif'
  ctx.fillText('战斗结束', centerX, centerY - 31)
  ctx.fillStyle = 'rgba(185, 246, 255, 0.75)'
  ctx.font = '13px sans-serif'
  ctx.fillText('本次得分', centerX, centerY + 7)
  ctx.fillStyle = COLORS.cyan
  ctx.font = 'bold 34px sans-serif'
  ctx.fillText(String(game.score), centerX, centerY + 48)

  ctx.fillStyle = 'rgba(89, 230, 255, 0.16)'
  roundedRect(ctx, button.x, button.y, button.width, button.height, button.height / 2)
  ctx.fill()
  ctx.strokeStyle = COLORS.cyan
  ctx.stroke()
  ctx.fillStyle = COLORS.white
  ctx.font = 'bold 15px sans-serif'
  ctx.fillText('再来一局', centerX, centerY + 114)
  ctx.restore()
}

module.exports = {
  drawPlayer,
  drawEnemy,
  drawBullet,
  drawPowerUp,
  drawParticle,
  drawHud,
  drawTitle,
  drawGameOver,
  getTitleButtonRect,
  getGameOverButtonRect,
  containsPoint,
}
