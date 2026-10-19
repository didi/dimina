import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = fs.readFileSync(process.env.DIMINA_LIBPAG_SOURCE ?? new URL('../../examples/miniprogram/base/miniprogram_npm/libpag-miniprogram/index.js', import.meta.url), 'utf8');
const helperStart=source.indexOf('class AsyncFrameBuffers {'), helperEnd=source.indexOf('\nfunction destroyVerify$1',helperStart);
const queueStart=source.indexOf('class WebAssemblyQueue {'), queueEnd=source.indexOf('\nvar PAGInit$1',queueStart);
const player=source.indexOf('let PAGPlayer ='), methods=source.indexOf('  flush() {',player), methodsEnd=source.indexOf('  duration() {',methods);
const destroy=source.indexOf('  destroy() {',player), destroyEnd=source.indexOf('  linkVideoReader(',destroy);
const manager=source.indexOf('let VideoReaderManager ='),managerEnd=source.indexOf('\nVideoReaderManager = __decorateClass$5',manager);
const prepare=source.indexOf('  prepareVideoFrame() {',player),prepareEnd=source.indexOf('  destroyVideoReaderManager() {',prepare);
assert.ok(helperStart>0 && helperEnd>helperStart && queueStart>0 && methodsEnd>methods);
function asyncGenerator(self, _, generator) {
  const iterator=generator.call(self);
  return new Promise((resolve,reject)=>{
    const next=(method,value)=>{
      let r;try{r=iterator[method](value)}catch(e){reject(e);return}
      if(r.done)resolve(r.value);else Promise.resolve(r.value).then(v=>next('next',v),e=>next('throw',e));
    };next('next');
  });
}
function compiledFixture() {
  const registry=new Map(),exports={};
  const sandbox=vm.createContext({Promise,Symbol,console,modDefine:(name,factory)=>registry.set(name,factory),
    wx:{getFileSystemManager:()=>({}),env:{USER_DATA_PATH:'/unit'},getSystemInfoSync:()=>({SDKVersion:'3.4.0',pixelRatio:1})},
    window:{},navigator:{userAgent:'unit',platform:'unit'},WXWebAssembly:{},__exports:exports});
  vm.runInContext(fs.readFileSync(process.env.DIMINA_PIPELINE_BUNDLE,'utf8'),sandbox);
  const actual=registry.get('/miniprogram_npm/libpag-miniprogram/index').toString();
  const helper=actual.match(/class ([\w$]+)\{constructor\(\)\{this\.players=new WeakMap,this\.executing=null,this\.prefetchAtBegin=/)?.[1];
  assert.ok(helper,'compiled private helper class must exist');
  const instance=actual.match(new RegExp('const ([\\w$]+)=new '+helper+'[,;]'))?.[1];
  const player=actual.match(/\.PAGPlayer=([\w$]+)/)?.[1],queue=actual.match(/\.webAssemblyQueue=new ([\w$]+)/)?.[1];
  const module=(actual.match(/typeof ([\w$]+)\?\.__diminaCanvasPerf/) || actual.match(/([\w$]+)\.currentPlayer=this/))?.[1];
  assert.ok(instance&&player&&queue&&module,'actual compiled bindings must all resolve');
  const instrumented=actual.slice(0,-1)+';arguments[2].__compiled={buffers:'+instance+',Player:'+player+',Queue:'+queue+',currentOwner:()=>'+module+'.currentPlayer,setModule:value=>{'+module+'=value}}}';
  vm.runInContext('('+instrumented+')(function(){throw Error("unexpected module import")},{exports:__exports},__exports)',sandbox,{timeout:2000});
  const compiled=exports.__compiled,buffers=compiled.buffers;compiled.setModule({webAssemblyQueue:new compiled.Queue(),currentPlayer:null});
  const created=[],deleted=[],order=[];let n=0;
  const context={createBuffer(){const buffer={id:++n};created.push(buffer);order.push('sync-create');return buffer},deleteBuffer:b=>deleted.push(b)};
  const p=Object.create(compiled.Player.prototype);p.videoReaders=[{getError:async()=>null}];p.prepareVideoFrame=async()=>{};p.destroyVideoReaderManager=()=>{};
  p.wasmIns={_flush:()=>buffers.create(context),delete(){}};
  return{p,buffers,context,created,deleted,order,currentOwner:compiled.currentOwner,configureModule:compiled.setModule};
}
function fixture() {
  if (process.env.DIMINA_PIPELINE_BUNDLE) return compiledFixture();
  const sandbox=vm.createContext({Promise,Symbol,console,__async:asyncGenerator,__async$1:asyncGenerator,__async$2:asyncGenerator});
  vm.runInContext(source.slice(helperStart,helperEnd)+source.slice(queueStart,queueEnd)+
    ';const PAGModule={webAssemblyQueue:new WebAssemblyQueue()};'+source.slice(manager,managerEnd)+'class Player{'+source.slice(methods,methodsEnd)+source.slice(destroy,destroyEnd)+source.slice(prepare,prepareEnd)+'};globalThis.Player=Player;globalThis.buffers=asyncFrameBuffers;globalThis.currentOwner=()=>PAGModule.currentPlayer;globalThis.configureModule=value=>Object.assign(PAGModule,value);',sandbox);
  const buffers=sandbox.buffers, created=[], deleted=[], order=[];
  let n=0;
  const context={createBuffer(){const buffer={id:++n};created.push(buffer);order.push('sync-create');return buffer},deleteBuffer:b=>deleted.push(b)};
  const p=new sandbox.Player();p.videoReaders=[{getError:async()=>null}];p.prepareVideoFrame=async()=>{};p.destroyVideoReaderManager=()=>{};
  p.wasmIns={_flush:()=>buffers.create(context),delete(){}};
  return {p,buffers,context,created,deleted,order,currentOwner:sandbox.currentOwner,configureModule:sandbox.configureModule};
}
const tick=()=>new Promise(setImmediate);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const key=Symbol.for('dimina.canvas.createBufferAsync');

function preparedFixture(){
 const f=fixture(),requests=[],listeners=new Map();
 f.context.canvas={addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn)},removeEventListener(type,fn){listeners.get(type)?.delete(fn)}};
 f.context[key]=()=>{const value=deferred();requests.push(value);f.order.push('request-'+requests.length);return value.promise};
 return Object.assign(f,{requests,listeners,emit(type){for(const fn of [...(listeners.get(type)||[])])fn()},listenerCount(){return [...listeners.values()].reduce((n,set)=>n+set.size,0)}});
}
function ids(values){return values.map(v=>v.id).sort((a,b)=>a-b)}
test('first frame and old contexts keep actual ordinary creation',async()=>{
 const f=fixture();assert.equal(await f.p.flush(),f.created[0]);assert.equal(await f.p.flush(),f.created[1]);assert.equal(f.created.length,2);
});
test('starts the following actual request before video preparation and awaits the separate current ACK',async()=>{
 const f=preparedFixture();await f.p.flush();assert.equal(f.requests.length,1);f.order.length=0;
 const video=deferred();f.p.prepareVideoFrame=()=>{f.order.push('video');return video.promise};
 const run=f.p.flush();assert.deepEqual(f.order,['request-2','video']);assert.equal(f.requests.length,2);
 f.requests[1].resolve({id:102});video.resolve();await tick();assert.equal(f.created.length,1);
 f.requests[0].resolve({id:101});assert.deepEqual(await run,{id:101});assert.equal(f.requests.length,2);
 f.p.destroy();await tick();assert.deepEqual(ids(f.deleted),[102]);assert.equal(f.listenerCount(),0);
});
test('preserves real null without issuing a replacement current allocation',async()=>{
 const f=preparedFixture();await f.p.flush();const run=f.p.flush();f.requests[0].resolve(null);
 assert.equal(await run,null);assert.equal(f.created.length,1);assert.equal(f.requests.length,2);
 f.p.destroy();f.requests[1].resolve({id:103});await tick();assert.deepEqual(ids(f.deleted),[103]);
});
test('unused current and future actual objects are each deleted once',async()=>{
 const f=preparedFixture();await f.p.flush();f.p.wasmIns._flush=()=>false;const run=f.p.flush();
 f.requests[0].resolve({id:104});f.requests[1].resolve({id:105});assert.equal(await run,false);await tick();
 assert.deepEqual(ids(f.deleted),[104]);assert.equal(f.listenerCount(),2,'one idle future remains bounded across no-op work');f.p.destroy();assert.deepEqual(ids(f.deleted),[104,105]);assert.equal(f.listenerCount(),0);
});
test('failed video preparation cleans both late actual allocations and schedules no replacement',async()=>{
 const f=preparedFixture();await f.p.flush();f.p.prepareVideoFrame=async()=>{throw Error('video failed')};
 await assert.rejects(f.p.flush(),/video failed/);assert.equal(f.requests.length,2);
 f.requests[0].resolve({id:106});f.requests[1].resolve({id:107});await tick();
 assert.deepEqual(ids(f.deleted),[106,107]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('destroy cancels current preparation and the idle future ticket without entering deleted Wasm',async()=>{
 const f=preparedFixture();await f.p.flush();let flushed=0;f.p.wasmIns._flush=()=>{flushed++;return true};
 const run=f.p.flush();f.p.destroy();await assert.rejects(run,/cancelled/);
 f.requests[0].resolve({id:108});f.requests[1].resolve({id:109});await tick();
 assert.equal(flushed,0);assert.deepEqual(ids(f.deleted),[108,109]);assert.equal(f.listenerCount(),0);
});
test('changed contexts use actual creation and release both unused old-context allocations',async()=>{
 const f=preparedFixture();await f.p.flush();const actual={id:110};const other={createBuffer:()=>actual};
 f.p.wasmIns._flush=()=>f.buffers.create(other);const run=f.p.flush();
 f.requests[0].resolve({id:111});f.requests[1].resolve({id:112});assert.equal(await run,actual);await tick();
 assert.deepEqual(ids(f.deleted),[111,112]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('concurrent flushes retain separate actual current tickets and only one idle future ticket',async()=>{
 const f=preparedFixture();await f.p.flush();const one=f.p.flush(),two=f.p.flush();assert.equal(f.requests.length,3);
 f.requests[1].resolve({id:114});f.requests[0].resolve({id:113});
 const actual=await Promise.all([one,two]);assert.deepEqual(actual,[{id:113},{id:114}]);
 assert.equal(f.buffers.players.get(f.p).runs.size,0);assert.equal(f.requests.length,3);
 f.p.destroy();f.requests[2].resolve({id:115});await tick();assert.deepEqual(ids(f.deleted),[115]);assert.equal(f.listenerCount(),0);
});
test('busy preflight falls back only to one real ordinary current creation',async()=>{
 const f=fixture();f.context[key]=()=>Promise.reject(Object.assign(Error('busy'),{code:'CANVAS_BUFFER_PREPARE_BUSY'}));
 await f.p.flush();const result=await f.p.flush();assert.equal(result,f.created[1]);assert.equal(f.created.length,2);f.p.destroy();
});
test('transport failure aborts the current frame without replaying its actual request',async()=>{
 const f=preparedFixture();await f.p.flush();const run=f.p.flush();f.requests[0].reject(Error('transport failed'));
 await assert.rejects(run,/transport failed/);assert.equal(f.created.length,1);assert.equal(f.requests.length,2);
 f.requests[1].resolve({id:116});await tick();assert.deepEqual(ids(f.deleted),[116]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('non-video work releases the idle ticket and does not prefetch again',async()=>{
 const f=preparedFixture();await f.p.flush();f.requests[0].resolve({id:117});await tick();f.p.videoReaders=[];
 await f.p.flush();assert.equal(f.created.length,2);assert.equal(f.requests.length,1);assert.deepEqual(ids(f.deleted),[117]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('capability removal releases the prepared ticket and keeps original real creation',async()=>{
 const f=preparedFixture();await f.p.flush();f.requests[0].resolve({id:118});await tick();delete f.context[key];
 await f.p.flush();assert.equal(f.created.length,2);assert.deepEqual(ids(f.deleted),[118]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('an idle ACK received before context loss is never consumed after restoration',async()=>{
 const f=preparedFixture();await f.p.flush();f.requests[0].resolve({id:119});await tick();assert.equal(f.listenerCount(),2);
 f.emit('webglcontextlost');f.emit('webglcontextrestored');let flushed=0;f.p.wasmIns._flush=()=>{flushed++;return true};
 await assert.rejects(f.p.flush(),/context changed/);assert.equal(flushed,0);f.requests[1].resolve({id:120});await tick();
 assert.deepEqual(ids(f.deleted),[119,120]);assert.equal(f.listenerCount(),0);f.p.destroy();
});
test('a context change after current ACK but before Wasm prevents using the old object',async()=>{
 const f=preparedFixture();await f.p.flush();const video=deferred();f.p.prepareVideoFrame=()=>video.promise;
 const run=f.p.flush();f.requests[0].resolve({id:121});await tick();f.emit('webglcontextlost');video.resolve();
 await assert.rejects(run,/context changed/);f.requests[1].resolve({id:122});await tick();
 assert.deepEqual(ids(f.deleted),[121,122]);assert.equal(f.listenerCount(),0);assert.equal(f.created.length,1);f.p.destroy();
});
test('an idle resolved ticket is released with its event listeners on player destruction',async()=>{
 const f=preparedFixture();await f.p.flush();f.requests[0].resolve({id:123});await tick();f.p.destroy();
 assert.deepEqual(ids(f.deleted),[123]);assert.equal(f.listenerCount(),0);f.emit('webglcontextlost');assert.equal(f.deleted.length,1);
});
test('flushInternal preserves its original callback and reader error checks',async()=>{
 const f=preparedFixture();await f.p.flush();let checks=0;f.p.videoReaders=[{getError:async()=>{checks++;return null}}];const received=[];
 const run=f.p.flushInternal(value=>received.push(value));f.requests[0].resolve({id:124});assert.deepEqual(await run,{id:124});
 assert.deepEqual(received,[{id:124}]);assert.equal(checks,1);f.p.destroy();f.requests[1].resolve({id:125});await tick();assert.deepEqual(ids(f.deleted),[125]);
});
test('limits lookahead to sixteen active current tickets and one idle future ticket',async()=>{
 const f=preparedFixture();await f.p.flush();const runs=Array.from({length:17},()=>f.p.flush());
 assert.equal(f.requests.length,17);
 for(let i=0;i<17;i++)f.requests[i].resolve({id:200+i});
 const actual=await Promise.all(runs);assert.equal(actual.length,17);assert.equal(new Set(actual).size,17);
 assert.equal(f.buffers.players.get(f.p).runs.size,0);assert.equal(f.requests.length,18);
 f.p.destroy();f.requests[17].resolve({id:217});await tick();
 assert.deepEqual(ids(f.deleted),[216,217]);assert.equal(f.listenerCount(),0);
});

test('a frame with no GL allocations does not force the next changed frame back through synchronous allocation',async()=>{
 const f=preparedFixture();await f.p.flush();const render=f.p.wasmIns._flush;
 f.p.wasmIns._flush=()=>false;const idle=f.p.flush();f.requests[0].resolve({id:301});f.requests[1].resolve({id:302});await idle;
 f.p.wasmIns._flush=render;const changed=f.p.flush();await tick();
 assert.equal(f.created.length,1,'a no-op must preserve the observed buffer context for the next real frame');
 assert.deepEqual(await changed,{id:302});assert.equal(f.requests.length,3);f.p.destroy();f.requests[2].resolve({id:303});await tick();
 assert.deepEqual(ids(f.deleted),[301,303]);assert.equal(f.listenerCount(),0);
});

for (const method of ['flush','flushInternal']) test(method+' restores its own player before queued Wasm work after overlapping preparation',async()=>{
 const f=fixture(),one=f.p,two=Object.create(Object.getPrototypeOf(one)),a=deferred(),b=deferred();
 Object.assign(two,{destroyVideoReaderManager:()=>{},videoReaders:[{getError:async()=>null}],prepareVideoFrame:()=>b.promise,wasmIns:{_flush:()=>f.currentOwner()?.testOwner,delete(){}}});
 one.testOwner='one';two.testOwner='two';one.prepareVideoFrame=()=>a.promise;one.wasmIns._flush=()=>f.currentOwner()?.testOwner;
 const first=one[method](()=>{}),second=two[method](()=>{});a.resolve();await tick();b.resolve();
 assert.deepEqual(await Promise.all([first,second]),['one','two'],'a queued player must not inherit another preparing player or a cleared global');assert.equal(f.currentOwner(),null);
 one.destroy();two.destroy();
});

for (const method of ['flush','flushInternal']) {
 test(method+' keeps an awaiting Wasm owner while another player starts preparing',async()=>{
  const f=fixture(),one=f.p,held=deferred(),preparing=deferred();one.testOwner='one';
  const two=Object.assign(Object.create(Object.getPrototypeOf(one)),{testOwner:'two',videoReaders:[],prepareVideoFrame:()=>preparing.promise,destroyVideoReaderManager(){},wasmIns:{_flush:()=>true,delete(){}}});
  one.wasmIns._flush=async()=>{await held.promise;return true};
  const first=one[method](()=>{});await tick();
  const second=two[method](()=>{});await tick();const owner=f.currentOwner()?.testOwner;
  held.resolve();preparing.resolve();await Promise.all([first,second]);one.destroy();two.destroy();
  assert.equal(owner,'one','preparation outside the Wasm queue must not overwrite its active owner');
 });
 test(method+' keeps an awaiting Wasm owner when another player preparation rejects',async()=>{
  const f=fixture(),one=f.p,held=deferred(),preparing=deferred();one.testOwner='one';
  const two=Object.assign(Object.create(Object.getPrototypeOf(one)),{testOwner:'two',videoReaders:[],prepareVideoFrame:()=>preparing.promise,destroyVideoReaderManager(){},wasmIns:{_flush:()=>true,delete(){}}});
  const second=two[method](()=>{}).then(()=>null,error=>error.message);
  one.wasmIns._flush=async()=>{await held.promise;return true};const first=one[method](()=>{});await tick();
  preparing.reject(Error('prepare failed'));assert.equal(await second,'prepare failed');const owner=f.currentOwner()?.testOwner;
  held.resolve();await first;one.destroy();two.destroy();
  assert.equal(owner,'one','cleanup outside the Wasm queue must not clear its active owner');
 });
}

test('hardware preparation passes its player through the real manager and reader factory',async()=>{
 const f=fixture(),owners=[],active={testOwner:'active Wasm'},manager={
  _getVideoIDs:()=>[7],_hasTimeRangeOverlap:()=>false,_getMp4DataByID:()=>new Uint8Array([1]),
  _getWidthByID:()=>1,_getHeightByID:()=>1,_getFrameRateByID:()=>25,_getStaticTimeRangesByID:()=>[],
  _getPlaybackRateByID:()=>1,_getTargetFrameByID:()=>0,
 };
 f.configureModule({currentPlayer:active,_useSoftwareDecoder:false,_videoInfoManager:{_HasVideo:()=>true,_Make:()=>manager},
  VideoReader:{async create(...args){owners.push(args[5]);return{prepare:async()=>{}}}},
 });
 f.p.pagComposition={wasmIns:{}};f.p.videoReaderManager=null;
 await Object.getPrototypeOf(f.p).prepareVideoFrame.call(f.p);
 assert.equal(owners.length,1);assert.equal(owners[0]===f.p,true,'hardware reader ownership must not depend on the active Wasm global');
 assert.equal(f.currentOwner()===active,true,'hardware preparation must leave the active Wasm owner intact');
 f.p.destroy();
});
