#include "canvas_ui_channel.h"
#include <cassert>
#include <future>
#include <iostream>
#include <thread>
using namespace dimina::canvas;
struct Queue {
 std::mutex mutex;std::condition_variable cv;std::vector<std::unique_ptr<UiCommand>> values;
 bool Push(std::unique_ptr<UiCommand> c){std::lock_guard<std::mutex> l(mutex);values.push_back(std::move(c));cv.notify_all();return true;}
 void Wait(size_t n){std::unique_lock<std::mutex> l(mutex);assert(cv.wait_for(l,std::chrono::seconds(2),[&]{return values.size()>=n;}));}
};
int main(){
 Queue q;auto c=std::make_shared<UiChannel>("page",[&](auto v){return q.Push(std::move(v));},[]{});
 assert(c->ActivateBinary([]{return true;}));assert(c->IsBinary());
 std::vector<std::vector<uint8_t>> bytes{{0,255,1,128},{}};
 assert(c->Publish("{\"value\":{\"__canvasBinaryIndex\":0},\"empty\":{\"__canvasBinaryIndex\":1}}",bytes));bytes[0][0]=99;
 auto pending=std::async(std::launch::async,[&]{return c->Query("{}",NowMs()+2000);});q.Wait(2);
 const auto &p=q.values[0]->packet;uint32_t size=0;for(int i=0;i<4;i++)size|=uint32_t(p[i])<<(i*8);
 std::string header(p.begin()+4,p.begin()+4+size);assert(header.find("\"type\":\"publish\"")!=std::string::npos);
 assert(header.find("\"requestId\":\"page:1\"")!=std::string::npos);assert(p[4+size]==0&&p.back()==128);
 assert(q.values[1]->requestId=="page:2"&&!q.values[1]->packet.empty());c->Complete("page:2",{"{\"created\":false}",""});assert(pending.get().json=="{\"created\":false}");
 bool drained=false;assert(!c->UseLegacy([&]{drained=true;return true;}));assert(!drained);
 assert(c->Query("{}",NowMs()+1000,std::vector<std::vector<uint8_t>>(4097)).error.find("budget")!=std::string::npos);
 c->Close("done");
 for(int i=0;i<200;i++){
  Queue queue;auto channel=std::make_shared<UiChannel>("p",[&](auto v){return queue.Push(std::move(v));},[]{});
  bool ready=false,fallback=false;
  std::thread first([&]{channel->ActivateBinary([&]{ready=true;return true;});});
  std::thread second([&]{channel->UseLegacy([&]{fallback=true;return true;});});first.join();second.join();assert(ready!=fallback);
  if(fallback)assert(!channel->ActivateBinary([]{assert(false);return true;}));
  assert(channel->IsBinary()==ready);channel->Close("done");
 }
 Queue failed;auto attempt=std::make_shared<UiChannel>("failed",[&](auto v){return failed.Push(std::move(v));},[]{});
 assert(!attempt->ActivateBinary([]{return false;}));
 assert(!attempt->UseLegacy([]{assert(false);return true;}));
 assert(!attempt->ActivateBinary([]{assert(false);return true;}));attempt->Close("partial native post failed");
 Queue legacy;auto fallbackChannel=std::make_shared<UiChannel>("legacy",[&](auto v){return legacy.Push(std::move(v));},[]{});
 assert(fallbackChannel->UseLegacy([]{return true;}));
 auto actual=std::async(std::launch::async,[&]{return fallbackChannel->Query("{}",NowMs()+2000);});legacy.Wait(1);
 const auto id=legacy.values[0]->requestId;
 fallbackChannel->Complete(id,{"stale native reply",""},true);
 assert(actual.wait_for(std::chrono::milliseconds(0))!=std::future_status::ready);
 fallbackChannel->Close("stale native error",true);
 assert(fallbackChannel->IsOpen() && "retired native feedback must not close the active legacy route");
 fallbackChannel->Complete(id,{"real legacy reply",""});assert(actual.get().json=="real legacy reply");fallbackChannel->Close("done");
 std::cout<<"PASS owned binary publish/query, budgets, no fallback after activation, 200 readiness races\n";
}
