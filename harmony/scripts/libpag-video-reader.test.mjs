import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'

const library = fs.readFileSync(process.env.DIMINA_LIBPAG_SOURCE ?? new URL('../../examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js', import.meta.url), 'utf8')
const begin = library.indexOf('function destroyVerify$1(')
const end = library.indexOf('\nconst measureText =', begin)
assert.ok(begin > 0 && end > begin)

function installReader(context) {
 if (!process.env.DIMINA_READER_BUNDLE) {
  vm.runInContext(library.slice(begin,end)+';globalThis.Reader=VideoReader;globalThis.frameFromOptions=frameDataOptions2FrameData',context);return;
 }
 const modules=new Map(),exports={};context.modDefine=(name,factory)=>modules.set(name,factory);
 context.wx??={};context.wx.getFileSystemManager=()=>({accessSync(){},mkdirSync(){},writeFileSync(){},unlinkSync(){},readdirSync(){return[]}});
 context.wx.env={USER_DATA_PATH:'/unit'};context.wx.getSystemInfoSync=()=>({SDKVersion:'3.4.0',pixelRatio:1});
 context.window={};context.navigator={userAgent:'unit',platform:'unit'};context.WXWebAssembly={};context.ArrayBuffer=ArrayBuffer;context.Uint8Array=Uint8Array;context.__readerExports=exports;
 vm.runInContext(fs.readFileSync(process.env.DIMINA_READER_BUNDLE,'utf8'),context);
 const actual=modules.get('/miniprogram_npm/libpag-miniprogram/index').toString();
 const reader=actual.match(/\.VideoReader=([\w$]+)/)?.[1];
 const view=actual.match(/\.PAGView=([\w$]+)/)?.[1];
 const converter=actual.match(/this\.getFrameDataResolve\(([\w$]+)\(this\.bufferIndex,/)?.[1];
 const module=(actual.match(/typeof ([\w$]+)\?\.__diminaCanvasPerf/) || actual.match(/([\w$]+)\.currentPlayer=this/))?.[1];
 assert.ok(reader&&converter&&module,'actual compiled reader, converter and module bindings must exist');
 const injected=actual.slice(0,-1)+';arguments[2].__compiledReader={Reader:'+reader+',View:'+view+',converter:'+converter+',setModule:value=>{'+module+'=value}}}';
 vm.runInContext('('+injected+')(function(){throw Error("unexpected module import")},{exports:__readerExports},__readerExports)',context,{timeout:2000});
 const compiled=exports.__compiledReader;context.CompiledView=compiled.View;compiled.setModule(context.PAGModule??{currentPlayer:null});context.frameFromOptions=compiled.converter;
 context.Reader=new Proxy(compiled.Reader,{construct(target,args,newTarget){const reader=Reflect.construct(target,args,newTarget),image=reader.arrayBufferImage,write=image.setFrameData.bind(image);image.setFrameData=frame=>{image.frame=frame;write(frame)};return reader;}});
}
function frameFromOptions(options) {
  const context = vm.createContext({ console, ArrayBuffer, Uint8Array })
  installReader(context)
  return context.frameFromOptions(7, options)
}

test('libpag reuses only explicitly owned independent native ArrayBuffers', () => {
  const data = Uint8Array.of(17, 19, 23, 255).buffer
  const frame = frameFromOptions({ data, dataOwned: true, width: 1, height: 1 })
  assert.equal(frame.data, data, 'an independently owned frame needs no second RGBA allocation')
  assert.equal(frame.id, 7)
  assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
})

test('libpag keeps the defensive copy for old native hosts and WeChat frames', () => {
  for (const dataOwned of [undefined, false, 1, 'true', null]) {
    const bytes = Uint8Array.of(17, 19, 23, 255)
    const frame = frameFromOptions({ data: bytes.buffer, dataOwned, width: 1, height: 1 })
    assert.notEqual(frame.data, bytes.buffer)
    bytes.fill(0)
    assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
  }
})

test('libpag does not treat shared storage as an independently owned frame', () => {
  const data = new SharedArrayBuffer(4), bytes = new Uint8Array(data)
  bytes.set([17, 19, 23, 255])
  const frame = frameFromOptions({ data, dataOwned: true, width: 1, height: 1 })
  assert.ok(frame.data instanceof ArrayBuffer)
  assert.notEqual(frame.data, data)
  bytes.fill(0)
  assert.deepEqual([...new Uint8Array(frame.data)], [17, 19, 23, 255])
})

test('vendored libpag stops video polling before its destroy guard takes effect', () => {
  const intervals = new Map()
  const errors = []
  let serial = 0
  let reads = 0
  let removals = 0
  let unlinks = 0
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args) },
    setInterval(fn) { intervals.set(++serial, fn); return serial },
    clearInterval(id) { intervals.delete(id) },
  })
  installReader(context)
  const reader = Object.create(context.Reader.prototype)
  Object.assign(reader, {
    isDestroyed: false, frameDataBuffers: [], bufferIndex: 0,
    videoDecoder: { getFrameData() { reads++; return null }, remove() { removals++ } },
    player: { unlinkVideoReader(value) { assert.equal(value, reader); unlinks++ } },
    getFrameDataResolve() { assert.equal(reader.isDestroyed, true) },
  })
  reader.startGetFrameDataLoop()
  assert.equal(intervals.size, 1)
  for (const tick of intervals.values()) tick()
  assert.equal(reads, 1)
  reader.onDestroy()
  assert.equal(intervals.size, 0, 'destroy must cancel the real polling interval')
  assert.equal(reader.getFrameDataLoopTimer, null)
  assert.equal(reader.getFrameDataLooping, false)
  assert.equal(reader.isDestroyed, true)
  assert.equal(removals, 1)
  assert.equal(unlinks, 1)
  assert.deepEqual(errors, [], 'cleanup must not call a method blocked by destroyVerify')
  for (const tick of intervals.values()) tick()
  assert.equal(reads, 1)
})

