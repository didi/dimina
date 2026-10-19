#pragma once
#include <chrono>
#include "../../../../../native/bridge/native_message_sink.hpp"
#include <condition_variable>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace dimina::canvas {
constexpr size_t MAX_UI_SCRIPT_BYTES = 64 * 1024 * 1024;
constexpr size_t MAX_UI_BINARY_BUFFERS = 4096;
constexpr size_t MAX_UI_PENDING_QUERIES = 256;
inline int64_t NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
inline std::string QuoteCanvasString(const std::string &input) {
    std::string result = "\"";
    const char *hex = "0123456789abcdef";
    for (const unsigned char c : input) {
        if (result.size() > MAX_UI_SCRIPT_BYTES - 8) throw std::length_error("canvas string exceeds budget");
        if (c == '\\' || c == '"') { result += '\\'; result += c; }
        else if (c < 32) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
        else result += c;
    }
    return result + '"';
}
struct UiReply { std::string json, error; };
struct UiCommand { std::string requestId, script; std::vector<uint8_t> packet; };
inline std::vector<uint8_t> CanvasPacket(bool publish, const std::string &id, const std::string &body,
                                        int64_t deadline, const std::vector<std::vector<uint8_t>> &buffers) {
    if (body.size() > MAX_UI_SCRIPT_BYTES - 1024 || buffers.size() > MAX_UI_BINARY_BUFFERS)
        throw std::length_error("canvas binary packet exceeds budget");
    size_t payload = 0;
    std::string header = "{\"type\":\"" + std::string(publish ? "publish" : "canvas") +
        "\",\"requestId\":" + QuoteCanvasString(id) + ",\"deadline\":" + std::to_string(deadline) +
        ",\"body\":" + body + ",\"byteLengths\":[";
    for (size_t i = 0; i < buffers.size(); ++i) {
        if (buffers[i].size() > MAX_UI_SCRIPT_BYTES - payload)
            throw std::length_error("canvas binary packet exceeds budget");
        payload += buffers[i].size();
        if (i) header += ',';
        header += std::to_string(buffers[i].size());
    }
    header += "]}";
    if (header.size() > MAX_UI_SCRIPT_BYTES - 4 || payload > MAX_UI_SCRIPT_BYTES - 4 - header.size())
        throw std::length_error("canvas binary packet exceeds budget");
    std::vector<uint8_t> packet(4 + header.size() + payload);
    const uint32_t length = static_cast<uint32_t>(header.size());
    for (int i = 0; i < 4; ++i) packet[i] = static_cast<uint8_t>(length >> (i * 8));
    std::memcpy(packet.data() + 4, header.data(), header.size());
    size_t offset = 4 + header.size();
    for (const auto &buffer : buffers) {
        if (!buffer.empty()) std::memcpy(packet.data() + offset, buffer.data(), buffer.size());
        offset += buffer.size();
    }
    return packet;
}

