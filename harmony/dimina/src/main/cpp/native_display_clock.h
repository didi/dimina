#pragma once
#include "canvas_ui_channel.h"
#include <native_vsync/native_vsync.h>
#include <atomic>
#include <algorithm>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <vector>
namespace dimina::canvas {
// Explicit hardware-display clock. It never impersonates browser RAF or
// generates timestamps; every pulse comes from one real OH_NativeVSync callback.
class NativeDisplayClock:public std::enable_shared_from_this<NativeDisplayClock>{
    using Key=std::pair<std::string,uint64_t>;
    struct Stream{std::string callback;uint64_t sequence=0,ack=0;double stamp=-1;};
    struct Pulse{Key key;std::string callback;uint64_t sequence;double stamp;std::weak_ptr<Stream> state;};
    inline static std::mutex routesMutex;
    inline static std::map<uintptr_t,std::weak_ptr<NativeDisplayClock>> routes;
    inline static std::atomic<uintptr_t> serial{0};
    std::mutex mutex;
    OH_NativeVSync *handle;
    const uintptr_t route;
    std::weak_ptr<UiChannel> channel;
    bool closed=false,pending=false;
    std::map<Key,std::shared_ptr<Stream>> streams;
    NativeDisplayClock(uintptr_t route,OH_NativeVSync *handle,std::weak_ptr<UiChannel> channel):handle(handle),route(route),channel(channel){}
    bool Schedule(){
        if(closed||!handle)return false;
        if(pending)return true;
        bool credit=false;for(const auto &entry:streams)if(entry.second->sequence-entry.second->ack<4){credit=true;break;}
        if(!credit)return true;
        pending=true;
        if(OH_NativeVSync_RequestFrame(handle,Frame,reinterpret_cast<void*>(route))!=0){pending=false;closed=true;streams.clear();return false;}
        return true;
    }
    bool Owns(const Key &key,const std::weak_ptr<Stream> &state){std::lock_guard<std::mutex> lock(mutex);auto found=streams.find(key);auto current=state.lock();return !closed&&current&&found!=streams.end()&&found->second==current;}
    static void Frame(long long timestamp,void *data)noexcept{
        std::shared_ptr<NativeDisplayClock> self;
        try{
            {std::lock_guard<std::mutex> lock(routesMutex);auto it=routes.find(reinterpret_cast<uintptr_t>(data));if(it!=routes.end())self=it->second.lock();}
            if(!self)return;
            std::vector<Pulse> pulses;
            {
                std::lock_guard<std::mutex> lock(self->mutex);
                if(self->closed||!self->handle)return;
                self->pending=false;
                const double stamp=timestamp/1000000.0;
                if(timestamp>0)for(auto &entry:self->streams){auto &s=*entry.second;
                    if(s.sequence-s.ack>=4||stamp<=s.stamp||s.sequence>=9007199254740991ULL)continue;
                    s.stamp=stamp;pulses.push_back({entry.first,s.callback,++s.sequence,stamp,entry.second});
                }
                self->Schedule();
            }
            auto owner=self->channel.lock();if(!owner)return;
            std::weak_ptr<NativeDisplayClock> weak=self;std::weak_ptr<UiChannel> page=owner;
            for(auto &pulse:pulses){
                const auto key=pulse.key;
                const bool accepted=owner->DeliverFrameEvent(std::move(pulse.callback),key.second,pulse.sequence,pulse.stamp,
                    [weak,page,key,state=pulse.state]{auto clock=weak.lock();auto owner=page.lock();return clock&&owner&&clock->Owns(key,state)&&owner->IsOpen();});
                if(!accepted){owner->Close("native display frame receiver unavailable");break;}
            }
        }catch(...){if(self)if(auto owner=self->channel.lock())owner->Close("native display callback failed");}
    }
public:
    static std::shared_ptr<NativeDisplayClock> CreateUI(const std::string &name,std::weak_ptr<UiChannel> owner){
        auto handle=OH_NativeVSync_Create(name.c_str(),static_cast<unsigned int>(name.size()));if(!handle)return nullptr;
        uintptr_t previous=serial.load(std::memory_order_relaxed);
        do{if(previous==std::numeric_limits<uintptr_t>::max()){OH_NativeVSync_Destroy(handle);return nullptr;}}
        while(!serial.compare_exchange_weak(previous,previous+1,std::memory_order_relaxed));
        NativeDisplayClock *raw;try{raw=new NativeDisplayClock(previous+1,handle,std::move(owner));}catch(...){OH_NativeVSync_Destroy(handle);throw;}
        auto self=std::shared_ptr<NativeDisplayClock>(raw);
        {std::lock_guard<std::mutex> lock(routesMutex);routes[previous+1]=self;}
        return self;
    }
    bool Control(int op,const std::string &node,uint64_t request,const std::string &callback,uint64_t sequence){
        std::lock_guard<std::mutex> lock(mutex);if(closed||!handle)return false;
        if(op==0)return true;
        if(node.empty()||node.size()>256||node.find('\0')!=std::string::npos||!request||request>9007199254740991ULL)return false;
        const Key key{node,request};auto found=streams.find(key);
        if(op==1){
            if(found!=streams.end()||streams.size()>=32||callback.empty()||callback.size()>128||callback.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")!=std::string::npos)return false;
            streams.emplace(key,std::make_shared<Stream>(Stream{callback}));return Schedule();
        }
        if(op==3){if(found!=streams.end())streams.erase(found);return true;}
        if(op==2){if(found==streams.end()||sequence<=found->second->ack||sequence>found->second->sequence)return false;found->second->ack=sequence;return Schedule();}
        return false;
    }
    void Stop(){std::lock_guard<std::mutex> lock(mutex);closed=true;streams.clear();}
    void DisposeUI(){
        OH_NativeVSync *retired;
        {std::lock_guard<std::mutex> lock(mutex);closed=true;streams.clear();retired=handle;handle=nullptr;}
        {std::lock_guard<std::mutex> lock(routesMutex);routes.erase(route);}
        if(retired)OH_NativeVSync_Destroy(retired);
    }
    ~NativeDisplayClock(){DisposeUI();}
};
}