async function playbackFixture(owner, currentPlayer = null, factory = false) {
  const intervals = new Map(), listeners = new Map(), seeks = [], errors = [], frames = []
  let serial = 0
  const decoder = {
    on(name, listener) { listeners.set(name, listener) },
    start: async () => ({}),
    seek: async position => { seeks.push(position) },
    getFrameData: () => frames.shift() ?? null,
    remove() {},
  }
  const context = vm.createContext({
    ArrayBuffer, Uint8Array,
    console: { error: (...args) => errors.push(args) },
    setInterval(fn) { intervals.set(++serial, fn); return serial },
    clearInterval(id) { intervals.delete(id) },
    wx: { createVideoDecoder: () => decoder },
    MP4_CACHE_PATH: '/video/', touchDirectory() {}, writeFile() {}, removeFile() {},
    PAGModule: { currentPlayer },
    ArrayBufferImage: class { setFrameData(frame) { this.frame = frame } },
  })
  installReader(context)
  const args = [new Uint8Array([1]), 1, 1, 25, [], owner]
  const reader = factory ? await context.Reader.create(...args) : new context.Reader(...args)
  await reader.videoDecoderPromise
  return { reader, intervals, seeks, errors, frames, decoder, ended: () => listeners.get('ended')(),
    tick: () => { for (const fn of [...intervals.values()]) fn() } }
}

for (const factory of [false, true]) test(`video reader ${factory ? 'factory' : 'constructor'} uses the explicit owner during another player Wasm work`, async () => {
  const linked = [], other = []
  const owner = { linkVideoReader: reader => linked.push(reader), unlinkVideoReader() {} }
  const active = { linkVideoReader: reader => other.push(reader) }
  const f = await playbackFixture(owner, active, factory)
  assert.equal(f.reader.player === owner, true, 'the explicit reader owner must survive another active player')
  assert.equal(linked.length, 1)
  assert.equal(other.length, 0, 'preparation must not adopt the player currently executing Wasm')
  f.reader.onDestroy()
})

test('decoder EOF preserves the unread tail and stops polling without rewinding', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 238
  f.reader.bufferIndex = 240
  const tail = { id: 239, data: Uint8Array.of(3, 5, 7, 255).buffer, width: 1, height: 1 }
  f.reader.frameDataBuffers.push(tail)
  f.ended()
  await Promise.resolve()
  assert.deepEqual(f.seeks, [], 'prefetch EOF must not seek away from the still-unread tail')
  assert.equal(f.reader.bufferIndex, 240, 'EOF must preserve the next sequential frame index')
  assert.equal(f.intervals.size, 0, 'EOF must stop polling an exhausted decoder')
  assert.equal(f.reader.frameDataBuffers[0], tail)
})

test('the last buffered frame remains available after decoder EOF', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 238
  f.reader.bufferIndex = 240
  const tail = { id: 239, data: Uint8Array.of(9, 11, 13, 255).buffer, width: 1, height: 1 }
  f.reader.frameDataBuffers.push(tail)
  f.ended()
  await f.reader.prepare(239)
  assert.equal(f.reader.arrayBufferImage.frame, tail)
  assert.equal(f.reader.currentFrame, 239)
  assert.deepEqual(f.seeks, [], 'consuming a buffered tail must not rebuild or rewind the decoder')
})

