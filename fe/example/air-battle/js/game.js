const {
  COLORS,
  HIGH_SCORE_KEY,
  clamp,
  random,
  squaredDistance,
} = require('./config')
const renderer = require('./renderer')

function getScreenSize(canvas) {
  let info = {}
  let menuRect = {}
  try {
    info = wx.getSystemInfoSync() || {}
  }
  catch (error) {
    console.warn('[Dimina Air Battle] getSystemInfoSync failed', error)
  }
  try {
    menuRect = wx.getMenuButtonBoundingClientRect() || {}
  }
  catch (error) {
    console.warn('[Dimina Air Battle] getMenuButtonBoundingClientRect failed', error)
  }
  const topInset = Math.max(0, Number(info.safeArea && info.safeArea.top) || Number(info.statusBarHeight) || 0)
  return {
    width: Math.max(300, Number(info.windowWidth) || Number(canvas.width) || 375),
    height: Math.max(450, Number(info.windowHeight) || Number(canvas.height) || 667),
    topInset,
    menuBottom: Math.max(topInset, Number(menuRect.bottom) || 0),
  }
}

function loadHighScore(onValue) {
  wx.getStorage({
    key: HIGH_SCORE_KEY,
    success: result => onValue(Math.max(0, Number(result.data) || 0)),
    fail: () => onValue(0),
  })
}

class AirBattleGame {
  constructor(canvas) {
    const size = getScreenSize(canvas)
    this.canvas = canvas
    this.width = size.width
    this.height = size.height
    this.topInset = size.topInset
    this.menuBottom = size.menuBottom
    this.canvas.width = this.width
    this.canvas.height = this.height
    this.ctx = canvas.getContext('2d')
    this.backgroundGradient = this.ctx.createLinearGradient(0, 0, 0, this.height)
    this.backgroundGradient.addColorStop(0, '#050b1d')
    this.backgroundGradient.addColorStop(0.58, '#071b3d')
    this.backgroundGradient.addColorStop(1, '#0b3158')

    this.state = 'title'
    this.suspended = false
    this.frameId = null
    this.lastTime = 0
    this.time = 0
    this.score = 0
    this.highScore = 0
    this.wave = 1
    this.spawnClock = 0
    this.shotClock = 0
    this.rapidFire = 0
    this.ignoreActivationTouch = false

    this.player = this.createPlayer()
    this.stars = this.createStars()
    this.bullets = []
    this.enemies = []
    this.powerUps = []
    this.particles = []

    this.loop = this.loop.bind(this)
    loadHighScore((score) => {
      this.highScore = Math.max(this.highScore, score)
    })
  }

  createPlayer() {
    return {
      x: this.width / 2,
      y: this.height * 0.82,
      targetX: this.width / 2,
      targetY: this.height * 0.82,
      radius: 18,
      hp: 3,
      maxHp: 3,
      invincible: 0,
    }
  }

  createStars() {
    const stars = []
    const count = Math.max(55, Math.floor(this.width * this.height / 5600))
    for (let i = 0; i < count; i += 1) {
      stars.push({
        x: random(0, this.width),
        y: random(0, this.height),
        size: random(0.6, 2.1),
        speed: random(18, 82),
        alpha: random(0.25, 0.95),
      })
    }
    return stars
  }

  start() {
    this.scheduleFrame()
  }

  startRound() {
    this.state = 'running'
    this.score = 0
    this.wave = 1
    this.spawnClock = 0
    this.shotClock = 0
    this.rapidFire = 0
    this.player = this.createPlayer()
    this.bullets = []
    this.enemies = []
    this.powerUps = []
    this.particles = []
    this.lastTime = 0
  }

  pause() {
    this.suspended = true
    if (this.frameId !== null) {
      cancelAnimationFrame(this.frameId)
      this.frameId = null
    }
  }

  resume() {
    if (!this.suspended && this.frameId !== null) {
      return
    }
    this.suspended = false
    this.lastTime = 0
    this.scheduleFrame()
  }

  scheduleFrame() {
    if (!this.suspended && this.frameId === null) {
      this.frameId = requestAnimationFrame(this.loop)
    }
  }

  loop(timestamp) {
    this.frameId = null
    if (this.suspended) {
      return
    }
    const now = Number(timestamp) || Date.now()
    const dt = this.lastTime ? Math.min(0.034, (now - this.lastTime) / 1000) : 0
    this.lastTime = now
    this.time += dt
    this.update(dt)
    this.render()
    this.scheduleFrame()
  }

  update(dt) {
    this.updateStars(dt)
    this.updateParticles(dt)
    if (this.state !== 'running') {
      return
    }

    this.wave = 1 + Math.floor(this.score / 1200)
    this.rapidFire = Math.max(0, this.rapidFire - dt)
    this.player.invincible = Math.max(0, this.player.invincible - dt)
    this.updatePlayer(dt)
    this.updateBullets(dt)
    this.updateEnemies(dt)
    this.updatePowerUps(dt)
    this.spawnAndShoot(dt)
    this.resolveCollisions()
  }

