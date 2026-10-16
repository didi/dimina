#include "canvas_ui_route.h"
#include "canvas_native_port.h"
#include <atomic>
#include <cmath>
#include <limits>
#include <set>
#include <stdexcept>

namespace dimina::canvas {
namespace {
using Key = std::pair<int, int>;
struct UiHandle {
    std::mutex mutex;
    napi_threadsafe_function function = nullptr;
    std::shared_ptr<NativeCanvasPort> native;
    // Caller owns this handle's mutex. TSFN retains only the owned command.
    bool SubmitLegacy(std::unique_ptr<UiCommand> command) {
        if (!command->packet.empty() || !function || napi_acquire_threadsafe_function(function) != napi_ok) return false;
        const auto result = napi_call_threadsafe_function(function, command.get(), napi_tsfn_nonblocking);
        napi_release_threadsafe_function(function, napi_tsfn_release);
        if (result != napi_ok) return false;
        command.release(); return true;
    }
    bool Submit(std::unique_ptr<UiCommand> command) {
        std::lock_guard<std::mutex> guard(mutex);
        return native ? native->Submit(std::move(command)) : SubmitLegacy(std::move(command));
    }
    std::shared_ptr<NativeCanvasPort> Native() {
        std::lock_guard<std::mutex> guard(mutex); return native;
    }
    void Close() {
        napi_threadsafe_function retired;
        {
            std::lock_guard<std::mutex> guard(mutex);
            retired = function; function = nullptr;
            if (native) native->Stop();
        }
        if (retired) napi_release_threadsafe_function(retired, napi_tsfn_abort);
    }
    void Forget() { std::lock_guard<std::mutex> guard(mutex); function = nullptr; }
};
struct Context { napi_env env; std::shared_ptr<UiHandle> handle; std::shared_ptr<UiChannel> channel; };
struct Entry { napi_env env; std::shared_ptr<UiChannel> channel; std::shared_ptr<UiHandle> handle; };
struct TokenEntry { napi_env env; std::weak_ptr<UiChannel> channel; };
std::mutex registryMutex;
std::map<Key, Entry> registry;
std::map<std::string, TokenEntry> tokens;
std::set<napi_env> hookedEnvs;
std::atomic<uint64_t> nextToken {0};
std::string String(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length > MAX_UI_SCRIPT_BYTES)
        throw std::runtime_error("invalid canvas UI string");
    std::string result(length + 1, '\0');
    if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &length) != napi_ok)
        throw std::runtime_error("invalid canvas UI string");
    result.resize(length); return result;
}
int Integer(napi_env env, napi_value value) {
    double result = -1;
    if (napi_get_value_double(env, value, &result) != napi_ok || !std::isfinite(result) || result < 0 ||
        result > std::numeric_limits<int32_t>::max() || std::floor(result) != result)
        throw std::runtime_error("invalid canvas UI owner");
    return static_cast<int>(result);
}
std::vector<std::shared_ptr<UiChannel>> RemoveMatching(int owner, napi_env env) {
    std::vector<std::shared_ptr<UiChannel>> retired;
    std::lock_guard<std::mutex> guard(registryMutex);
    for (auto it = registry.begin(); it != registry.end();) {
        if (env ? it->second.env == env : it->first.first == owner) {
            tokens.erase(it->second.channel->Token()); retired.push_back(it->second.channel); it = registry.erase(it);
        } else ++it;
    }
    return retired;
}
void EnvCleanup(void *data) {
    try {
        const auto env = static_cast<napi_env>(data);
        for (auto &channel : RemoveMatching(0, env)) channel->Close("canvas UI environment was closed");
        std::lock_guard<std::mutex> guard(registryMutex); hookedEnvs.erase(env);
    } catch (...) { /* Cleanup cannot propagate exceptions. */ }
}
void Finalize(napi_env, void *data, void *) {
    std::unique_ptr<Context> context(static_cast<Context *>(data));
    if (auto native = context->handle->Native()) native->DisposeUI();
    context->handle->Forget(); context->channel->Close("canvas UI environment was closed");
}
void Deliver(napi_env env, napi_value callback, void *opaque, void *data) {
    std::unique_ptr<UiCommand> command(static_cast<UiCommand *>(data));
    auto context = static_cast<Context *>(opaque);
    if (!env || !callback || !context->channel->IsOpen()) return;
    if (!command->packet.empty()) { context->channel->Close("invalid legacy canvas packet"); return; }
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) { context->channel->Close("canvas UI callback failed"); return; }
    napi_value args[2], global, result;
    const bool failed = napi_create_string_utf8(env, command->requestId.data(), command->requestId.size(), &args[0]) != napi_ok ||
        napi_create_string_utf8(env, command->script.data(), command->script.size(), &args[1]) != napi_ok ||
        napi_get_global(env, &global) != napi_ok || napi_call_function(env, global, callback, 2, args, &result) != napi_ok;
    if (failed) {
        napi_value exception; napi_get_and_clear_last_exception(env, &exception);
        context->channel->Close("canvas UI callback failed");
    }
    napi_close_handle_scope(env, scope);
}
bool FallbackUI(const Entry &entry) {
    std::shared_ptr<NativeCanvasPort> retired;
    const bool selected = entry.channel->UseLegacy([&] {
        std::lock_guard<std::mutex> guard(entry.handle->mutex);
        retired = std::move(entry.handle->native);
        if (!retired) return true;
        auto pending = retired->StopAndTakePending();
        for (auto &command : pending) if (!entry.handle->SubmitLegacy(std::move(command))) return false;
        return true;
    });
    // Closing a port may wait on callbacks. Do it on UI, outside channel/handle locks.
    if (retired) retired->DisposeUI();
    if (!selected && !entry.channel->IsBinary()) entry.channel->Close("canvas startup fallback failed");
    return selected || entry.channel->IsBinary();
}
} // namespace
std::shared_ptr<UiChannel> FindUiChannel(int owner, int page) {
    std::lock_guard<std::mutex> guard(registryMutex);
    auto route = registry.find({owner, page});
    return route == registry.end() ? nullptr : route->second.channel;
}
void DisposeUiChannels(int owner) {
    for (auto &channel : RemoveMatching(owner, nullptr)) channel->Close("canvas service was closed");
}
} // namespace dimina::canvas

