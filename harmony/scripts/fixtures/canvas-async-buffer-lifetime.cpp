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
    JSValue result = JS_Eval(ctx, source.data(), source.size(), "actual-buffer-allocation", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue error = JS_GetException(ctx);
        const char *message = JS_ToCString(ctx, error);
        std::fprintf(stderr, "%s\n", message ? message : "QuickJS evaluation failed");
        assert(false);
    }
    JS_FreeValue(ctx, result);
}
int main(int argc, char **argv) {
    assert(argc == 4);
    const std::string mode = argv[3];
    assert(mode == "success" || mode == "null" || mode == "missing");
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
    auto method = canvas.substr(prepare, prepareEnd - prepare);
    const auto hook = method.find("this.canvas.addEventListener('webglcontextlost', lost)");
    assert(hook != std::string::npos);
    // Observe the actual closures without replacing their scheduling or behavior.
    method.insert(hook, "globalThis.handlerRefs.push(new WeakRef(lost), new WeakRef(cleanup), new WeakRef(fail));\n");
    Eval(ctx, "globalThis.handlerRefs=[];");
    Eval(ctx, "class ActualAllocationOwner { constructor(canvas) {this.canvas=canvas;this.resources=new Map;this.pendingBufferCreations=new Set;this.contextId='context';} " + method + "}");
    const auto player = Read(argv[2]);
    const auto pipeline = player.find("class AsyncFrameBuffers {");
    const auto pipelineEnd = player.find("const asyncFrameBuffers =", pipeline);
    assert(pipeline != std::string::npos && pipelineEnd > pipeline);
    Eval(ctx, player.substr(pipeline, pipelineEnd - pipeline));
    Eval(ctx, "const mode='" + mode + "';");
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
gl.deleteBuffer=buffer=>buffer.markDeleted();
gl[Symbol.for('dimina.canvas.createBufferAsync')]=function(){const promise=this.prepareBufferAsync();promiseRefs.push(new WeakRef(promise));return promise};
const buffers=new AsyncFrameBuffers(), player={videoReaders:[1]};
globalThis.done=false;
async function perform() {
    for(let i=0;i<2048;i++) {
        if(mode==='success') {
            const run=buffers.begin(player);await run.prepared;buffers.enter(run);
            let value=buffers.create(gl);buffers.leave(run);buffers.end(run);gl.deleteBuffer(value);value=null;
        } else {
            const promise=gl[Symbol.for('dimina.canvas.createBufferAsync')]();
            try { const value=await promise;assert(mode==='null'&&value===null,'null allocation result changed'); }
            catch(error) {assert(mode==='missing'&&error.message==='canvas buffer feedback missing','allocation rejection changed');}
        }
    }
    buffers.cancel(player);await Promise.resolve();await Promise.resolve();globalThis.done=true;
}
perform();
)JS");
    JSContext *jobContext;
    int result;
    while ((result = JS_ExecutePendingJob(rt, &jobContext)) > 0) {}
    assert(result == 0);
    Eval(ctx, R"JS(
assert(done,'allocation tasks did not complete');
assert(promiseRefs.length===2048,'actual async allocations changed');
assert(gl.pendingBufferCreations.size===0&&timers.size===0,'settled task retained a pending request or timer');
assert([...events.values()].every(listeners=>listeners.size===0),'settled task retained listeners');
assert(promiseRefs.every(reference=>reference.deref()===undefined),'completed allocations kept their Promise until GC');
assert(handlerRefs.every(reference=>reference.deref()===undefined),'settled allocation handlers remained until GC');
// Release intentional owner roots and verify executor scopes do not pin proxies.
gl.resources.clear();
assert(resourceRefs.every(reference=>reference.deref()===undefined),'completed allocation scopes kept released resources until GC');
)JS");
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    std::puts("PASS settled buffer tasks release Promise/resource captures before GC");
}