  updateStars(dt) {
    for (const star of this.stars) {
      star.y += star.speed * dt
      if (star.y > this.height + 3) {
        star.x = random(0, this.width)
        star.y = -3
      }
    }
  }

  updatePlayer(dt) {
    const follow = Math.min(1, dt * 14)
    this.player.x += (this.player.targetX - this.player.x) * follow
    this.player.y += (this.player.targetY - this.player.y) * follow
    this.player.x = clamp(this.player.x, 30, this.width - 30)
    this.player.y = clamp(this.player.y, this.topInset + 105, this.height - 35)
  }

  updateBullets(dt) {
    for (const bullet of this.bullets) {
      bullet.y -= bullet.speed * dt
    }
    this.bullets = this.bullets.filter(bullet => bullet.y > -20 && !bullet.dead)
  }

  updateEnemies(dt) {
    for (const enemy of this.enemies) {
      enemy.y += enemy.speed * dt
      enemy.x += Math.sin(this.time * enemy.swaySpeed + enemy.phase) * enemy.sway * dt
      if (enemy.y > this.height + enemy.radius) {
        enemy.dead = true
      }
    }
    this.enemies = this.enemies.filter(enemy => !enemy.dead)
  }

  updatePowerUps(dt) {
    for (const powerUp of this.powerUps) {
      powerUp.y += powerUp.speed * dt
    }
    this.powerUps = this.powerUps.filter(powerUp => powerUp.y < this.height + 30 && !powerUp.dead)
  }

  updateParticles(dt) {
    for (const particle of this.particles) {
      particle.x += particle.vx * dt
      particle.y += particle.vy * dt
      particle.vx *= 0.985
      particle.vy *= 0.985
      particle.life -= dt
      particle.size = Math.max(0.2, particle.size - dt * 2)
    }
    this.particles = this.particles.filter(particle => particle.life > 0)
  }

  spawnAndShoot(dt) {
    this.spawnClock -= dt
    this.shotClock -= dt
    const difficulty = Math.min(0.72, (this.wave - 1) * 0.045)
    if (this.spawnClock <= 0) {
      this.spawnEnemy()
      this.spawnClock = Math.max(0.27, 0.84 - difficulty) * random(0.78, 1.2)
    }
    if (this.shotClock <= 0) {
      this.fire()
      this.shotClock = this.rapidFire > 0 ? 0.075 : 0.17
    }
  }

  spawnEnemy() {
    const roll = Math.random()
    let type = 'scout'
    if (this.wave >= 4 && roll > 0.86) {
      type = 'heavy'
    }
    else if (this.wave >= 2 && roll > 0.58) {
      type = 'fighter'
    }

    const model = type === 'heavy'
      ? { radius: 29, hp: 9 + this.wave, speed: 58, score: 420, sway: 13 }
      : type === 'fighter'
        ? { radius: 22, hp: 3 + Math.floor(this.wave / 3), speed: 96, score: 180, sway: 20 }
        : { radius: 16, hp: 1, speed: 135 + this.wave * 4, score: 80, sway: 28 }

    this.enemies.push({
      type,
      x: random(model.radius + 8, this.width - model.radius - 8),
      y: -model.radius - random(0, 50),
      radius: model.radius,
      hp: model.hp,
      maxHp: model.hp,
      speed: model.speed + random(-8, 18),
      score: model.score,
      sway: model.sway,
      swaySpeed: random(1.3, 2.8),
      phase: random(0, Math.PI * 2),
      dead: false,
    })
  }

  fire() {
    const offsets = this.rapidFire > 0 ? [-9, 9] : [0]
    for (const offset of offsets) {
      this.bullets.push({
        x: this.player.x + offset,
        y: this.player.y - 26,
        radius: 4,
        speed: 510,
        dead: false,
      })
    }
  }