using namespace dimina::canvas;
napi_value canvasUiRegister(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc < 3) throw std::runtime_error("invalid canvas UI registration");
        Key key {Integer(env, args[0]), Integer(env, args[1])};
        {
            std::lock_guard<std::mutex> guard(registryMutex); auto old = registry.find(key);
            if (old != registry.end() && old->second.env != env)
                throw std::runtime_error("canvas owner belongs to another environment");
        }
        const std::string token = "canvas" + std::to_string(++nextToken);
        auto handle = std::make_shared<UiHandle>();
        auto channel = std::make_shared<UiChannel>(token,
            [handle](std::unique_ptr<UiCommand> command) { return handle->Submit(std::move(command)); },
            [handle] { handle->Close(); });
        if (argc == 4) handle->native = NativeCanvasPort::CreateUI(String(env, args[3]), channel);
        if (!handle->native) channel->UseLegacy([] { return true; });
        auto context = std::make_unique<Context>(Context {env, handle, channel});
        napi_value resource;
        if (napi_create_string_utf8(env, "dimina-canvas-ui", NAPI_AUTO_LENGTH, &resource) != napi_ok ||
            napi_create_threadsafe_function(env, args[2], nullptr, resource, 256, 1, context.get(), Finalize,
                context.get(), Deliver, &handle->function) != napi_ok)
            throw std::runtime_error("cannot register canvas UI callback");
        context.release();
        std::shared_ptr<UiChannel> previous;
        try {
            std::lock_guard<std::mutex> guard(registryMutex);
            auto old = registry.find(key);
            if (old != registry.end() && old->second.env != env)
                throw std::runtime_error("canvas owner belongs to another environment");
            if (hookedEnvs.insert(env).second && napi_add_env_cleanup_hook(env, EnvCleanup, env) != napi_ok) {
                hookedEnvs.erase(env); throw std::runtime_error("cannot register canvas UI cleanup");
            }
            tokens.emplace(token, TokenEntry {env, channel});
            try {
                if (old == registry.end()) registry.emplace(key, Entry {env, channel, handle});
                else { previous = old->second.channel; old->second = {env, channel, handle}; }
            } catch (...) { tokens.erase(token); throw; }
            if (previous) tokens.erase(previous->Token());
        } catch (...) { channel->Close("canvas UI registration failed"); throw; }
        if (previous) previous->Close("canvas page was replaced");
        napi_value result;
        if (napi_create_string_utf8(env, token.data(), token.size(), &result) != napi_ok) {
            channel->Close("canvas UI registration failed");
            { std::lock_guard<std::mutex> guard(registryMutex); registry.erase(key); tokens.erase(token); }
            throw std::runtime_error("cannot return canvas UI registration");
        }
        return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value canvasUiUnregister(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc != 3) throw std::runtime_error("invalid canvas UI unregister");
        Key key {Integer(env, args[0]), Integer(env, args[1])}; const auto token = String(env, args[2]);
        std::shared_ptr<UiChannel> previous;
        {
            std::lock_guard<std::mutex> guard(registryMutex); auto old = registry.find(key);
            if (old != registry.end() && old->second.env == env && old->second.channel->Token() == token) {
                previous = old->second.channel; tokens.erase(token); registry.erase(old);
            }
        }
        if (previous) previous->Close("canvas page was closed");
        napi_value result; napi_get_undefined(env, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value canvasUiPublish(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc != 3) throw std::runtime_error("invalid canvas UI script");
        std::shared_ptr<UiChannel> channel;
        {
            std::lock_guard<std::mutex> guard(registryMutex);
            auto found = registry.find({Integer(env, args[0]), Integer(env, args[1])});
            if (found != registry.end() && found->second.env == env) channel = found->second.channel;
        }
        const bool sent = channel && channel->SendScript(String(env, args[2]));
        napi_value result; napi_get_boolean(env, sent, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value canvasUiComplete(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc < 2) throw std::runtime_error("invalid canvas UI feedback");
        const auto id = String(env, args[0]); std::shared_ptr<UiChannel> channel;
        {
            std::lock_guard<std::mutex> guard(registryMutex);
            auto found = tokens.find(id.substr(0, id.find(':')));
            if (found != tokens.end() && found->second.env == env) channel = found->second.channel.lock();
        }
        if (channel) channel->Complete(id, {String(env, args[1]), argc == 3 ? String(env, args[2]) : std::string {}});
        napi_value result; napi_get_undefined(env, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value canvasUiConnectNative(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 4; napi_value args[4]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc < 3) throw std::runtime_error("invalid native canvas connect");
        const Key key {Integer(env, args[0]), Integer(env, args[1])}; const auto token = String(env, args[2]);
        bool allowNative = true;
        if (argc == 4 && napi_get_value_bool(env, args[3], &allowNative) != napi_ok)
            throw std::runtime_error("invalid native canvas capability");
        std::shared_ptr<Entry> entry;
        {
            std::lock_guard<std::mutex> guard(registryMutex); auto found = registry.find(key);
            if (found != registry.end() && found->second.env == env && found->second.channel->Token() == token)
                entry = std::make_shared<Entry>(found->second);
        }
        bool connected = false;
        if (entry) {
            auto port = entry->handle->Native();
            connected = allowNative && port && port->ConnectUI();
            if (!connected) connected = FallbackUI(*entry);
        }
        napi_value result; napi_get_boolean(env, connected, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
napi_value canvasUiNativeReady(napi_env env, napi_callback_info info) {
    try {
        size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc != 3) throw std::runtime_error("invalid native canvas readiness query");
        const Key key {Integer(env, args[0]), Integer(env, args[1])}; const auto token = String(env, args[2]);
        bool ready = false;
        {
            std::lock_guard<std::mutex> guard(registryMutex); auto found = registry.find(key);
            if (found != registry.end() && found->second.env == env && found->second.channel->Token() == token)
                ready = found->second.channel->IsBinary();
        }
        napi_value result; napi_get_boolean(env, ready, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
