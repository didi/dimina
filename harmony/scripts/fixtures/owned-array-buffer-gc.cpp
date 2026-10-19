#ifdef NDEBUG
#undef NDEBUG
#endif
#include "quickjs.h"
#include "video_decoder_frame.h"
#include <cstdio>
#include <cstdint>
#include <vector>
#include <cassert>
static int released=0;
static void release(JSRuntime *,void *opaque,void *) { delete static_cast<std::vector<uint8_t> *>(opaque); released++; }
int main() {
 JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);JS_RunGC(rt);
 JSMemoryUsage before,held,after;JS_ComputeMemoryUsage(rt,&before);
 auto pixels=new std::vector<uint8_t>(8*1024*1024,173);
 JS_SetGCThreshold(rt,0);
 std::puts("BEGIN_ADOPTION");std::fflush(stdout);
 JSValue value=JS_NewArrayBufferOwned(ctx,pixels->data(),pixels->size(),pixels->capacity()+sizeof(*pixels),release,pixels);
 std::puts("END_ADOPTION");std::fflush(stdout);
 assert(!JS_IsException(value));size_t size=0;assert(JS_GetArrayBuffer(ctx,&size,value)==pixels->data());assert(size==pixels->size());
 JS_ComputeMemoryUsage(rt,&held);assert(held.malloc_size>=before.malloc_size+8*1024*1024);
 JS_FreeValue(ctx,value);assert(released==1);JS_ComputeMemoryUsage(rt,&after);assert(after.malloc_size<=before.malloc_size+4096);
 for(const size_t threshold : {size_t(4*1024*1024),SIZE_MAX}) {
  JS_SetGCThreshold(rt,threshold);
  std::puts("BEGIN_MANUAL_POLICY");std::fflush(stdout);
  auto transient=new std::vector<uint8_t>(1024*1024,179);
  JSValue adopted=JS_NewArrayBufferOwned(ctx,transient->data(),transient->size(),transient->capacity()+sizeof(*transient),release,transient);
  assert(!JS_IsException(adopted));JS_FreeValue(ctx,adopted);
  const char policySource[]="for(let i=0;i<1000;i++){const cycle={};cycle.self=cycle;}";
  JSValue activity=JS_Eval(ctx,policySource,sizeof(policySource)-1,"manual-gc-budget",JS_EVAL_TYPE_GLOBAL);
  assert(!JS_IsException(activity));JS_FreeValue(ctx,activity);
  std::puts("END_MANUAL_POLICY");std::fflush(stdout);
 }
 // A failed adoption must restore a caller-selected budget and its policy.
 JS_SetMemoryLimit(rt,2*1024*1024);JS_SetGCThreshold(rt,4*1024*1024);
 auto oversized=new std::vector<uint8_t>(8*1024*1024,183);
 JSValue failed=JS_NewArrayBufferOwned(ctx,oversized->data(),oversized->size(),oversized->capacity()+sizeof(*oversized),release,oversized);
 assert(JS_IsException(failed));JS_FreeValue(ctx,JS_GetException(ctx));delete oversized;
 JS_SetMemoryLimit(rt,SIZE_MAX);
 std::puts("BEGIN_MANUAL_POLICY");std::fflush(stdout);
 auto small=new std::vector<uint8_t>(1024*1024,187);
 JSValue adopted=JS_NewArrayBufferOwned(ctx,small->data(),small->size(),small->capacity()+sizeof(*small),release,small);
 assert(!JS_IsException(adopted));JS_FreeValue(ctx,adopted);
 const char policyAfterFailure[]="for(let i=0;i<1000;i++){const cycle={};cycle.self=cycle;}";
 JSValue activity=JS_Eval(ctx,policyAfterFailure,sizeof(policyAfterFailure)-1,"manual-gc-after-failure",JS_EVAL_TYPE_GLOBAL);
 assert(!JS_IsException(activity));JS_FreeValue(ctx,activity);
 std::puts("END_MANUAL_POLICY");std::fflush(stdout);
 JS_FreeContext(ctx);JS_FreeRuntime(rt);
 for(size_t extra=0;extra<=512;extra+=16) {
  rt=JS_NewRuntime();ctx=JS_NewContext(rt);JS_RunGC(rt);JS_ComputeMemoryUsage(rt,&before);
  pixels=new std::vector<uint8_t>(1024*1024,181);const size_t charge=pixels->capacity()+sizeof(*pixels);int prior=released;
  JS_SetMemoryLimit(rt,before.malloc_size+charge+extra);
  value=JS_NewArrayBufferOwned(ctx,pixels->data(),pixels->size(),charge,release,pixels);
  if(JS_IsException(value)) {
   assert(released==prior&&pixels->front()==181);JS_FreeValue(ctx,JS_GetException(ctx));delete pixels;
  } else {
   JS_ComputeMemoryUsage(rt,&held);assert(held.malloc_size>=before.malloc_size+charge);assert(held.malloc_size<=before.malloc_size+charge+extra);
   JS_FreeValue(ctx,value);assert(released==prior+1);
  }
  JS_SetMemoryLimit(rt,SIZE_MAX);JS_RunGC(rt);JS_ComputeMemoryUsage(rt,&after);assert(after.malloc_size<=before.malloc_size+4096);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);
 }
 std::puts("ALL_33_ALLOCATION_BUDGET_BOUNDARIES_PASS");
 // Count the complete production conversion, including both result and buffer.
 rt=JS_NewRuntime();ctx=JS_NewContext(rt);JS_RunGC(rt);JS_SetGCThreshold(rt,0);
 VideoDecoderFrame nativeFrame;nativeFrame.width=1024;nativeFrame.height=2048;
 nativeFrame.pixels.resize(8*1024*1024,173);
 std::puts("BEGIN_FRAME");std::fflush(stdout);
 value=VideoDecoderFrameToJS(ctx,std::move(nativeFrame));assert(!JS_IsException(value));
 std::puts("END_FRAME");std::fflush(stdout);
 JSValue frameData=JS_GetPropertyStr(ctx,value,"data");size_t frameSize=0;
 const uint8_t *frameBytes=JS_GetArrayBuffer(ctx,&frameSize,frameData);
 assert(frameSize==8*1024*1024&&frameBytes[0]==173&&frameBytes[frameSize-1]==173);
 JS_FreeValue(ctx,frameData);JS_FreeValue(ctx,value);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 rt=JS_NewRuntime();ctx=JS_NewContext(rt);JS_SetMemoryLimit(rt,2*1024*1024);JS_SetGCThreshold(rt,256*1024);
 pixels=new std::vector<uint8_t>(8*1024*1024,193);int prior=released;
 value=JS_NewArrayBufferOwned(ctx,pixels->data(),pixels->size(),pixels->capacity()+sizeof(*pixels),release,pixels);
 assert(JS_IsException(value));JS_FreeValue(ctx,JS_GetException(ctx));assert(released==prior);delete pixels;
 const char source[]="for(let i=0;i<40000;i++){const cycle={};cycle.self=cycle;}";
 value=JS_Eval(ctx,source,sizeof(source)-1,"gc-after-failed-adoption",JS_EVAL_TYPE_GLOBAL);
 assert(!JS_IsException(value) && "failed adoption must not suppress later cycle collection below the memory limit");
 JS_FreeValue(ctx,value);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 std::puts("POST_FAILURE_CYCLE_COLLECTION_PASS");
 rt=JS_NewRuntime();ctx=JS_NewContext(rt);
 std::vector<uint8_t> fill(4*1024*1024,197);
 JSValue filler=JS_NewArrayBufferCopy(ctx,fill.data(),fill.size());assert(!JS_IsException(filler));
 std::vector<uint8_t>().swap(fill);JS_RunGC(rt);JS_ComputeMemoryUsage(rt,&before);
 JS_SetMemoryLimit(rt,before.malloc_size+(before.malloc_size>>1)+512*1024);JS_SetGCThreshold(rt,0);
 pixels=new std::vector<uint8_t>(1024*1024,199);prior=released;
 value=JS_NewArrayBufferOwned(ctx,pixels->data(),pixels->size(),pixels->capacity()+sizeof(*pixels),release,pixels);
 assert(!JS_IsException(value));JS_FreeValue(ctx,value);assert(released==prior+1);
 const char successSource[]="for(let i=0;i<120000;i++){const cycle={};cycle.self=cycle;}";
 value=JS_Eval(ctx,successSource,sizeof(successSource)-1,"gc-after-successful-adoption-release",JS_EVAL_TYPE_GLOBAL);
 assert(!JS_IsException(value) && "successful transient adoption must not suppress later cycle collection below the memory limit");
 JS_FreeValue(ctx,value);JS_FreeValue(ctx,filler);JS_FreeContext(ctx);JS_FreeRuntime(rt);
 std::puts("POST_SUCCESS_RELEASE_CYCLE_COLLECTION_PASS");return 0;
}