  resolveCollisions() {
    for (const bullet of this.bullets) {
      if (bullet.dead) continue
      for (const enemy of this.enemies) {
        if (enemy.dead) continue
        const hitRadius = bullet.radius + enemy.radius * 0.72
        if (squaredDistance(bullet, enemy) <= hitRadius * hitRadius) {
          bullet.dead = true
          enemy.hp -= 1
          this.emitSparks(bullet.x, bullet.y, COLORS.cyan, 3)
          if (enemy.hp <= 0) {
            this.destroyEnemy(enemy)
          }
          break
        }
      }
    }

    if (this.player.invincible <= 0) {
      for (const enemy of this.enemies) {
        if (enemy.dead) continue
        const hitRadius = this.player.radius + enemy.radius * 0.66
        if (squaredDistance(this.player, enemy) <= hitRadius * hitRadius) {
          enemy.dead = true
          this.damagePlayer()
          break
        }
      }
    }

    for (const powerUp of this.powerUps) {
      if (powerUp.dead) continue
      const hitRadius = this.player.radius + powerUp.radius
      if (squaredDistance(this.player, powerUp) <= hitRadius * hitRadius) {
        powerUp.dead = true
        if (powerUp.kind === 'repair') {
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + 1)
        }
        else {
          this.rapidFire = Math.max(this.rapidFire, 6)
        }
        this.emitSparks(powerUp.x, powerUp.y, powerUp.kind === 'repair' ? COLORS.red : COLORS.cyan, 14)
      }
    }
  }

  destroyEnemy(enemy) {
    enemy.dead = true
    this.score += enemy.score
    this.emitExplosion(enemy.x, enemy.y, enemy.type === 'heavy' ? COLORS.purple : COLORS.orange, enemy.radius)
    if (Math.random() < 0.085) {
      this.powerUps.push({
        x: enemy.x,
        y: enemy.y,
        radius: 12,
        speed: 78,
        kind: this.player.hp < this.player.maxHp && Math.random() < 0.55 ? 'repair' : 'rapid',
        phase: random(0, Math.PI * 2),
        dead: false,
      })
    }
  }

  damagePlayer() {
    this.player.hp -= 1
    this.player.invincible = 1.25
    this.emitExplosion(this.player.x, this.player.y, COLORS.red, 24)
    if (this.player.hp <= 0) {
      this.finishRound()
    }
  }

  finishRound() {
    this.state = 'gameover'
    if (this.score > this.highScore) {
      this.highScore = this.score
      wx.setStorage({
        key: HIGH_SCORE_KEY,
        data: this.highScore,
        fail: error => console.warn('[Dimina Air Battle] save high score failed', error),
      })
    }
  }

  emitSparks(x, y, color, count) {
    for (let i = 0; i < count; i += 1) {
      const life = random(0.18, 0.42)
      this.particles.push({
        x,
        y,
        vx: random(-75, 75),
        vy: random(-75, 75),
        size: random(1.2, 3.1),
        color,
        life,
        maxLife: life,
      })
    }
  }

  emitExplosion(x, y, color, radius) {
    const count = Math.min(24, 9 + Math.floor(radius / 2))
    for (let i = 0; i < count; i += 1) {
      const angle = random(0, Math.PI * 2)
      const speed = random(45, 155 + radius * 2)
      const life = random(0.28, 0.72)
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        size: random(1.8, 5.4),
        color: Math.random() > 0.35 ? color : COLORS.yellow,
        life,
        maxLife: life,
      })
    }
    if (this.particles.length > 220) {
      this.particles.splice(0, this.particles.length - 220)
    }
  }

  getTouch(event) {
    const touches = event.touches && event.touches.length
      ? event.touches
      : event.changedTouches
    return touches && touches.length ? touches[0] : null
  }

  movePlayerFromTouch(touch) {
    if (!touch) return
    this.player.targetX = clamp(Number(touch.clientX) || this.player.x, 30, this.width - 30)
    this.player.targetY = clamp(Number(touch.clientY) || this.player.y, this.topInset + 105, this.height - 35)
  }

  handleTouchStart(event) {
    const touch = this.getTouch(event)
    if (this.state === 'title' || this.state === 'gameover') {
      const button = this.state === 'title'
        ? renderer.getTitleButtonRect(this)
        : renderer.getGameOverButtonRect(this)
      if (!touch || !renderer.containsPoint(button, Number(touch.clientX), Number(touch.clientY))) {
        return
      }
      this.ignoreActivationTouch = true
      this.startRound()
      return
    }
    this.movePlayerFromTouch(touch)
  }

  handleTouchMove(event) {
    if (this.state === 'running' && !this.ignoreActivationTouch) {
      this.movePlayerFromTouch(this.getTouch(event))
    }
  }

  handleTouchEnd(event) {
    if (this.ignoreActivationTouch) {
      this.ignoreActivationTouch = false
      return
    }
    if (this.state === 'running') {
      this.movePlayerFromTouch(this.getTouch(event))
    }
  }

  renderBackground() {
    const ctx = this.ctx
    ctx.fillStyle = this.backgroundGradient
    ctx.fillRect(0, 0, this.width, this.height)

    for (const star of this.stars) {
      ctx.globalAlpha = star.alpha
      ctx.fillStyle = star.speed > 58 ? COLORS.cyanSoft : COLORS.white
      ctx.fillRect(star.x, star.y, star.size, star.size * (star.speed > 58 ? 2.5 : 1))
    }
    ctx.globalAlpha = 1
  }

  render() {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.width, this.height)
    this.renderBackground()

    for (const powerUp of this.powerUps) renderer.drawPowerUp(ctx, powerUp, this.time)
    for (const bullet of this.bullets) renderer.drawBullet(ctx, bullet)
    for (const enemy of this.enemies) renderer.drawEnemy(ctx, enemy, this.time)
    for (const particle of this.particles) renderer.drawParticle(ctx, particle)

    if (this.state === 'running') {
      renderer.drawPlayer(ctx, this.player, this.time)
      renderer.drawHud(ctx, this)
    }
    else if (this.state === 'title') {
      renderer.drawPlayer(ctx, this.player, this.time)
      renderer.drawTitle(ctx, this)
    }
    else {
      renderer.drawGameOver(ctx, this)
    }
  }
}

module.exports = AirBattleGame
