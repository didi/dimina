#pragma once
#include "bridge_value.hpp"
#include <functional>
#include <memory>
#include <mutex>
namespace dimina::bridge {
// The producer owns scalars/bytes only. Close joins in-flight posts before the
// receiver's queue and uv handles can be destroyed. No VM handles cross threads.
class NativeMessageSink {
public:
    struct Packet { Value message; std::function<bool()> alive; };
    using Receiver = std::function<bool(Packet)>;
private:
    struct State { std::mutex mutex; Receiver post; };
    std::shared_ptr<State> state = std::make_shared<State>();
public:
    void Bind(Receiver post) { std::lock_guard<std::mutex> lock(state->mutex); state->post = std::move(post); }
    Receiver Get() const {
        std::weak_ptr<State> weak = state;
        return [weak](Packet packet) {
            if (auto target = weak.lock()) {
                std::lock_guard<std::mutex> lock(target->mutex);
                return target->post && target->post(std::move(packet));
            }
            return false;
        };
    }
    void Close() { std::lock_guard<std::mutex> lock(state->mutex); state->post = nullptr; }
    ~NativeMessageSink() { Close(); }
};
}
