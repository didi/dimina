import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import runtime from '../src/core/runtime.js'
let queue, serial, original
beforeEach(() => {
  queue = new Map(); serial = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn(fn => { queue.set(++serial, fn); return serial }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(id => queue.delete(id)))
  original = runtime.triggerCallback; runtime.triggerCallback = vi.fn(); runtime.canvasRafIds.clear(); runtime.canvasFrameStreams.clear()
  runtime.canvasNodes.set('stream-node', { bridgeId: 'owner', contexts: new Map(), resourceIds: new Set() })
})
afterEach(() => { runtime.disposeCanvasNode('stream-node'); runtime.triggerCallback = original; vi.unstubAllGlobals() })
function start(bridgeId = 'owner', version = 1) { runtime.canvasNodeSubscribeAnimationFrame({ bridgeId, params: { nodeId: 'stream-node', requestId: 71, callback: 'tick', version } }) }
function tick(ts) { const [id, fn] = queue.entries().next().value; queue.delete(id); fn(ts) }
function ack(sequence, bridgeId = 'owner') { runtime.canvasNodeAcknowledgeAnimationFrame({ bridgeId, params: { nodeId: 'stream-node', requestId: 71, sequence } }) }
function cancel(bridgeId = 'owner') { runtime.canvasNodeCancelAnimationFrame({ bridgeId, params: { nodeId: 'stream-node', requestId: 71 } }) }
it('subscribes to real RAF without waiting for a Service request per tick', () => {
  start(); expect(runtime.triggerCallback).not.toHaveBeenCalled(); tick(17.25); tick(33.9)
  expect(runtime.triggerCallback.mock.calls.map(c => c[2])).toEqual([{ requestId: 71, sequence: 1, timestamp: 17.25 }, { requestId: 71, sequence: 2, timestamp: 33.9 }])
  expect(queue.size).toBe(1)
})
it('bounds delivery at four unacknowledged real ticks and resumes with a new RAF', () => {
  start(); for (let i = 1; i <= 4; i++) tick(i * 17)
  expect(queue.size).toBe(0); expect(runtime.triggerCallback).toHaveBeenCalledTimes(4)
  ack(2); expect(queue.size).toBe(1); expect(runtime.triggerCallback).toHaveBeenCalledTimes(4)
  tick(120); tick(137); expect(queue.size).toBe(0); expect(runtime.triggerCallback).toHaveBeenCalledTimes(6)
})
it('ignores forged, future, duplicate and non-integer credits', () => {
  start(); for (let i = 1; i <= 4; i++) tick(i * 17)
  for (const seq of [0, -1, 1.5, Number.NaN, 5, Infinity]) ack(seq)
  ack(4, 'other'); expect(queue.size).toBe(0); ack(2); tick(90); tick(107); ack(2)
  expect(queue.size).toBe(0)
})
it('cancels a live or credit-exhausted stream and stale closures cannot restart it', () => {
  start(); const fn = queue.values().next().value; cancel(); fn(17)
  expect(queue.size).toBe(0); expect(runtime.triggerCallback).not.toHaveBeenCalled()
  start(); for (let i = 1; i <= 4; i++) tick(i * 17); cancel(); ack(4)
  expect(queue.size).toBe(0); expect(runtime.canvasFrameStreams.size).toBe(0)
})
it('validates owner, protocol version and duplicate subscriptions', () => {
  start('other'); start('owner', true); expect(queue.size).toBe(0)
  start(); start(); cancel('other'); expect(queue.size).toBe(1)
})
it('disposal removes credit-exhausted state and late acknowledgements do not revive it', () => {
  start(); for (let i = 1; i <= 4; i++) tick(i * 17)
  runtime.disposeCanvasNode('stream-node'); ack(4)
  expect(queue.size).toBe(0); expect(runtime.canvasFrameStreams.size).toBe(0)
})