test('playback loops by seeking only when the requested frame wraps to the start', async () => {
  const f = await playbackFixture()
  f.reader.currentFrame = 239
  f.reader.bufferIndex = 240
  f.ended()
  assert.deepEqual(f.seeks, [], 'EOF alone does not request another loop')
  const prepared = f.reader.prepare(0)
  await new Promise(setImmediate)
  assert.deepEqual(f.seeks, [0])
  assert.equal(f.reader.seeking, false)
  assert.equal(f.intervals.size, 1, 'the new seek resumes polling for real decoded frames')
  f.frames.push({ data: Uint8Array.of(17, 19, 23, 255).buffer, width: 1, height: 1 })
  f.tick()
  await prepared
  assert.equal(f.reader.currentFrame, 0)
  assert.equal(f.reader.arrayBufferImage.frame.id, 0)
  assert.deepEqual([...new Uint8Array(f.reader.arrayBufferImage.frame.data)], [17, 19, 23, 255])
  f.reader.onDestroy()
  assert.equal(f.intervals.size, 0)
})

test('a late decoder EOF after reader destruction performs no seek or guarded cleanup', async () => {
  const f = await playbackFixture()
  f.reader.onDestroy()
  f.ended()
  await Promise.resolve()
  assert.deepEqual(f.seeks, [])
  assert.deepEqual(f.errors, [])
  assert.equal(f.intervals.size, 0)
})

