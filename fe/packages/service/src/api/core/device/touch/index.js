import { offGameTouch, onGameTouch } from '@/core/game-events'

export function onTouchStart(callback) { onGameTouch('touchstart', callback) }
export function offTouchStart(callback) { offGameTouch('touchstart', callback) }
export function onTouchMove(callback) { onGameTouch('touchmove', callback) }
export function offTouchMove(callback) { offGameTouch('touchmove', callback) }
export function onTouchEnd(callback) { onGameTouch('touchend', callback) }
export function offTouchEnd(callback) { offGameTouch('touchend', callback) }
export function onTouchCancel(callback) { onGameTouch('touchcancel', callback) }
export function offTouchCancel(callback) { offGameTouch('touchcancel', callback) }
