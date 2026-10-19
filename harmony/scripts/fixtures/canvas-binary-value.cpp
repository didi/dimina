#include "canvas_binary_value.h"
#include "canvas_rle32.h"
#include "canvas_prepared_pixels.h"
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
using namespace dimina::canvas;
using dimina::bridge::OwnedJSValue;
struct FreeDeleter {void operator()(char *p)const{std::free(p);}};
using OwnedCStr=std::unique_ptr<char,FreeDeleter>;
struct JSEngine {JSContext *ctx;bool closing=false;JSContext *getContext(){return ctx;}int getAppIndex(){return 9;}};
std::map<int,JSEngine *> engineMap;
struct OnMessageData {std::string str;int appIndex=0,type=0,webViewId=0;};
std::vector<std::unique_ptr<OnMessageData>> legacy;
using napi_threadsafe_function=void *;
enum napi_status {napi_ok};enum napi_threadsafe_function_release_mode{napi_tsfn_release};enum napi_threadsafe_function_call_mode{napi_tsfn_blocking,napi_tsfn_nonblocking};
napi_threadsafe_function getTsfn(int){return reinterpret_cast<void *>(1);}
napi_status napi_acquire_threadsafe_function(napi_threadsafe_function){return napi_ok;}
napi_status napi_release_threadsafe_function(napi_threadsafe_function,napi_threadsafe_function_release_mode){return napi_ok;}
napi_status napi_call_threadsafe_function(napi_threadsafe_function,void *data,napi_threadsafe_function_call_mode){legacy.emplace_back(static_cast<OnMessageData *>(data));return napi_ok;}
#define OHLog(...) ((void)0)
#define OHError(...) ((void)0)
JSValue throwNativeError(JSContext *ctx,const char *error){if(!JS_HasException(ctx))JS_ThrowInternalError(ctx,"%s",error);return JS_EXCEPTION;}
std::shared_ptr<UiChannel> current;
namespace dimina::canvas {std::shared_ptr<UiChannel> FindUiChannel(int owner,int page){return owner==9&&page==3?current:nullptr;}}
#include "publish-under-test.h"
JSValue eval(JSContext *ctx,const char *text){JSValue v=JS_Eval(ctx,text,std::strlen(text),"<test>",JS_EVAL_TYPE_GLOBAL);if(JS_IsException(v)){const auto e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);std::cerr<<(s?s:"exception")<<'\n';assert(false);}return v;}
void clear(JSContext *ctx){assert(JS_HasException(ctx));JS_FreeValue(ctx,JS_GetException(ctx));}
int main(int argc,char **argv){
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);JSEngine engine{ctx};engineMap[9]=&engine;
 {
  std::vector<std::unique_ptr<UiCommand>> sent;
  current=std::make_shared<UiChannel>("page",[&](auto command){sent.push_back(std::move(command));return true;},[]{});
  current->ActivateBinary([]{return true;});
  OwnedJSValue global(ctx,JS_GetGlobalObject(ctx));
  JS_SetPropertyStr(ctx,global.value,"encode",JS_NewCFunction(ctx,js_encode_canvas_array_buffer,"encode",1));
  {
   std::vector<uint8_t> pixels(65536,7);
   const auto prepared=PrepareCanvasPixels(pixels.data(),pixels.size());assert(prepared);
   PreparedCanvasRegistry::Add(pixels.data(),prepared);
   OwnedJSValue input(ctx,JS_NewArrayBuffer(ctx,pixels.data(),pixels.size(),[](JSRuntime *,void *,void *){},nullptr,false));
   JSValue args[]={input.value,JS_NewInt32(ctx,3)};
   const auto check=[&](bool unchanged){
    OwnedJSValue result(ctx,js_encode_canvas_array_buffer(ctx,JS_UNDEFINED,2,args));assert(!JS_IsException(result.value));
    OwnedJSValue packed(ctx,JS_GetPropertyStr(ctx,result.value,"packed"));size_t length=0;
    const auto bytes=JS_GetArrayBuffer(ctx,&length,packed.value);assert(bytes);
    const std::vector<uint8_t> actual(bytes,bytes+length);
    assert(MatchesCanvasRle32(pixels.data(),pixels.size(),actual));
    assert((actual==prepared->packed)==unchanged);
   };
   check(true);pixels.back()^=1;check(false);pixels.back()^=1;check(true);
   PreparedCanvasRegistry::Remove(pixels.data());
  }
  OwnedJSValue input(ctx,eval(ctx,R"JS(
   globalThis.pixels=new Uint8Array(131072);for(let i=0;i<pixels.length;i++)pixels[i]=i%251;
   globalThis.message={type:'invokeAPI',target:'render',body:{bridgeId:3,name:'canvasNodeFlush',frame:{__canvasTypedArray:'Uint8Array',...encode(pixels.buffer,3)},empty:{__canvasTypedArray:'Uint8Array',...encode(new ArrayBuffer(0),3)},
    text:'\ud800\x00\u753b\u5e03',when:new Date(0),nan:NaN,items:[undefined,3],undef:undefined,custom:{toJSON(){return {ok:true}}}}};message
  )JS"));
  auto packet=SerializeCanvasBody(ctx,input.value,true);assert(packet.buffers.size()==2&&packet.buffers[0].size()==131072&&packet.buffers[1].empty());
  for(size_t i=0;i<packet.buffers[0].size();i++)assert(packet.buffers[0][i]==i%251);
  JS_SetPropertyStr(ctx,global.value,"encoded",JS_NewStringLen(ctx,packet.json.data(),packet.json.size()));
  OwnedJSValue valid(ctx,eval(ctx,R"JS((()=>{const b=JSON.parse(encoded).body;return b.text==='\ud800\x00\u753b\u5e03'&&b.when==='1970-01-01T00:00:00.000Z'&&b.nan===null&&b.items[0]===null&&b.custom.ok===true&&!('undef'in b)&&b.frame.packed.__canvasBinaryIndex===0&&b.empty.packed.__canvasBinaryIndex===1})())JS"));assert(JS_ToBool(ctx,valid.value));
  bool rejected=false;try{SerializeCanvasBody(ctx,input.value,false);}catch(const std::exception&){rejected=true;clear(ctx);}assert(rejected);
  OwnedJSValue compatibility(ctx,eval(ctx,R"JS((()=>{
   const one=encode(pixels.buffer),otherPage=encode(pixels.buffer,4);
   const data=new Uint8Array(131072).fill(42),compressed=encode(data.buffer,3);
   const old=encode(data.buffer);
   return typeof one.base64==='string'&&!('packed'in one)&&typeof otherPage.base64==='string'&&
    compressed.encoding==='rle32-v1'&&compressed.byteLength===data.length&&compressed.packed.byteLength===8&&
    new DataView(compressed.packed).getUint32(0,true)===(0x80000000+data.length/4)&&
    new DataView(compressed.packed).getUint32(4,true)===0x2a2a2a2a&&old.encoding==='rle32-v1'&&typeof old.base64==='string';
  })())JS"));assert(JS_ToBool(ctx,compatibility.value));
  JSValue args[]={JS_NewInt32(ctx,3),input.value};OwnedJSValue result(ctx,publish(ctx,JS_UNDEFINED,2,args));assert(!JS_IsException(result.value)&&sent.size()==1&&legacy.empty());
  auto wire=sent[0]->packet;assert(wire.size()>=4 && "async publish must carry binary pixel bytes");uint32_t length=0;for(int i=0;i<4;i++)length|=uint32_t(wire[i])<<(8*i);assert(wire.size()==4+length+131072);
  OwnedJSValue mutation(ctx,eval(ctx,"pixels.fill(33)"));
  for(size_t i=0;i<131072;i++)assert(wire[4+length+i]==i%251);
  if(argc>1){std::ofstream file(argv[1],std::ios::binary);file.write(reinterpret_cast<const char *>(wire.data()),wire.size());}
  current->Close("done");current.reset();
  OwnedJSValue stale(ctx,publish(ctx,JS_UNDEFINED,2,args));assert(JS_IsException(stale.value)&&legacy.empty());clear(ctx);
  OwnedJSValue ordinary(ctx,eval(ctx,"({target:'render',body:{when:new Date(0),items:[undefined,NaN]}})"));args[1]=ordinary.value;
  OwnedJSValue fallback(ctx,publish(ctx,JS_UNDEFINED,2,args));assert(!JS_IsException(fallback.value)&&legacy.size()==1);assert(legacy[0]->str=="{\"target\":\"render\",\"body\":{\"when\":\"1970-01-01T00:00:00.000Z\",\"items\":[null,null]}}");
  for(const char *source:{"Array.from({length:4097},()=>({__canvasTypedArray:'Uint8Array',packed:new ArrayBuffer(0)}))","(()=>{const o={};o.self=o;return o})()"}){
   OwnedJSValue value(ctx,eval(ctx,source));bool failed=false;try{SerializeCanvasBody(ctx,value.value,true);}catch(const std::exception&){failed=true;clear(ctx);}assert(failed);
  }
  OwnedJSValue ordinaryBuffers(ctx,eval(ctx,"(()=>{const o={direct:new ArrayBuffer(4),packed:new ArrayBuffer(4)};Object.defineProperty(o,'__canvasTypedArray',{get(){throw Error('must not invoke')},enumerable:false});return o})()"));
  auto original=SerializeCanvasBody(ctx,ordinaryBuffers.value,false);assert(original.buffers.empty()&&original.json=="{\"direct\":{},\"packed\":{}}");
  OwnedJSValue plain(ctx,eval(ctx,"({type:'invokeAPI',body:{name:'x',params:{__proto__:null,value:3}}})"));
  JS_RunGC(rt);JSMemoryUsage before,after;JS_ComputeMemoryUsage(rt,&before);
  for(int i=0;i<500;i++)assert(!SerializeCanvasBody(ctx,plain.value,true).json.empty());
  JS_RunGC(rt);JS_ComputeMemoryUsage(rt,&after);assert(after.obj_count==before.obj_count&&after.memory_used_size<=before.memory_used_size+4096);
 }
 engineMap.clear();JS_FreeContext(ctx);JS_FreeRuntime(rt);std::cout<<"PASS actual QuickJS encoder and publish: owned bytes, JSON semantics, stale/legacy failure, budgets, 500-packet reclamation\n";
}