// Only owned packets cross threads. Submit queues asynchronously and must not
// complete a reply inline. Lock order: channel, submit handle, native port.
class UiChannel {
    struct Request {
        std::mutex mutex;
        std::condition_variable cv;
        bool done = false;
        UiReply reply;
        std::string failure;
        void Complete(UiReply value) {
            std::lock_guard<std::mutex> guard(mutex);
            if (done) return;
            reply = std::move(value); done = true; cv.notify_all();
        }
        void Fail(const char *reason) {
            std::lock_guard<std::mutex> guard(mutex);
            if (done) return;
            failure = reason; done = true; cv.notify_all();
        }
        UiReply Wait(int64_t deadline) {
            std::unique_lock<std::mutex> guard(mutex);
            if (!cv.wait_until(guard, std::chrono::system_clock::time_point(std::chrono::milliseconds(deadline)),
                              [this] { return done; })) {
                failure = "canvas query timed out"; done = true;
            }
            return failure.empty() ? reply : UiReply {"", failure};
        }
    };
public:
    using Submit = std::function<bool(std::unique_ptr<UiCommand>)>;
    UiChannel(std::string token, Submit submit, std::function<void()> retire)
        : token_(std::move(token)), submit_(std::move(submit)), retire_(std::move(retire)) {}
    ~UiChannel() { Close("canvas page was closed"); }
    const std::string &Token() const { return token_; }
    bool IsOpen() const { std::lock_guard<std::mutex> guard(mutex_); return !closed_; }
    bool IsBinary() const { std::lock_guard<std::mutex> guard(mutex_); return binary_ && !closed_; }
    size_t Pending() const { std::lock_guard<std::mutex> guard(mutex_); return pending_.size(); }
    bool ActivateBinary(const std::function<bool()> &drain) {
        std::lock_guard<std::mutex> guard(mutex_);
        if (closed_ || legacyChosen_) return false;
        if (nativeChosen_) return binary_;
        // Once posting begins, even a partial failure must never replay on the
        // legacy route. The caller closes the channel if draining fails.
        nativeChosen_ = true;
        if (!drain()) return false;
        binary_ = true; return true;
    }
    bool UseLegacy(const std::function<bool()> &drain) {
        std::lock_guard<std::mutex> guard(mutex_);
        if (closed_ || nativeChosen_) return false;
        if (legacyChosen_) return true;
        legacyChosen_ = true;
        return drain();
    }
    using DisplayControl=std::function<bool(int,const std::string&,uint64_t,const std::string&,uint64_t)>;
    void BindDisplayControl(DisplayControl control){std::lock_guard<std::mutex> lock(mutex_);displayControl_=std::move(control);}
    bool DisplayFrames(int op,const std::string &node,uint64_t request,const std::string &callback,uint64_t sequence){
        DisplayControl control;{std::lock_guard<std::mutex> lock(mutex_);if(closed_||!binary_||!frameReceiver_)return false;control=displayControl_;}
        return control&&control(op,node,request,callback,sequence);
    }
    void BindFrameEvents(dimina::bridge::NativeMessageSink::Receiver receive, int page) {
        std::lock_guard<std::mutex> guard(mutex_);
        if (!closed_ && !frameReceiver_) { frameReceiver_ = std::move(receive); framePage_ = page; }
    }
    bool DeliverFrameEvent(std::string callback, uint64_t request, uint64_t sequence, double timestamp,
                           std::function<bool()> alive) {
        dimina::bridge::NativeMessageSink::Receiver receiver;
        int page;
        { std::lock_guard<std::mutex> guard(mutex_);
          if (closed_ || !binary_ || !frameReceiver_) return false;
          receiver = frameReceiver_; page = framePage_;
        }
        using V = dimina::bridge::Value;
        const auto number = [](double n) { V v; v.kind = V::Number; v.number = n; return v; };
        const auto string = [](std::u16string s) { V v; v.kind = V::String; v.string = std::move(s); return v; };
        V args; args.kind = V::Object;
        args.object.emplace_back(u"requestId", number(request));
        args.object.emplace_back(u"sequence", number(sequence));
        args.object.emplace_back(u"timestamp", number(timestamp));
        args.object.emplace_back(u"clock", string(u"monotonic"));
        V body; body.kind = V::Object;
        body.object.emplace_back(u"bridgeId", number(page));
        body.object.emplace_back(u"id", string(dimina::bridge::decodeString(callback.data(), callback.size())));
        body.object.emplace_back(u"args", std::move(args));
        V message; message.kind = V::Object;
        message.object.emplace_back(u"type", string(u"triggerCallback"));
        message.object.emplace_back(u"target", string(u"service"));
        message.object.emplace_back(u"body", std::move(body));
        const bool accepted = receiver({std::move(message), std::move(alive)});
        return accepted;
    }
    bool SendScript(std::string script) {
        bool failed = false;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_) return false;
            if (script.size() > MAX_UI_SCRIPT_BYTES) failed = true;
            else {
                auto command = std::make_unique<UiCommand>(); command->script = std::move(script);
                try { failed = !submit_(std::move(command)); } catch (...) { failed = true; }
            }
        }
        if (failed) Close("canvas UI submission failed");
        return !failed;
    }
    bool Publish(std::string body, std::vector<std::vector<uint8_t>> buffers = {}) {
        bool failed = false;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_) return false;
            auto command = std::make_unique<UiCommand>();
            if (binary_ && !buffers.empty()) command->packet = CanvasPacket(true, NextId(), body, 0, buffers);
            else {
                if (!buffers.empty()) throw std::runtime_error("canvas binary channel is unavailable");
                if (body.size() > MAX_UI_SCRIPT_BYTES - 64) throw std::length_error("canvas publish exceeds budget");
                command->script = "DiminaRenderBridge.onMessage(" + body + ")";
            }
            try { failed = !submit_(std::move(command)); } catch (...) { failed = true; }
        }
        if (failed) Close("canvas UI submission failed");
        return !failed;
    }
    UiReply Query(std::string body, int64_t deadline, std::vector<std::vector<uint8_t>> buffers = {}) {
        if (deadline <= NowMs()) return {"", "canvas query timed out before submission"};
        if (body.size() > MAX_UI_SCRIPT_BYTES - 1024) return {"", "canvas query exceeds its script budget"};
        auto request = std::make_shared<Request>();
        std::string id;
        bool failed = false;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_) return {"", "canvas page was closed"};
            if (pending_.size() >= MAX_UI_PENDING_QUERIES) return {"", "canvas query queue exceeds budget"};
            id = NextId();
            auto command = std::make_unique<UiCommand>(); command->requestId = id;
            if (binary_) {
                try { command->packet = CanvasPacket(false, id, body, deadline, buffers); }
                catch (const std::length_error &e) { return {"", e.what()}; }
            } else {
                if (!buffers.empty()) return {"", "canvas binary channel is unavailable"};
                command->script = "(() => { try { if (Date.now() >= " + std::to_string(deadline) +
                    ") throw new Error('canvas query timed out'); if (typeof globalThis.__diminaCanvasSync !== 'function') "
                    "throw new Error('canvas runtime unavailable'); return JSON.stringify(globalThis.__diminaCanvasSync(" +
                    body + ")); } catch (e) { return JSON.stringify({error:String(e)}); } })()";
            }
            pending_.emplace(id, request);
            try { failed = !submit_(std::move(command)); } catch (...) { failed = true; }
        }
        if (failed) Close("canvas UI submission failed");
        UiReply reply = request->Wait(deadline);
        { std::lock_guard<std::mutex> guard(mutex_); pending_.erase(id); }
        return reply;
    }
    // A native callback may already be running when UI selects legacy. Its
    // reply/error must observe that choice under the same channel mutex.
    void Complete(const std::string &id, UiReply reply, bool nativeFeedback = false) {
        std::lock_guard<std::mutex> guard(mutex_);
        if (closed_ || (nativeFeedback && legacyChosen_)) return;
        auto request = pending_.find(id);
        if (request != pending_.end()) { request->second->Complete(std::move(reply)); pending_.erase(request); }
    }
    void Close(const char *reason, bool nativeFeedback = false) noexcept {
      try {
        std::function<void()> retire;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_ || (nativeFeedback && legacyChosen_)) return;
            closed_ = true;
            for (auto &request : pending_) request.second->Fail(reason);
            pending_.clear(); retire = std::move(retire_);
        }
        if (retire) retire();
      } catch (...) { /* Cleanup must not throw across a native callback. */ }
    }
private:
    std::string NextId() {
        if (sequence_ >= 9007199254740991ULL) throw std::length_error("canvas request counter exhausted");
        return token_ + ":" + std::to_string(++sequence_);
    }
    const std::string token_;
    Submit submit_;
    DisplayControl displayControl_;
    dimina::bridge::NativeMessageSink::Receiver frameReceiver_;
    int framePage_ = -1;
    std::function<void()> retire_;
    mutable std::mutex mutex_;
    bool closed_ = false, binary_ = false, legacyChosen_ = false, nativeChosen_ = false;
    uint64_t sequence_ = 0;
    std::map<std::string, std::shared_ptr<Request>> pending_;
};
} // namespace dimina::canvas
