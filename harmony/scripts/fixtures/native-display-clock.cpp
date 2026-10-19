#include "native_display_clock.h"
#include <cassert>
#include <iostream>
#include <thread>
struct OH_NativeVSync {OH_NativeVSync_FrameCallback callback=nullptr;void *data=nullptr;};
OH_NativeVSync *live=nullptr;int requested=0,destroyed=0;bool failure=false;
extern "C" OH_NativeVSync* OH_NativeVSync_Create(const char*,unsigned int){assert(!live);return live=new OH_NativeVSync;}
extern "C" void OH_NativeVSync_Destroy(OH_NativeVSync *p){assert(p==live);++destroyed;delete p;live=nullptr;}
extern "C" int OH_NativeVSync_RequestFrame(OH_NativeVSync *p,OH_NativeVSync_FrameCallback fn,void *data){assert(p==live);++requested;p->callback=fn;p->data=data;return failure?1:0;}
void tick(long long ts){assert(live&&live->callback);auto fn=live->callback;auto data=live->data;live->callback=nullptr;std::thread([=]{fn(ts,data);}).join();}
int main(){
 using namespace dimina::canvas;using P=dimina::bridge::NativeMessageSink::Packet;
 auto page=std::make_shared<UiChannel>("one",[](auto){return true;},[]{});page->ActivateBinary([]{return true;});std::vector<P> queue;
 page->BindFrameEvents([&](P packet){queue.push_back(std::move(packet));return true;},8);
 auto clock=NativeDisplayClock::CreateUI("display",page);assert(clock&&requested==0&&clock->Control(0,"",0,"",0));
 assert(!clock->Control(1,"node",0,"tick",0));assert(!clock->Control(1,"node",1,"bad callback",0));
 assert(clock->Control(1,"node",71,"tick",0));assert(!clock->Control(1,"node",71,"duplicate",0));
 for(int i=1;i<=4;i++)tick(1000000000LL+i*16666667LL);
 assert(queue.size()==4&&live->callback==nullptr);
 assert(!clock->Control(2,"foreign-node",71,"",2));assert(!clock->Control(2,"node",71,"",5));
 assert(clock->Control(2,"node",71,"",2));tick(1200000000LL);tick(1216666667LL);assert(queue.size()==6&&live->callback==nullptr);
 assert(!clock->Control(2,"node",71,"",2));
 for(auto &p:queue){assert(p.alive());const auto &body=p.message.object[2].second;assert(body.object[0].second.number==8);const auto &args=body.object[2].second;assert(args.object[3].second.string==u"monotonic");}
 assert(clock->Control(3,"node",71,"",0));assert(!queue[0].alive());
 assert(clock->Control(1,"node",71,"new-tick",0));assert(!queue[0].alive()); // Reusing a key must not resurrect old queued data.
 queue.clear();tick(1300000000LL);assert(queue.size()==1&&queue[0].alive());
 assert(clock->Control(3,"node",71,"",0));const int before=requested;tick(1316666667LL);assert(requested==before&&live->callback==nullptr);
 const auto oldCallback=[](OH_NativeVSync_FrameCallback c){return c;};(void)oldCallback;
 assert(clock->Control(1,"node",72,"tick",0));auto stale=live->callback;auto data=live->data;
 const int beforeStop=requested;const auto beforeStopQueue=queue.size();clock->Stop();stale(1390000000LL,data);assert(requested==beforeStop&&queue.size()==beforeStopQueue);clock->DisposeUI();clock.reset();assert(destroyed==1);stale(1400000000LL,data);
 auto next=NativeDisplayClock::CreateUI("next",page);assert(next);stale(1416666667LL,data);assert(live->callback==nullptr);
 failure=true;assert(!next->Control(1,"node",73,"tick",0));assert(!next->Control(0,"",0,"",0));next->DisposeUI();next.reset();assert(destroyed==2);
 failure=false;queue.clear();auto multi=NativeDisplayClock::CreateUI("multi",page);
 assert(multi->Control(1,"a",81,"tick-a",0));assert(multi->Control(1,"b",82,"tick-b",0));
 for(int i=1;i<=4;i++)tick(2000000000LL+i*16666667LL);assert(queue.size()==8&&live->callback==nullptr);
 assert(multi->Control(2,"b",82,"",2));tick(2200000000LL);assert(queue.size()==9);tick(2216666667LL);assert(queue.size()==10&&live->callback==nullptr);
 multi->DisposeUI();multi.reset();assert(destroyed==3);
 std::cout<<"PASS hardware-only delivery, four credits, ACK validation, same-key generations, no idle wakes, cancel, stale lifetime and failures\n";
}
