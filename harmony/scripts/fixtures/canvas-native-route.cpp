#include "canvas_ui_route.h"
#include <web/arkweb_interface.h>
#include <native_vsync/native_vsync.h>
// The portable ArkWeb router fixture has no hardware display.
extern "C" OH_NativeVSync* OH_NativeVSync_Create(const char*,unsigned int){return nullptr;}
extern "C" void OH_NativeVSync_Destroy(OH_NativeVSync*){}
extern "C" int OH_NativeVSync_RequestFrame(OH_NativeVSync*,OH_NativeVSync_FrameCallback,void*){return -1;}
#include <cassert>
#include <cstring>
#include <thread>
#include <vector>
using namespace dimina::canvas;
struct FakePort { ArkWeb_OnMessageEventHandler callback=nullptr;void *opaque=nullptr;std::string tag; };
struct FakeMessage { ArkWeb_WebMessageType type=ARKWEB_STRING;std::vector<uint8_t> bytes; };
namespace {
std::thread::id uiThread;
std::mutex fakeMutex;
std::vector<FakeMessage> posted;
FakePort *receiver=nullptr;
ArkWeb_OnMessageEventHandler lateCallback=nullptr;
void *lateOpaque=nullptr;
FakePort *latePort=nullptr;
std::string lateTag;
FakePort reused[2];
ArkWeb_OnMessageEventHandler savedCallback=nullptr;void *savedOpaque=nullptr;FakePort *savedPort=nullptr;std::string savedTag;
int available=1; bool failTransfer=false,failPost=false;
int closes=0,destroyed=0;
void UI(){assert(std::this_thread::get_id()==uiThread);}
ArkWeb_WebMessagePortPtr *Create(const char *tag,size_t *count){UI();*count=2;auto p=available==3?new FakePort *[2]{&reused[0],&reused[1]}:new FakePort *[2]{new FakePort,new FakePort};p[0]->tag=tag;p[1]->tag=tag;receiver=p[0];return p;}
void Destroy(ArkWeb_WebMessagePortPtr **ports,size_t count){UI();for(size_t i=0;i<count;i++)if((*ports)[i]!=&reused[0]&&(*ports)[i]!=&reused[1])delete (*ports)[i];delete[] *ports;*ports=nullptr;++destroyed;}
ArkWeb_ErrorCode Transfer(const char *,const char *,ArkWeb_WebMessagePortPtr *,size_t,const char *){UI();return failTransfer?ARKWEB_INVALID_PARAM:ARKWEB_SUCCESS;}
ArkWeb_ErrorCode Post(const ArkWeb_WebMessagePortPtr,const char *,const ArkWeb_WebMessagePtr message){std::lock_guard<std::mutex> l(fakeMutex);if(failPost)return ARKWEB_INVALID_PARAM;posted.push_back(*message);return ARKWEB_SUCCESS;}
void Close(const ArkWeb_WebMessagePortPtr,const char *){UI();++closes;}
void Handler(const ArkWeb_WebMessagePortPtr port,const char *,ArkWeb_OnMessageEventHandler callback,void *data){UI();port->callback=callback;port->opaque=data;latePort=port;lateCallback=callback;lateOpaque=data;lateTag=port->tag;}
ArkWeb_WebMessagePtr NewMessage(){return new FakeMessage;}
void FreeMessage(ArkWeb_WebMessagePtr *message){delete *message;*message=nullptr;}
void SetType(ArkWeb_WebMessagePtr message,ArkWeb_WebMessageType type){message->type=type;}
ArkWeb_WebMessageType GetType(ArkWeb_WebMessagePtr message){return message->type;}
void SetData(ArkWeb_WebMessagePtr message,void *data,size_t size){message->bytes.assign(static_cast<uint8_t *>(data),static_cast<uint8_t *>(data)+size);}
void *GetData(ArkWeb_WebMessagePtr message,size_t *size){*size=message->bytes.size();return message->bytes.data();}
ArkWeb_ControllerAPI controller{sizeof(ArkWeb_ControllerAPI),Create,Destroy,Transfer};
ArkWeb_WebMessagePortAPI portAPI{sizeof(ArkWeb_WebMessagePortAPI),Post,Close,Handler};
ArkWeb_WebMessageAPI messageAPI{sizeof(ArkWeb_WebMessageAPI),NewMessage,FreeMessage,SetType,GetType,SetData,GetData};
std::string Text(napi_env env,napi_value value){size_t size=0;napi_get_value_string_utf8(env,value,nullptr,0,&size);std::string text(size+1,'\0');napi_get_value_string_utf8(env,value,text.data(),text.size(),&size);text.resize(size);return text;}
int Number(napi_env env,napi_value value){int32_t n=0;napi_get_value_int32(env,value,&n);return n;}
napi_value Undefined(napi_env env){napi_value value;napi_get_undefined(env,&value);return value;}
struct Query {std::shared_ptr<UiChannel> channel;std::string body;int64_t deadline;UiReply reply;napi_deferred deferred;napi_async_work work;};
napi_value QueryAsync(napi_env env,napi_callback_info info){
 size_t argc=4;napi_value args[4];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
 auto query=new Query{FindUiChannel(Number(env,args[0]),Number(env,args[1])),Text(env,args[2]),NowMs()+(argc>3?Number(env,args[3]):2000),{},nullptr,nullptr};
 napi_value promise,name;napi_create_promise(env,&query->deferred,&promise);napi_create_string_utf8(env,"test-canvas-query",NAPI_AUTO_LENGTH,&name);
 napi_create_async_work(env,nullptr,name,[](napi_env,void *data){auto q=static_cast<Query *>(data);q->reply=q->channel?q->channel->Query(q->body,q->deadline):UiReply{"","channel unavailable"};},
 [](napi_env env,napi_status,void *data){std::unique_ptr<Query> q(static_cast<Query *>(data));napi_value result;
 if(q->reply.error.empty()){napi_create_string_utf8(env,q->reply.json.data(),q->reply.json.size(),&result);napi_resolve_deferred(env,q->deferred,result);}
 else{napi_create_string_utf8(env,q->reply.error.data(),q->reply.error.size(),&result);napi_reject_deferred(env,q->deferred,result);}napi_delete_async_work(env,q->work);},query,&query->work);
 napi_queue_async_work(env,query->work);return promise;
}
napi_value Feedback(napi_env env,napi_callback_info info){
 size_t argc=2;napi_value args[2];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);auto text=Text(env,args[0]);
 const bool old=argc>1&&Number(env,args[1]);
 auto callback=old?savedCallback:lateCallback;auto port=old?savedPort:latePort;auto data=old?savedOpaque:lateOpaque;auto tag=old?savedTag:lateTag;
 std::thread([=]{FakeMessage message;message.bytes.assign(text.begin(),text.end());if(callback)callback(tag.c_str(),port,&message,data);}).join();return Undefined(env);
}
napi_value Remember(napi_env env,napi_callback_info){savedCallback=lateCallback;savedOpaque=lateOpaque;savedPort=latePort;savedTag=lateTag;return Undefined(env);}
napi_value Messages(napi_env env,napi_callback_info){
 napi_value result;napi_create_array(env,&result);std::lock_guard<std::mutex> l(fakeMutex);uint32_t i=0;
 for(auto &message:posted){napi_value value;if(message.type==ARKWEB_STRING)napi_create_string_utf8(env,reinterpret_cast<const char *>(message.bytes.data()),message.bytes.size(),&value);
 else{void *bytes;napi_create_arraybuffer(env,message.bytes.size(),&bytes,&value);std::memcpy(bytes,message.bytes.data(),message.bytes.size());}napi_set_element(env,result,i++,value);}posted.clear();return result;
}
napi_value Options(napi_env env,napi_callback_info info){size_t argc=3;napi_value args[3];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);available=Number(env,args[0]);failTransfer=Number(env,args[1]);failPost=Number(env,args[2]);return Undefined(env);}
napi_value Pending(napi_env env,napi_callback_info info){size_t argc=2;napi_value args[2];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);auto channel=FindUiChannel(Number(env,args[0]),Number(env,args[1]));napi_value value;napi_create_uint32(env,channel?channel->Pending():0,&value);return value;}
napi_value Stats(napi_env env,napi_callback_info){napi_value object,value;napi_create_object(env,&object);napi_create_int32(env,closes,&value);napi_set_named_property(env,object,"closes",value);napi_create_int32(env,destroyed,&value);napi_set_named_property(env,object,"destroyed",value);return object;}
napi_value PublishBody(napi_env env,napi_callback_info info){
 size_t argc=4;napi_value args[4];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);auto channel=FindUiChannel(Number(env,args[0]),Number(env,args[1]));
 void *bytes=nullptr;size_t size=0;napi_get_arraybuffer_info(env,args[3],&bytes,&size);std::vector<std::vector<uint8_t>> buffers(1);if(size)buffers[0].assign(static_cast<uint8_t *>(bytes),static_cast<uint8_t *>(bytes)+size);
 bool sent=channel&&channel->Publish(Text(env,args[2]),std::move(buffers));napi_value result;napi_get_boolean(env,sent,&result);return result;
}
}
extern "C" ArkWeb_AnyNativeAPI *OH_ArkWeb_GetNativeAPI(ArkWeb_NativeAPIVariantKind kind){UI();if(!available)return nullptr;messageAPI.size=available==2?sizeof(size_t):sizeof(messageAPI);return reinterpret_cast<ArkWeb_AnyNativeAPI *>(kind==ARKWEB_NATIVE_CONTROLLER?static_cast<void *>(&controller):kind==ARKWEB_NATIVE_WEB_MESSAGE_PORT?static_cast<void *>(&portAPI):static_cast<void *>(&messageAPI));}
NAPI_MODULE_INIT(){if(uiThread==std::thread::id())uiThread=std::this_thread::get_id();
 napi_property_descriptor fields[]={
 {"register",nullptr,canvasUiRegister,nullptr,nullptr,nullptr,napi_default,nullptr},{"unregister",nullptr,canvasUiUnregister,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"publish",nullptr,canvasUiPublish,nullptr,nullptr,nullptr,napi_default,nullptr},{"complete",nullptr,canvasUiComplete,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"connect",nullptr,canvasUiConnectNative,nullptr,nullptr,nullptr,napi_default,nullptr},{"ready",nullptr,canvasUiNativeReady,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"query",nullptr,QueryAsync,nullptr,nullptr,nullptr,napi_default,nullptr},{"feedback",nullptr,Feedback,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"remember",nullptr,Remember,nullptr,nullptr,nullptr,napi_default,nullptr},{"messages",nullptr,Messages,nullptr,nullptr,nullptr,napi_default,nullptr},{"options",nullptr,Options,nullptr,nullptr,nullptr,napi_default,nullptr},
 {"pending",nullptr,Pending,nullptr,nullptr,nullptr,napi_default,nullptr},{"stats",nullptr,Stats,nullptr,nullptr,nullptr,napi_default,nullptr},{"publishBody",nullptr,PublishBody,nullptr,nullptr,nullptr,napi_default,nullptr}};
 napi_define_properties(env,exports,sizeof(fields)/sizeof(fields[0]),fields);return exports;
}
