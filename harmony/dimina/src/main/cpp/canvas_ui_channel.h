#pragma once
#include <chrono>
#include <condition_variable>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>

namespace dimina::canvas {
constexpr size_t MAX_UI_SCRIPT_BYTES = 64 * 1024 * 1024;
inline int64_t NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}
struct UiReply { std::string json, error; };
struct UiCommand { std::string requestId, script; };

// Only owned text crosses threads. The submitter enqueues asynchronously;
// it must not execute a command or complete a reply inside Submit.
class UiChannel {
    struct Request {
        std::mutex mutex;
        std::condition_variable cv;
        bool done = false;
        UiReply reply;
        const char *failure = nullptr;
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
            return failure ? UiReply {"", failure} : reply;
        }
    };
public:
    using Submit = std::function<bool(std::unique_ptr<UiCommand>)>;
    UiChannel(std::string token, Submit submit, std::function<void()> retire)
        : token_(std::move(token)), submit_(std::move(submit)), retire_(std::move(retire)) {}
    ~UiChannel() { Close("canvas page was closed"); }
    const std::string &Token() const { return token_; }
    bool IsOpen() const { std::lock_guard<std::mutex> guard(mutex_); return !closed_; }
    size_t Pending() const { std::lock_guard<std::mutex> guard(mutex_); return pending_.size(); }

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
    UiReply Query(std::string body, int64_t deadline) {
        if (deadline <= NowMs()) return {"", "canvas query timed out before submission"};
        if (body.size() > MAX_UI_SCRIPT_BYTES - 1024) return {"", "canvas query exceeds its script budget"};
        auto request = std::make_shared<Request>();
        std::string id;
        bool failed = false;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_) return {"", "canvas page was closed"};
            id = token_ + ":" + std::to_string(++sequence_);
            auto command = std::make_unique<UiCommand>(); command->requestId = id;
            command->script = "(() => { try { if (Date.now() >= " + std::to_string(deadline) +
                ") throw new Error('canvas query timed out'); if (typeof globalThis.__diminaCanvasSync !== 'function') "
                "throw new Error('canvas runtime unavailable'); return JSON.stringify(globalThis.__diminaCanvasSync(" +
                body + ")); } catch (e) { return JSON.stringify({error:String(e)}); } })()";
            pending_.emplace(id, request);
            try { failed = !submit_(std::move(command)); } catch (...) { failed = true; }
        }
        if (failed) Close("canvas UI submission failed");
        UiReply reply = request->Wait(deadline);
        {
            std::lock_guard<std::mutex> guard(mutex_);
            pending_.erase(id);
        }
        return reply;
    }
    void Complete(const std::string &id, UiReply reply) {
        std::lock_guard<std::mutex> guard(mutex_);
        if (closed_) return;
        auto request = pending_.find(id);
        if (request != pending_.end()) {
            request->second->Complete(std::move(reply)); pending_.erase(request);
        }
    }
    void Close(const char *reason) noexcept {
      try {
        std::function<void()> retire;
        {
            std::lock_guard<std::mutex> guard(mutex_);
            if (closed_) return;
            closed_ = true;
            for (auto &request : pending_) request.second->Fail(reason);
            pending_.clear(); retire = std::move(retire_);
        }
        if (retire) retire();
      } catch (...) { /* Cleanup must not throw across a native callback. */ }
    }
private:
    const std::string token_;
    Submit submit_;
    std::function<void()> retire_;
    mutable std::mutex mutex_;
    bool closed_ = false;
    uint64_t sequence_ = 0;
    std::map<std::string, std::shared_ptr<Request>> pending_;
};
} // namespace dimina::canvas
