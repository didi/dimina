import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callback } from '@dimina/common'
import router from '../src/core/router.js'
import { createOffscreenCanvas } from '../src/api/core/ui/canvas/index.js'
const key = Symbol.for('dimina.canvas.subscribeAnimationFrame'), nodes = []
let bridgeId, serial = 0, oldInvoke, oldPublish
function event(type, body = {}) { globalThis.DiminaServiceBridge.onMessage({ type, body }) }
function messages(name) { return globalThis.DiminaServiceBridge.publish.mock.calls.map(c => c[1].body).filter(b => b.name === name) }
function start() { return messages('canvasNodeSubscribeAnimationFrame').at(-1).params }
function tick(s, sequence, timestamp, requestId = s.requestId) { callback.invoke(s.callback, { requestId, sequence, timestamp }) }
beforeEach(() => {
  bridgeId = 'bounded-stream-' + serial++; router.setInitId(bridgeId)
  oldInvoke = globalThis.DiminaServiceBridge.invoke; oldPublish = globalThis.DiminaServiceBridge.publish
  globalThis.DiminaServiceBridge.canvasSyncSupported = true
  globalThis.DiminaServiceBridge.invoke = vi.fn(() => ({ contexts: {}, typedArrays: [] }))
  globalThis.DiminaServiceBridge.publish = vi.fn(); event('appShow')
})
afterEach(() => {
  for (const n of nodes.splice(0)) { n.dispose(); event('pageUnload', { bridgeId: n.bridgeId }) }
  event('appShow'); globalThis.DiminaServiceBridge.invoke = oldInvoke; globalThis.DiminaServiceBridge.publish = oldPublish
  delete globalThis.DiminaServiceBridge.canvasSyncSupported
})
function node(flag = 1, page = bridgeId) {
  event('canvasCapabilities', { bridgeId: page, capabilities: { webgl: { supported: true }, animationFrameStream: flag } })
  const n = createOffscreenCanvas({ type: 'webgl' }); nodes.push(n); return n
}
it('requires the versioned same-page capability and native support', () => {
  for (const v of [false, null, true, '1', 2]) expect(node(v)[key]).toBeUndefined()
  const n = node(false); node(1, bridgeId + '-other'); expect(n[key]).toBeUndefined()
  globalThis.DiminaServiceBridge.canvasSyncSupported = false; expect(node()[key]).toBeUndefined()
})
it('retains one real subscriber and acknowledges before running user work', () => {
  const n = node(), seen = [], cancel = n[key](t => seen.push([t, messages('canvasNodeAcknowledgeAnimationFrame').length])), s = start()
  expect(seen).toEqual([]); tick(s, 1, 17.25); tick(s, 2, 33.9)
  expect(seen).toEqual([[17.25, 1], [33.9, 2]]); expect(callback.callbacks[s.callback]).toBeTruthy()
  cancel(); expect(callback.callbacks[s.callback]).toBeUndefined(); expect(n.frameSubscriptions.size).toBe(0)
})
it('drops malformed, duplicate, out-of-order and other-generation ticks', () => {
  const n = node(), fn = vi.fn(), cancel = n[key](fn), s = start()
  callback.invoke(s.callback, null); tick(s, 1, Number.NaN); tick(s, 0, 10); tick(s, 1, 17, s.requestId + 1)
  tick(s, 1, 17); tick(s, 1, 20); tick(s, 2, 16); tick(s, 2, 34); tick(s, 1.5, 50)
  expect(fn.mock.calls).toEqual([[17], [34]]); expect(messages('canvasNodeAcknowledgeAnimationFrame')).toHaveLength(2); cancel()
})
it('cancels once and never revives from late delivery', () => {
  const n = node(), fn = vi.fn(), cancel = n[key](fn), s = start(); cancel(); cancel(); tick(s, 1, 17)
  expect(fn).not.toHaveBeenCalled(); expect(messages('canvasNodeCancelAnimationFrame')).toHaveLength(1)
})
it('suspends on hide and resumes a new generation without replaying old pulses', () => {
  const n = node(), fn = vi.fn(), cancel = n[key](fn), s = start(); tick(s, 1, 17)
  event('appHide'); expect(callback.isAllowedInBackground(s.callback)).toBe(true); tick(s, 2, 34)
  expect(fn).toHaveBeenCalledTimes(1); expect(messages('canvasNodeCancelAnimationFrame')).toHaveLength(1)
  event('appShow'); const next = start(); expect(next.requestId).not.toBe(s.requestId)
  tick(s, 3, 51); expect(fn).toHaveBeenCalledTimes(1); tick(next, 1, 68)
  expect(fn.mock.calls).toEqual([[17], [68]]); cancel()
})
it('appShow cannot resume a page still covered by another page', () => {
  const n = node(), cancel = n[key](() => {}); event('pageHide', { bridgeId }); event('appHide'); event('appShow')
  expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(1)
  event('pageShow', { bridgeId }); expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(2); cancel()
})
it('subscription created while hidden waits for its own page and app visibility', () => {
  event('pageHide', { bridgeId }); event('appHide'); const n = node(), cancel = n[key](() => {})
  expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(0)
  event('pageShow', { bridgeId }); expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(0)
  event('appShow'); expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(1); cancel()
})
it('teardown releases persistent state while suspended and ignores late pulses', () => {
  const n = node(), fn = vi.fn(); n[key](fn); const s = start(); event('appHide'); n.dispose(); tick(s, 1, 17); event('appShow')
  expect(fn).not.toHaveBeenCalled(); expect(n.frameSubscriptions.size).toBe(0); expect(callback.callbacks[s.callback]).toBeUndefined()
  expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(1)
})
it('flushes queued canvas creation before subscribing and bounds subscriber ownership', () => {
  const n = node(), cancel = []; for (let i = 0; i < 32; i++) cancel.push(n[key](() => {}))
  const names = globalThis.DiminaServiceBridge.publish.mock.calls.map(c => c[1].body.name)
  expect(names.indexOf('canvasNodeFlush')).toBeLessThan(names.indexOf('canvasNodeSubscribeAnimationFrame'))
  expect(() => n[key](() => {})).toThrow('exceed budget'); for (const c of cancel) c()
  expect(n.frameSubscriptions.size).toBe(0)
})
it('failed subscription or acknowledgement clears ownership and prevents implicit restart', () => {
  const n = node(); n.flushOperations(); globalThis.DiminaServiceBridge.publish.mockImplementationOnce(() => { throw new Error('closed') })
  expect(() => n[key](() => {})).toThrow('closed'); expect(n.frameSubscriptions.size).toBe(0)
  const fn = vi.fn(); n[key](fn); const s = start()
  globalThis.DiminaServiceBridge.publish.mockImplementationOnce(() => { throw new Error('closed ack') })
  expect(() => tick(s, 1, 17)).toThrow('closed ack'); expect(fn).not.toHaveBeenCalled(); expect(n.frameSubscriptions.size).toBe(0)
  const count = messages('canvasNodeSubscribeAnimationFrame').length; event('appHide'); event('appShow')
  expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(count)
})
it('throwing user work still returns its credit and remains cancellable', () => {
  const n = node(), cancel = n[key](() => { throw new Error('user') }), s = start()
  expect(() => tick(s, 1, 17)).toThrow('user'); expect(messages('canvasNodeAcknowledgeAnimationFrame')).toHaveLength(1); cancel()
})

