#ifdef NDEBUG
#undef NDEBUG
#endif
#include "quickjs.h"
#include <cassert>
#include <fstream>
#include <iterator>
#include <string>
#include <cstdio>
static void Eval(JSContext *ctx,const std::string &source) {
 JSValue value=JS_Eval(ctx,source.data(),source.size(),"actual-retired-buffer-helper",JS_EVAL_TYPE_GLOBAL);
 if(JS_IsException(value)){JSValue e=JS_GetException(ctx);const char *s=JS_ToCString(ctx,e);std::fprintf(stderr,"%s\n",s?s:"error");assert(false);}
 JS_FreeValue(ctx,value);
}
static void Drain(JSRuntime *rt) {JSContext *ctx;int result;while((result=JS_ExecutePendingJob(rt,&ctx))>0){}assert(result==0);}
int main(int argc,char **argv) {
 assert(argc==3);JSRuntime *rt=JS_NewRuntime();JSContext *ctx=JS_NewContext(rt);
 std::ifstream file(argv[1]);std::string source((std::istreambuf_iterator<char>(file)),{});assert(!source.empty());const auto pos=source.find("export class ");assert(pos!=std::string::npos);source.erase(pos,7);Eval(ctx,source);
 std::ifstream canvasFile(argv[2]);std::string canvasSource((std::istreambuf_iterator<char>(canvasFile)),{});const auto begin=canvasSource.find("class CanvasResource {"),end=canvasSource.find("\nclass CanvasImage",begin);assert(begin!=std::string::npos&&end>begin);Eval(ctx,"let canvasResourceSerial=1;"+canvasSource.substr(begin,end-begin));

 Eval(ctx,R"JS(
 function assert(ok,msg){if(!ok)throw Error(msg)}
 const retired=new RetiredBufferReferences(true);assert(retired.enabled,'real QuickJS weak references are required');
 const owner={enqueueOperation(){}};globalThis.held=new CanvasResource(owner,'held','buffer');retired.remember('held',held);
 for(let i=0;i<2048;i++){const value=new CanvasResource(owner,'buffer-'+i,'buffer');value.metadata.self=value;assert(retired.remember('buffer-'+i,value),'register');}
 assert(retired.entries.size>=1&&retired.entries.size<=2049,'record index bounds before explicit GC');
 )JS");
 JS_RunGC(rt);Drain(rt);JS_RunGC(rt);Drain(rt);Eval(ctx,"for(let i=0;i<2049;i++)retired.sweep();assert(retired.entries.size===1,'unheld proxy records must be collected');assert(retired.get('held')===held,'held proxy identity must survive');");
 Eval(ctx,R"JS(
 const swept=new RetiredBufferReferences(true);
 for(let i=0;i<2048;i++){const value=new CanvasResource(owner,'swept-'+i,'buffer');assert(swept.remember('swept-'+i,value),'sweep register');}
 assert(swept.entries.size<=8,'dead names must stay bounded before GC delivery');swept.dispose();
 const disposed=new RetiredBufferReferences(true);
 for(let i=0;i<100;i++){const value={i};value.self=value;disposed.remember('buffer-'+i,value);}
 disposed.dispose();assert(disposed.entries.size===0&&!disposed.enabled,'dispose clears records');
 assert(!disposed.remember('late',{}),'disposed owner cannot register again');
 )JS");
 JS_RunGC(rt);Drain(rt);Eval(ctx,"assert(disposed.entries.size===0,'late cleanup cannot resurrect disposed records');retired.dispose();held=null;");JS_RunGC(rt);Drain(rt);JS_FreeContext(ctx);JS_FreeRuntime(rt);std::puts("Actual QuickJS retired-buffer GC/lifetime/owner-dispose passed");return 0;
}
