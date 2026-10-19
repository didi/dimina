#ifdef NDEBUG
#undef NDEBUG
#endif
#include "quickjs.h"
#include <cassert>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

static std::string Read(const char *path) {
    std::ifstream file(path);
    std::string source((std::istreambuf_iterator<char>(file)), {});
    assert(!source.empty());
    return source;
}
static void Eval(JSContext *ctx, const std::string &source) {
    JSValue result = JS_Eval(ctx, source.data(), source.size(), "actual-pag-scheduler", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        std::fprintf(stderr, "%s\n", message ? message : "QuickJS evaluation failed");
        assert(false);
    }
    JS_FreeValue(ctx, result);
}
int main(int argc, char **argv) {
    assert(argc == 5);
    const std::string mode = argv[3];
    assert(mode == "flush" || mode == "internal");
    const std::string lookahead = argv[4];
    assert(lookahead == "single" || lookahead == "default");
    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(rt);
    // Fixture only: prove refcount release without relying on a later cycle GC.
    // Device tests use the unmodified runtime GC policy.
    JS_SetGCThreshold(rt, static_cast<size_t>(-1));
    const auto canvas = Read(argv[1]);
    const auto resource = canvas.find("class CanvasResource {");
    const auto resourceEnd = canvas.find("\nclass CanvasImage", resource);
    assert(resource != std::string::npos && resourceEnd > resource);
    Eval(ctx, "let canvasResourceSerial=1;" + canvas.substr(resource, resourceEnd - resource));
    const auto prepare = canvas.find("\tprepareBufferAsync() {");
    const auto prepareEnd = canvas.find("\n\tcreateResource(", prepare);
    assert(prepare != std::string::npos && prepareEnd > prepare);
    Eval(ctx, "class ActualAllocationOwner { constructor(canvas) {this.canvas=canvas;this.resources=new Map;this.pendingBufferCreations=new Set;this.contextId='context';} " + canvas.substr(prepare, prepareEnd - prepare) + "}");
    const auto player = Read(argv[2]);
    std::string canonicalHelper;
    size_t helperOffset = 0, helperCount = 0;
    while ((helperOffset = player.find("var __async", helperOffset)) != std::string::npos) {
        const auto body = player.find(" =", helperOffset);
        const auto end = player.find("\n};", body);
        assert(body != std::string::npos && end != std::string::npos);
        const auto implementation = player.substr(body, end + 3 - body);
        if (canonicalHelper.empty()) canonicalHelper = implementation;
        assert(implementation == canonicalHelper && "all generated async helpers must share the tested behavior");
        helperOffset = end + 3;
        helperCount++;
    }
    assert(helperCount == 11);

    const auto pipeline = player.find("class AsyncFrameBuffers {");
    const auto pipelineEnd = player.find("const asyncFrameBuffers =", pipeline);
    assert(pipeline != std::string::npos && pipelineEnd > pipeline);
    Eval(ctx, player.substr(pipeline, pipelineEnd - pipeline));
    auto helper=player.find("var __async$1 ="),helperEnd=player.find("\nlet PAGPlayer =",helper);
    auto queue=player.find("var __async ="),queueEnd=player.find("\nvar PAGInit$1 =",queue);
    auto methods=player.find("  flush() {",helperEnd),methodsEnd=player.find("  duration() {",methods);
    assert(helper!=std::string::npos&&queue!=std::string::npos&&methodsEnd>methods);
    std::string schedulers=player.substr(helper,helperEnd-helper)+player.substr(queue,queueEnd-queue);
    const std::string call="step((generator = generator.apply(__this, __arguments)).next())";
    const std::string observe="globalThis.schedulerRefs.push(new WeakRef(fulfilled),new WeakRef(rejected),new WeakRef(step));";
    size_t position=0;while((position=schedulers.find(call,position))!=std::string::npos){schedulers.insert(position,observe);position+=observe.size()+call.size();}
    Eval(ctx,"globalThis.schedulerRefs=[];");Eval(ctx,schedulers);
    Eval(ctx,"let PAGModule={currentPlayer:null,webAssemblyQueue:new WebAssemblyQueue};const asyncFrameBuffers=new AsyncFrameBuffers;class ActualPlayer {"+player.substr(methods,methodsEnd-methods)+"}");
    Eval(ctx, "const mode='success';const invokeMode='" + mode + "';");
    Eval(ctx, "const singleLookahead=" + std::string(lookahead == "single" ? "true" : "false") + ";");
    Eval(ctx, R"JS(
function assert(ok, message) { if (!ok) throw Error(message); }
let serial=0, callbackSerial=0;
const timers=new Map(), events=new Map(), operations=[], promiseRefs=[], resourceRefs=[];
globalThis.setTimeout=callback=>{const id=++serial;timers.set(id,callback);return id};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.makeResourceId=prefix=>prefix+'_'+serial++;
globalThis.serializeCanvasArgs=args=>args;
globalThis.sendCanvasMessage=()=>{};
const canvas={disposed:false,
    enqueueOperation(operation){operations.push(operation)},
    addEventListener(type,callback){if(!events.has(type))events.set(type,new Set());events.get(type).add(callback)},
    removeEventListener(type,callback){events.get(type)?.delete(callback)},
    removeCallback(){},
    flushOperations(callback){
        const batch=operations.splice(0);
        Promise.resolve().then(()=>callback({contexts:{context:{resources:mode==='missing'?[]:batch.map(op=>({resourceId:op.resultId,metadata:{created:mode==='success'}}))}}}));
        return ++callbackSerial;
    }
};
const gl=new ActualAllocationOwner(canvas), originalSet=gl.resources.set;
gl.resources.set=function(id,value){resourceRefs.push(new WeakRef(value));return originalSet.call(this,id,value)};
gl.createBuffer=function(){const value=new CanvasResource(canvas,'ordinary_'+serial++,'buffer');this.resources.set(value.__canvasResourceId,value);return value};
gl.deleteBuffer=buffer=>{buffer.markDeleted();gl.resources.delete(buffer.__canvasResourceId)};
gl[Symbol.for('dimina.canvas.createBufferAsync')]=function(){const promise=this.prepareBufferAsync();promiseRefs.push(new WeakRef(promise));return promise};
const buffers=asyncFrameBuffers, player=new ActualPlayer();
assert(buffers.prefetchAhead===2,'default buffer lookahead changed');
if(singleLookahead) buffers.prefetchAhead=1;
const allocationRounds=2048, expectedLookahead=singleLookahead?1:2;
player.videoReaders=[{getError(){return null}}];player.prepareVideoFrame=()=>Promise.resolve();
player.wasmIns={_flush(){const buffer=buffers.create(gl);if(buffer)gl.deleteBuffer(buffer);return true}};
globalThis.done=false;
async function perform() {
    for(let i=0;i<allocationRounds;i++) {
        const result=await (invokeMode==='flush'?player.flush():player.flushInternal(()=>{}));
        assert(result===true,'actual queued flush result changed');
    }
    const state=buffers.players.get(player);
    assert(state.runs.size===0&&[state.next,state.afterNext].filter(Boolean).length===expectedLookahead,
        'idle buffer lookahead bound changed');
    buffers.cancel(player);await Promise.resolve();await Promise.resolve();globalThis.done=true;
}
async function semantics(){
 const marker={message:'same rejection identity'};
 assert(await __async(null,null,function*(){return (yield 3)+(yield Promise.resolve(4))})===7,'yield order');
 assert(await __async(null,null,function*(){try{yield Promise.reject(marker)}catch(error){assert(error===marker,'caught identity');return 9}})===9,'caught rejection recovery');
 let finalized=0;
 assert(await __async(null,null,function*(){try{return {then(resolve,reject){resolve(11);reject(marker)}}}finally{finalized++}})===11&&finalized===1,'return thenable and finally');
 for(const delayed of [false,true]){
  try{await __async(null,null,function*(){if(delayed)yield Promise.resolve();throw marker});assert(false,'missing rejection')}
  catch(error){assert(error===marker,'uncaught rejection identity')}
 }
 assert(await __async(null,null,function*(){const thenable={then(resolve,reject){resolve(13);reject(marker);throw marker}};return yield thenable})===13,'thenable resolves once');
 globalThis.semanticsDone=true;
}
perform();semantics();
)JS");
    JSContext *jobContext;
    int result;
    while ((result = JS_ExecutePendingJob(rt, &jobContext)) > 0) {}
    assert(result == 0);
    Eval(ctx, R"JS(
assert(done&&semanticsDone,'allocation tasks or async semantics did not complete');assert(PAGModule.webAssemblyQueue.queue.length===0&&!PAGModule.webAssemblyQueue.executing,'actual queue not idle');
// The first flush creates its buffer synchronously. Subsequent flushes consume
// one async allocation each; the idle lookahead is also allocated and cancelled.
const expectedAllocations=allocationRounds-1+expectedLookahead;
assert(promiseRefs.length===expectedAllocations,
    'actual async allocations changed: expected '+expectedAllocations+', received '+promiseRefs.length);
assert(gl.pendingBufferCreations.size===0&&timers.size===0,'settled task retained a pending request or timer');
assert([...events.values()].every(listeners=>listeners.size===0),'settled task retained listeners');
assert(promiseRefs.every(reference=>reference.deref()===undefined),'completed allocations kept their Promise until GC');
// Release intentional owner roots and verify executor scopes do not pin proxies.
gl.resources.clear();
globalThis.liveSchedulers=schedulerRefs.filter(reference=>reference.deref()!==undefined).length;
globalThis.liveResources=resourceRefs.filter(reference=>reference.deref()!==undefined).length;
)JS");
    JSValue metric=JS_Eval(ctx,"liveResources",13,"metrics",JS_EVAL_TYPE_GLOBAL);int32_t live=0;JS_ToInt32(ctx,&live,metric);JS_FreeValue(ctx,metric);std::printf("live released buffer proxies before GC: %d\n",live);
    metric=JS_Eval(ctx,"liveSchedulers",14,"metrics",JS_EVAL_TYPE_GLOBAL);JS_ToInt32(ctx,&live,metric);JS_FreeValue(ctx,metric);std::printf("live scheduler callbacks before GC: %d\n",live);
    Eval(ctx,"assert(liveSchedulers===0,'completed async schedulers retained their callback cycle until GC')");
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    std::puts("PASS actual PAG schedulers release callbacks before cycle GC");
}
