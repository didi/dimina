#include "native/bridge/native_message_sink.hpp"
#include <atomic>
#include <chrono>
#include <cassert>
#include <condition_variable>
#include <thread>
#include <iostream>
using Sink=dimina::bridge::NativeMessageSink;
int main(){
 Sink::Receiver late;
 {Sink sink;int calls=0;sink.Bind([&](Sink::Packet packet){assert(packet.message.number==352);++calls;return true;});late=sink.Get();dimina::bridge::Value v;v.kind=dimina::bridge::Value::Number;v.number=352;assert(late({v,{}}));sink.Close();assert(!late({v,{}}));assert(calls==1);}
 assert(!late({{}, {}}));Sink sink;std::mutex m;std::condition_variable cv;bool entered=false,release=false;std::atomic<bool> closed=false;
 sink.Bind([&](Sink::Packet){std::unique_lock<std::mutex> lock(m);entered=true;cv.notify_all();cv.wait(lock,[&]{return release;});assert(!closed);return true;});auto receive=sink.Get();
 std::thread post([&]{assert(receive({{}, {}}));});{std::unique_lock<std::mutex> lock(m);cv.wait(lock,[&]{return entered;});}
 std::atomic<bool> closeStarted=false;
 std::thread closer([&]{closeStarted=true;cv.notify_all();sink.Close();closed=true;cv.notify_all();});
 bool premature;
 {std::unique_lock<std::mutex> lock(m);cv.wait(lock,[&]{return closeStarted.load();});
  premature=cv.wait_for(lock,std::chrono::milliseconds(250),[&]{return closed.load();});
  release=true;cv.notify_all();}
 post.join();closer.join();assert(!premature && "Close must wait for the in-flight receiver");assert(!receive({{}, {}}));
 std::cout<<"PASS scalar ownership, stale lifetime, close and in-flight synchronization\n";
}
