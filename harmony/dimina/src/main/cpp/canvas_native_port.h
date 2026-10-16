#pragma once
#include "canvas_ui_channel.h"
#include <web/arkweb_interface.h>
#include <deque>
#include <atomic>
#include <limits>
#include <tuple>

namespace dimina::canvas {
// Creation, transfer and disposal run on UI. Posting and feedback use only
// owned bytes and the ArkWeb API; no QuickJS or N-API handles cross threads.
class NativeCanvasPort : public std::enable_shared_from_this<NativeCanvasPort> {
    using PortKey = std::tuple<std::string, uintptr_t, uintptr_t>;
    inline static std::atomic<uintptr_t> nextRoute {0};
    inline static std::mutex routesMutex;
    inline static std::map<PortKey, std::weak_ptr<NativeCanvasPort>> routes;
    std::mutex mutex;
    const std::string tag, token;
    const uintptr_t routeId;
    std::weak_ptr<UiChannel> channel;
    ArkWeb_ControllerAPI *controller;
    ArkWeb_WebMessagePortAPI *portAPI;
    ArkWeb_WebMessageAPI *messageAPI;
    ArkWeb_WebMessagePortPtr *ports = nullptr;
    size_t count = 0, queuedBytes = 0;
    bool ready = false, closed = false, connected = false;
    std::deque<std::unique_ptr<UiCommand>> queued;