async function warmFixture(){
 const f=await playbackFixture();f.permission={allowed:true};
 f.reader.player={__diminaLoopPrefetchAllowed:()=>f.permission.allowed,unlinkVideoReader(){}};
 f.reader.currentFrame=238;f.reader.bufferIndex=240;
 f.tail={id:239,data:Uint8Array.of(9,11,13,255).buffer,width:1,height:1};f.reader.frameDataBuffers.push(f.tail);
 return f;
}
const idle=()=>new Promise(setImmediate);
const raw=value=>({data:Uint8Array.of(value,0,0,255).buffer,dataOwned:true,width:1,height:1});
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}}
test('warm loop retains the unread tail and adopts a separately decoded real first frame',async()=>{
 const f=await warmFixture();f.ended();await idle();assert.deepEqual(f.seeks,[0]);assert.equal(f.reader.bufferIndex,240);assert.equal(f.reader.frameDataBuffers[0],f.tail);
 f.frames.push(raw(17));f.tick();await idle();assert.equal(f.reader.loopWarm.frames[0].id,0);assert.equal(f.intervals.size,0);
 await f.reader.prepare(239);assert.equal(f.reader.arrayBufferImage.frame,f.tail);assert.equal(f.reader.isSought,false);
 await f.reader.prepare(0);assert.deepEqual([...new Uint8Array(f.reader.arrayBufferImage.frame.data)],[17,0,0,255]);assert.equal(f.reader.isSought,false);assert.equal(f.reader.bufferIndex,1);assert.deepEqual(f.seeks,[0]);
 f.frames.push(raw(29));f.tick();await f.reader.prepare(1);assert.equal(f.reader.arrayBufferImage.frame.id,1);assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],29);f.reader.onDestroy();assert.equal(f.intervals.size,0);
});
test('a loop that has no real first frame ready still waits and keeps the existing seek-clock signal',async()=>{
 const f=await warmFixture();f.ended();await idle();const prepared=f.reader.prepare(0);let complete=false;prepared.then(()=>complete=true);await idle();assert.equal(complete,false);assert.equal(f.reader.isSought,true);
 f.tick();await idle();assert.equal(complete,false);f.frames.push(raw(31));f.tick();await prepared;assert.equal(f.reader.currentFrame,0);assert.equal(f.reader.isSought,true);assert.deepEqual(f.seeks,[0]);f.reader.onDestroy();
});
test('manual paused seek cancels warm state and uses the real requested position',async()=>{
 const f=await warmFixture(),pending=deferred();f.decoder.seek=position=>{f.seeks.push(position);return position===0?pending.promise:Promise.resolve()};f.ended();f.permission.allowed=false;
 const prepared=f.reader.prepare(120);await idle();assert.deepEqual(f.seeks,[0,4800]);assert.equal(f.reader.loopWarm,null);f.frames.push(raw(37));f.tick();await prepared;
 pending.resolve();await idle();assert.equal(f.reader.currentFrame,120);assert.equal(f.reader.arrayBufferImage.frame.id,120);assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],37);assert.equal(f.reader.isSought,true);f.reader.onDestroy();assert.equal(f.intervals.size,0);
});
test('destruction cancels a pending warm wait and ignores a late native seek result',async()=>{
 const f=await warmFixture(),pending=deferred();f.decoder.seek=position=>{f.seeks.push(position);return pending.promise};f.ended();const prepared=f.reader.prepare(0);await idle();f.reader.onDestroy();await prepared;
 pending.resolve();await idle();f.ended();assert.equal(f.intervals.size,0);assert.deepEqual(f.errors,[]);assert.deepEqual(f.seeks,[0]);assert.equal(f.reader.loopWarm,null);
});
test('failed warm seek preserves tail pixels and propagates failure without replay',async()=>{
 const f=await warmFixture();f.decoder.seek=position=>{f.seeks.push(position);return Promise.reject(Error('real codec failure'))};f.ended();await idle();await f.reader.prepare(239);assert.equal(f.reader.arrayBufferImage.frame,f.tail);
 await assert.rejects(f.reader.prepare(0),/real codec failure/);assert.deepEqual(f.seeks,[0]);assert.equal(f.intervals.size,0);f.reader.onDestroy();
});
test('a queued stale warm timer cannot consume a second frame beyond the one-frame budget',async()=>{
 const f=await warmFixture();f.ended();await idle();const queued=[...f.intervals.values()][0];f.frames.push(raw(41),raw(43));queued();queued();assert.equal(f.reader.loopWarm.frames.length,1);assert.equal(f.frames.length,1);
 await f.reader.prepare(0);f.tick();await f.reader.prepare(1);assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],43);f.reader.onDestroy();
});
test('EOF while the current warm seek is pending never starts another seek',async()=>{
 const f=await warmFixture(),pending=deferred();f.decoder.seek=position=>{f.seeks.push(position);return pending.promise};f.ended();f.ended();await idle();assert.deepEqual(f.seeks,[0]);f.reader.onDestroy();pending.resolve();await idle();assert.equal(f.intervals.size,0);
});
test('real EOF before a warm first frame rejects the loop and stops its polling',async()=>{
 const f=await warmFixture();f.ended();await idle();f.ended();await assert.rejects(f.reader.prepare(0),/ended before first loop frame/);assert.equal(f.intervals.size,0);assert.deepEqual(f.seeks,[0]);f.reader.onDestroy();
});
test('oversized warm frames preserve the tail and fall back to normal decoding without failing playback',async()=>{
 const f=await warmFixture();f.ended();await idle();const bytes=2048*1025*4;
 const tooLarge={data:new ArrayBuffer(bytes),dataOwned:true,width:2048,height:1025};new Uint8Array(tooLarge.data)[0]=81;
 f.frames.push(tooLarge);f.tick();
 assert.equal(f.reader.loopWarm,null,'the optional warm allocation must be released');assert.equal(f.reader.loopWarmPrefetch,false);assert.equal(f.reader.frameDataBuffers[0],f.tail);assert.equal(f.intervals.size,0);
 await f.reader.prepare(239);assert.equal(f.reader.arrayBufferImage.frame,f.tail);
 const prepared=f.reader.prepare(0);await idle();assert.deepEqual(f.seeks,[0,0]);
 const actual={data:new ArrayBuffer(bytes),dataOwned:true,width:2048,height:1025};new Uint8Array(actual.data)[0]=83;f.frames.push(actual);f.tick();await prepared;
 assert.equal(f.reader.currentFrame,0);assert.equal(f.reader.arrayBufferImage.frame.data===actual.data,true,'owned native frame remains independent and needs no copy');assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],83);assert.equal(f.reader.isSought,true);f.reader.onDestroy();assert.equal(f.intervals.size,0);
});
test('a waiting loop resumes through a real seek after its oversized optional frame is discarded',async()=>{
 const f=await warmFixture();f.ended();await idle();const queued=[...f.intervals.values()][0],prepared=f.reader.prepare(0);let completed=false;prepared.then(()=>completed=true);await idle();assert.equal(completed,false);
 f.frames.push({data:new ArrayBuffer(2048*1025*4),dataOwned:true,width:2048,height:1025});f.tick();await idle();assert.equal(f.reader.loopWarm,null);assert.equal(completed,false);assert.deepEqual(f.seeks,[0,0]);
 f.frames.push(raw(89));queued();assert.equal(f.frames.length,1,'the stale warm callback cannot consume the fresh normal-seek frame');f.tick();await prepared;
 assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],89);assert.equal(f.reader.isSought,true);assert.deepEqual(f.errors,[]);f.reader.onDestroy();assert.equal(f.intervals.size,0);
});

