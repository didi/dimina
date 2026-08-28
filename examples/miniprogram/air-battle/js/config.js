const COLORS = {
  cyan: '#59e6ff',
  cyanSoft: '#b9f6ff',
  blue: '#3d7bff',
  purple: '#8b5cff',
  red: '#ff4f70',
  orange: '#ff9c47',
  yellow: '#ffe57a',
  white: '#f6fbff',
  ink: '#071127',
}

const HIGH_SCORE_KEY = 'dimina-air-battle-high-score'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function random(min, max) {
  return min + Math.random() * (max - min)
}

function squaredDistance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

module.exports = {
  COLORS,
  HIGH_SCORE_KEY,
  clamp,
  random,
  squaredDistance,
}