    bool Post(UiCommand &command) {
        auto message = messageAPI->createWebMessage();
        if (!message) return false;
        bool accepted = false;
        try {
            std::string script;
            if (!command.packet.empty()) {
                messageAPI->setType(message, ARKWEB_BUFFER);
                messageAPI->setData(message, command.packet.data(), command.packet.size());
            } else {
                script = "{\"type\":" + QuoteCanvasString(command.requestId.empty() ? "script" : "legacy") +
                    ",\"requestId\":" + QuoteCanvasString(command.requestId) +
                    ",\"script\":" + QuoteCanvasString(command.script) + "}";
                if (script.size() > MAX_UI_SCRIPT_BYTES) throw std::length_error("canvas script exceeds budget");
                messageAPI->setType(message, ARKWEB_STRING);
                messageAPI->setData(message, script.data(), script.size());
            }
            accepted = portAPI->postMessage(ports[0], tag.c_str(), message) == ARKWEB_SUCCESS;
        } catch (...) {
            messageAPI->destroyWebMessage(&message); throw;
        }
        messageAPI->destroyWebMessage(&message);
        return accepted;
    }
    static void Receive(const char *webTag, ArkWeb_WebMessagePortPtr port,
                        ArkWeb_WebMessagePtr message, void *opaque) noexcept {
        std::shared_ptr<UiChannel> owner;
        try {
            std::shared_ptr<NativeCanvasPort> self;
            {
                std::lock_guard<std::mutex> guard(routesMutex);
                const auto found = routes.find({webTag ? webTag : "", reinterpret_cast<uintptr_t>(port), reinterpret_cast<uintptr_t>(opaque)});
                if (found != routes.end()) self = found->second.lock();
            }
            if (!self) return;
            owner = self->channel.lock();
            if (!owner || !owner->IsOpen()) return;
            size_t length = 0;
            const auto data = self->messageAPI->getData(message, &length);
            if (self->messageAPI->getType(message) != ARKWEB_STRING || !data || length > MAX_UI_SCRIPT_BYTES) {
                owner->Close("invalid native canvas feedback", true); return;
            }
            std::string text(static_cast<const char *>(data), length);
            if (!text.empty() && text.back() == '\0') text.pop_back();
            if (text == "ready\n" + self->token) {
                bool failed = false;
                owner->ActivateBinary([&] {
                    std::lock_guard<std::mutex> guard(self->mutex);
                    if (self->closed) return false;
                    self->ready = true;
                    for (auto &command : self->queued) {
                        if (!self->Post(*command)) { failed = true; break; }
                    }
                    self->queued.clear(); self->queuedBytes = 0;
                    return !failed;
                });
                if (failed) owner->Close("native canvas submission failed", true);
                return;
            }
            const auto failurePrefix = "error\n" + self->token + "\n";
            if (text.rfind(failurePrefix, 0) == 0) { owner->Close(text.substr(failurePrefix.size(), 4096).c_str(), true); return; }
            const auto delimiter = text.find('\n');
            const bool error = !text.empty() && text[0] == '!';
            if (delimiter == std::string::npos || delimiter > 160 || delimiter <= size_t(error)) {
                owner->Close("invalid native canvas reply", true); return;
            }
            const std::string id = text.substr(error ? 1 : 0, delimiter - (error ? 1 : 0));
            const auto prefix = self->token + ":";
            if (id.rfind(prefix, 0) != 0) return;
            const auto number = id.substr(prefix.size());
            if (number.empty() || number[0] == '0' || number.find_first_not_of("0123456789") != std::string::npos) {
                owner->Close("invalid native canvas request ID", true); return;
            }
            std::string body = text.substr(delimiter + 1);
            owner->Complete(id, error ? UiReply {"", std::move(body)} : UiReply {std::move(body), ""}, true);
        } catch (...) {
            if (owner) owner->Close("native canvas callback failed", true);
        }
    }
    NativeCanvasPort(std::string tag, uintptr_t routeId, std::shared_ptr<UiChannel> owner,
                     ArkWeb_ControllerAPI *controller, ArkWeb_WebMessagePortAPI *portAPI,
                     ArkWeb_WebMessageAPI *messageAPI)
        : tag(std::move(tag)), token(owner->Token()), routeId(routeId), channel(owner), controller(controller),
          portAPI(portAPI), messageAPI(messageAPI) {}
public:
    static std::shared_ptr<NativeCanvasPort> CreateUI(std::string tag, std::shared_ptr<UiChannel> owner) {
        auto c = reinterpret_cast<ArkWeb_ControllerAPI *>(OH_ArkWeb_GetNativeAPI(ARKWEB_NATIVE_CONTROLLER));
        auto p = reinterpret_cast<ArkWeb_WebMessagePortAPI *>(OH_ArkWeb_GetNativeAPI(ARKWEB_NATIVE_WEB_MESSAGE_PORT));
        auto m = reinterpret_cast<ArkWeb_WebMessageAPI *>(OH_ArkWeb_GetNativeAPI(ARKWEB_NATIVE_WEB_MESSAGE));
        if (tag.empty() || !c || !p || !m || ARKWEB_MEMBER_MISSING(c, createWebMessagePorts) ||
            ARKWEB_MEMBER_MISSING(c, postWebMessage) || ARKWEB_MEMBER_MISSING(c, destroyWebMessagePorts) ||
            ARKWEB_MEMBER_MISSING(p, postMessage) || ARKWEB_MEMBER_MISSING(p, setMessageEventHandler) ||
            ARKWEB_MEMBER_MISSING(p, close) || ARKWEB_MEMBER_MISSING(m, createWebMessage) ||
            ARKWEB_MEMBER_MISSING(m, destroyWebMessage) || ARKWEB_MEMBER_MISSING(m, setType) ||
            ARKWEB_MEMBER_MISSING(m, getType) || ARKWEB_MEMBER_MISSING(m, setData) || ARKWEB_MEMBER_MISSING(m, getData))
            return nullptr;
        uintptr_t previous = nextRoute.load(std::memory_order_relaxed);
        do {
            if (previous == std::numeric_limits<uintptr_t>::max()) return nullptr;
        } while (!nextRoute.compare_exchange_weak(previous, previous + 1, std::memory_order_relaxed));
        return std::shared_ptr<NativeCanvasPort>(new NativeCanvasPort(std::move(tag), previous + 1, owner, c, p, m));
    }
    bool ConnectUI() {
        {
            std::lock_guard<std::mutex> guard(mutex);
            if (closed) return false;
            if (ports) return connected;
            ports = controller->createWebMessagePorts(tag.c_str(), &count);
            if (!ports || count != 2 || !ports[0] || !ports[1]) return false;
        }
        {
            std::lock_guard<std::mutex> guard(routesMutex);
            routes[{tag, reinterpret_cast<uintptr_t>(ports[0]), routeId}] = shared_from_this();
        }
        portAPI->setMessageEventHandler(ports[0], tag.c_str(), Receive, reinterpret_cast<void *>(routeId));
        const bool posted = controller->postWebMessage(tag.c_str(), token.c_str(), ports + 1, 1, "*") == ARKWEB_SUCCESS;
        std::lock_guard<std::mutex> guard(mutex);
        connected = posted && !closed;
        return connected;
    }
    bool Submit(std::unique_ptr<UiCommand> command) {
        std::lock_guard<std::mutex> guard(mutex);
        if (closed) return false;
        if (ready) return Post(*command);
        const size_t size = command->script.size() + command->packet.size();
        if (queued.size() >= 200 || size > MAX_UI_SCRIPT_BYTES - queuedBytes) return false;
        queuedBytes += size; queued.push_back(std::move(command)); return true;
    }
    std::deque<std::unique_ptr<UiCommand>> StopAndTakePending() {
        std::lock_guard<std::mutex> guard(mutex);
        closed = true; ready = false; queuedBytes = 0;
        return std::move(queued);
    }
    void Stop() { StopAndTakePending(); }
    void DisposeUI() {
        ArkWeb_WebMessagePortPtr *retired = nullptr; size_t retiredCount = 0;
        {
            std::lock_guard<std::mutex> guard(mutex);
            closed = true; ready = false; queued.clear(); queuedBytes = 0;
            retired = ports; retiredCount = count; ports = nullptr; count = 0;
        }
        if (!retired) return;
        {
            std::lock_guard<std::mutex> guard(routesMutex);
            if (retiredCount) routes.erase({tag, reinterpret_cast<uintptr_t>(retired[0]), routeId});
        }
        for (size_t i = 0; i < retiredCount; ++i) if (retired[i]) portAPI->close(retired[i], tag.c_str());
        controller->destroyWebMessagePorts(&retired, retiredCount);
    }
};
} // namespace dimina::canvas