const displayKey=Symbol.for('dimina.canvas.subscribeDisplayFrame')
function displayNative(){const fn=vi.fn(()=>true);globalThis.DiminaServiceBridge.displayFrameControl=fn;return fn}
function nativeStart(fn){return fn.mock.calls.filter(c=>c[0]===1).at(-1)}
function nativeTick(s,seq,stamp,clock='monotonic'){callback.invoke(s[4],{requestId:s[3],sequence:seq,timestamp:stamp,clock})}
it('offers native display only with an available scoped native controller',()=>{
 const n=node();expect(n[displayKey]).toBeUndefined();const native=displayNative()
 try{native.mockReturnValue(false);expect(n[displayKey]).toBeUndefined();native.mockImplementation(()=>{throw new Error('unavailable')});expect(n[displayKey]).toBeUndefined();native.mockReturnValue(true);expect(typeof n[displayKey]).toBe('function')}
 finally{delete globalThis.DiminaServiceBridge.displayFrameControl}
})
it('acknowledges native display before user work and preserves actual monotonic timestamps',()=>{
 const n=node(),native=displayNative(),seen=[];let cancel
 try{cancel=n[displayKey](ts=>seen.push([ts,native.mock.calls.filter(c=>c[0]===2).length]));const start=nativeStart(native);expect(start[1]).toBe(bridgeId);expect(start[2]).toBe(n.nodeId);expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(0)
 nativeTick(start,1,123456.125,'performance');nativeTick(start,1,123456.125);nativeTick(start,1,123456.5);nativeTick(start,2,123455);nativeTick(start,2,123472.75)
 expect(seen).toEqual([[123456.125,1],[123472.75,2]])}
 finally{cancel?.();delete globalThis.DiminaServiceBridge.displayFrameControl}
})
it('native hide/show uses a new generation and cannot replay old hardware pulses',()=>{
 const n=node(),native=displayNative(),seen=[];let cancel
 try{cancel=n[displayKey](ts=>seen.push(ts));const first=nativeStart(native);nativeTick(first,1,1000);event('appHide');nativeTick(first,2,1017);expect(seen).toEqual([1000]);expect(native.mock.calls.filter(c=>c[0]===3)).toHaveLength(1)
 event('appShow');const next=nativeStart(native);expect(next[3]).not.toBe(first[3]);nativeTick(first,3,1034);nativeTick(next,1,1051);expect(seen).toEqual([1000,1051])}
 finally{cancel?.();delete globalThis.DiminaServiceBridge.displayFrameControl}
})
it('native page hiding and disposal release owned callbacks and prevent restart',()=>{
 const n=node(),native=displayNative(),fn=vi.fn();let cancel
 try{event('pageHide',{bridgeId});cancel=n[displayKey](fn);expect(native.mock.calls.filter(c=>c[0]===1)).toHaveLength(0);event('pageShow',{bridgeId});const start=nativeStart(native);n.dispose();nativeTick(start,1,1000);event('appShow');expect(fn).not.toHaveBeenCalled();expect(n.frameSubscriptions.size).toBe(0);expect(callback.callbacks[start[4]]).toBeUndefined()}
 finally{cancel?.();delete globalThis.DiminaServiceBridge.displayFrameControl}
})
it('native subscribe and ACK failures clear ownership without replaying browser work',()=>{
 const n=node(),native=displayNative();let cancel
 try{native.mockImplementation(op=>op!==1);expect(()=>n[displayKey](()=>{})).toThrow('Native display');expect(n.frameSubscriptions.size).toBe(0);expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(0)
 native.mockReturnValue(true);cancel=n[displayKey](()=>{throw new Error('must not run after failed ACK')});const start=nativeStart(native);native.mockImplementation(op=>op!==2);expect(()=>nativeTick(start,1,1000)).toThrow('Native display');expect(n.frameSubscriptions.size).toBe(0);expect(messages('canvasNodeSubscribeAnimationFrame')).toHaveLength(0)}
 finally{cancel?.();delete globalThis.DiminaServiceBridge.displayFrameControl}
})
it('throwing native subscriber still releases credit and can cancel once',()=>{
 const n=node(),native=displayNative();let cancel
 try{cancel=n[displayKey](()=>{throw new Error('user')});const start=nativeStart(native);expect(()=>nativeTick(start,1,1000)).toThrow('user');expect(native.mock.calls.filter(c=>c[0]===2)).toHaveLength(1);cancel();cancel();expect(native.mock.calls.filter(c=>c[0]===3)).toHaveLength(1)}
 finally{cancel?.();delete globalThis.DiminaServiceBridge.displayFrameControl}
})
