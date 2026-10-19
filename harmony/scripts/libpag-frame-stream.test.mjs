import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = fs.readFileSync(process.env.DIMINA_LIBPAG_SOURCE ?? new URL('../../examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js', import.meta.url), 'utf8');
function viewPrototype() {
  if (!process.env.DIMINA_STREAM_BUNDLE) {
    const start = source.indexOf('  setTimer() {', source.indexOf('  calculateDisplaySize(canvas) {'));
    const end = source.indexOf('  resetSize(useScale = true) {', start);
    assert.ok(start > 0 && end > start);
    return vm.runInNewContext('class View {' + source.slice(start, end) + '}; View.prototype', { Symbol });
  }
  const modules = new Map(), exports = {};
  const context = vm.createContext({ Promise, Symbol, console, modDefine: (name, fn) => modules.set(name, fn),
    wx: { getFileSystemManager: () => ({}), env: { USER_DATA_PATH: '/unit' }, getSystemInfoSync: () => ({ SDKVersion: '3.4.0', pixelRatio: 1 }) },
    window: {}, navigator: { userAgent: 'unit', platform: 'unit' }, WXWebAssembly: {}, __exports: exports });
  vm.runInContext(fs.readFileSync(process.env.DIMINA_STREAM_BUNDLE, 'utf8'), context);
  const actual = modules.get('/miniprogram_npm/libpag-miniprogram/index').toString();
  const name = actual.match(/\.PAGView=([\w$]+)/)?.[1]; assert.ok(name);
  vm.runInContext('(' + actual.slice(0, -1) + ';arguments[2].__View=' + name + '})(function(){throw Error("unexpected import")},{exports:__exports},__exports)', context);
  return exports.__View.prototype;
}
const prototype = viewPrototype(), key = Symbol.for('dimina.canvas.subscribeAnimationFrame');
function fixture(capable = true, video = true) {
  let subscriptions = 0, cancellations = 0, ordinary = 0, ordinaryCancel = 0, flushes = 0, pulse;
  const view = Object.create(prototype);
  Object.assign(view, { player: { videoReaders: video ? [{}] : [] }, canvasElement: {
    requestAnimationFrame() { ordinary++; return 91 }, cancelAnimationFrame(id) { assert.equal(id, 91); ordinaryCancel++ },
  }, flushLoop() { flushes++ } });
  if (capable) view.canvasElement[key] = fn => { subscriptions++; pulse = fn; return () => cancellations++ };
  return { view, tick: t => pulse(t), stats: () => ({ subscriptions, cancellations, ordinary, ordinaryCancel, flushes }) };
}
test('video playback subscribes once and runs only after an actual frame pulse', () => {
  const f = fixture(); f.view.setTimer(); f.view.setTimer();
  assert.equal(f.stats().subscriptions, 1); assert.equal(f.stats().ordinary, 0); assert.equal(f.stats().flushes, 0);
  f.tick(17.25); f.tick(33.9); assert.equal(f.stats().flushes, 2); f.view.clearTimer();
});
test('pause cancels once and resume starts a fresh subscription', () => {
  const f = fixture(); f.view.setTimer(); f.view.flushPending = true; f.view.clearTimer(); f.view.clearTimer();
  assert.equal(f.stats().cancellations, 1); assert.equal(f.view.flushPending, false);
  f.view.setTimer(); assert.equal(f.stats().subscriptions, 2); f.view.clearTimer(); assert.equal(f.stats().cancellations, 2);
});
test('old SDK and non-video playback retain their actual one-shot RAF path', () => {
  for (const args of [[false, true], [true, false]]) {
    const f = fixture(...args); f.view.setTimer(); assert.equal(f.stats().subscriptions, 0); assert.equal(f.stats().ordinary, 1);
    f.view.clearTimer(); assert.equal(f.stats().ordinaryCancel, 1);
  }
});
test('failed subscription does not replay through a different scheduling path', () => {
  const f = fixture(); f.view.canvasElement[key] = () => { throw Error('closed') };
  assert.throws(() => f.view.setTimer(), /closed/); assert.equal(f.stats().ordinary, 0); assert.equal(f.stats().flushes, 0);
});

const displayKey=Symbol.for('dimina.canvas.subscribeDisplayFrame')
test('video playback prefers real native display callbacks when explicitly available',()=>{
 const f=fixture();let callback,cancelled=0
 f.view.canvasElement[displayKey]=fn=>{callback=fn;return()=>cancelled++}
 f.view.setTimer();f.view.setTimer();assert.equal(f.stats().subscriptions,0);assert.equal(f.stats().ordinary,0);assert.equal(f.stats().flushes,0)
 callback(12345678.125);assert.equal(f.stats().flushes,1);f.view.clearTimer();f.view.clearTimer();assert.equal(cancelled,1)
})
test('native display failure selects browser frames only before native delivery begins',()=>{
 const f=fixture();f.view.canvasElement[displayKey]=()=>{const e=Error('unavailable');e.code='NATIVE_DISPLAY_UNAVAILABLE';throw e}
 f.view.setTimer();assert.equal(f.stats().subscriptions,1);assert.equal(f.stats().flushes,0);f.tick(17.25);assert.equal(f.stats().flushes,1);f.view.clearTimer()
 const g=fixture();g.view.canvasElement[displayKey]=()=>{throw Error('unexpected')};assert.throws(()=>g.view.setTimer(),/unexpected/);assert.equal(g.stats().subscriptions,0)
})
test('nonvideo playback never starts the native hardware clock',()=>{
 const f=fixture(true,false);f.view.canvasElement[displayKey]=()=>{throw Error('nonvideo native clock must not run')};f.view.setTimer();assert.equal(f.stats().ordinary,1);f.view.clearTimer()
})