test('two readers preserve separate tails and next-loop frame ownership',async()=>{
 const a=await warmFixture(),b=await warmFixture();a.ended();b.ended();await idle();a.frames.push(raw(47));b.frames.push(raw(53));a.tick();b.tick();await Promise.all([a.reader.prepare(0),b.reader.prepare(0)]);
 assert.equal(new Uint8Array(a.reader.arrayBufferImage.frame.data)[0],47);assert.equal(new Uint8Array(b.reader.arrayBufferImage.frame.data)[0],53);a.reader.onDestroy();assert.equal(b.reader.isDestroyed,false);b.reader.onDestroy();assert.equal(a.intervals.size+b.intervals.size,0);
});
test('each loop decodes a fresh first frame and does not reuse the previous loop image',async()=>{
 const f=await warmFixture();f.ended();await idle();f.frames.push(raw(59));f.tick();await f.reader.prepare(0);const first=f.reader.arrayBufferImage.frame;
 f.reader.bufferIndex=2;f.reader.frameDataBuffers.push({id:1,...raw(61)});f.ended();await idle();f.frames.push(raw(67));f.tick();await f.reader.prepare(1);assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],61);await f.reader.prepare(0);
 assert.notEqual(f.reader.arrayBufferImage.frame,first);assert.equal(new Uint8Array(f.reader.arrayBufferImage.frame.data)[0],67);assert.deepEqual(f.seeks,[0,0]);f.reader.onDestroy();
});
test('a queued old polling callback cannot mix next-loop pixels into the unread tail',async()=>{
 const f=await warmFixture(),oldTick=[...f.intervals.values()][0];f.ended();await idle();f.frames.push(raw(71));oldTick();
 assert.equal(f.frames.length,1);assert.equal(f.reader.frameDataBuffers.length,1);assert.equal(f.reader.frameDataBuffers[0],f.tail);assert.equal(f.reader.bufferIndex,240);f.reader.onDestroy();
});
test('repeat permission preserves finite playback, pause and missing-capability behavior',()=>{
 const a=library.indexOf('  setRepeatCount(repeatCount) {'),b=library.indexOf('  getProgress() {',a);assert.ok(a>0&&b>a);
 const context=vm.createContext({Symbol});if(process.env.DIMINA_READER_BUNDLE)installReader(context);else vm.runInContext('globalThis.View=class{'+library.slice(a,b)+'}',context);
 const gl={[Symbol.for('dimina.canvas.createBufferAsync')]:()=>{throw Error('permission must not allocate')}};
 const view=process.env.DIMINA_READER_BUNDLE?Object.create(context.CompiledView.prototype):new context.View();Object.assign(view,{player:{},canvasElement:{getContext:()=>gl},isPlaying:true,isDestroyed:false,repeatedTimes:0});
 view.setRepeatCount(1);assert.equal(view.player.__diminaLoopPrefetchAllowed(),false);
 view.setRepeatCount(2);assert.equal(view.player.__diminaLoopPrefetchAllowed(),true);view.repeatedTimes=1;assert.equal(view.player.__diminaLoopPrefetchAllowed(),false);
 view.setRepeatCount(0);assert.equal(view.player.__diminaLoopPrefetchAllowed(),true);view.isPlaying=false;assert.equal(view.player.__diminaLoopPrefetchAllowed(),false);
 view.isPlaying=true;view.isDestroyed=true;assert.equal(view.player.__diminaLoopPrefetchAllowed(),false);view.isDestroyed=false;view.canvasElement.getContext=()=>({});view.setRepeatCount(0);assert.equal(view.player.__diminaLoopPrefetchAllowed(),false);
});
test('supported loop prefetch restarts polling as consumption reaches the low watermark',async()=>{
 const f=await warmFixture();f.reader.clearFrameDataLoop();f.reader.currentFrame=236;f.reader.frameDataBuffers=[{id:237,...raw(73)},{id:238,...raw(79)},f.tail];
 await f.reader.prepare(237);assert.equal(f.reader.frameDataBuffers.length,2);assert.equal(f.intervals.size,1);assert.equal(f.reader.getFrameDataLooping,true);f.reader.onDestroy();
});
test('legacy readers keep their original refill timing without loop permission',async()=>{
 const f=await warmFixture();f.permission.allowed=false;f.reader.clearFrameDataLoop();f.reader.currentFrame=236;f.reader.frameDataBuffers=[{id:237,...raw(73)},{id:238,...raw(79)},f.tail];
 await f.reader.prepare(237);assert.equal(f.reader.frameDataBuffers.length,2);assert.equal(f.intervals.size,0);f.reader.onDestroy();
});
