#include "canvas_ui_route.h"
#include <atomic>
#include <set>
#include <stdexcept>
#include <vector>

namespace dimina::canvas {
namespace {
using Key = std::pair<int, int>;
struct UiHandle {
    std::mutex mutex;
    napi_threadsafe_function function = nullptr;
    bool Submit(std::unique_ptr<UiCommand> command) {
        std::lock_guard<std::mutex> guard(mutex);
        if (!function || napi_acquire_threadsafe_function(function) != napi_ok) return false;
        const napi_status result = napi_call_threadsafe_function(function, command.get(), napi_tsfn_nonblocking);
        napi_release_threadsafe_function(function, napi_tsfn_release);
        if (result != napi_ok) return false;
        command.release(); return true;
    }
    void Close() {
        napi_threadsafe_function retired;
        { std::lock_guard<std::mutex> guard(mutex); retired = function; function = nullptr; }
        if (retired) napi_release_threadsafe_function(retired, napi_tsfn_abort);
    }
    void Forget() { std::lock_guard<std::mutex> guard(mutex); function = nullptr; }
};
struct Context { napi_env env; std::shared_ptr<UiHandle> handle; std::shared_ptr<UiChannel> channel; };
struct Entry { napi_env env; std::shared_ptr<UiChannel> channel; };
std::mutex registryMutex;
std::map<Key, Entry> registry;
std::map<std::string, std::weak_ptr<UiChannel>> tokens;
std::set<napi_env> hookedEnvs;
std::atomic<uint64_t> nextToken {0};

std::string String(napi_env env, napi_value value) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
        length > MAX_UI_SCRIPT_BYTES) throw std::runtime_error("invalid canvas UI string");
    std::string result(length + 1, '\0');
    if (napi_get_value_string_utf8(env, value, result.data(), result.size(), &length) != napi_ok)
        throw std::runtime_error("invalid canvas UI string");
    result.resize(length); return result;
}
int Integer(napi_env env, napi_value value) {
    int32_t result = 0;
    if (napi_get_value_int32(env, value, &result) != napi_ok) throw std::runtime_error("invalid canvas UI owner");
    return result;
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
  } catch (...) { /* Environment cleanup cannot propagate exceptions. */ }
}
void Finalize(napi_env, void *data, void *) {
    std::unique_ptr<Context> context(static_cast<Context *>(data));
    context->handle->Forget(); context->channel->Close("canvas UI environment was closed");
}
void Deliver(napi_env env, napi_value callback, void *opaque, void *data) {
    std::unique_ptr<UiCommand> command(static_cast<UiCommand *>(data));
    auto context = static_cast<Context *>(opaque);
    if (!env || !callback || !context->channel->IsOpen()) return;
    napi_handle_scope scope;
    if (napi_open_handle_scope(env, &scope) != napi_ok) {
        context->channel->Close("canvas UI callback failed"); return;
    }
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
        size_t argc = 3; napi_value args[3]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
        if (argc != 3) throw std::runtime_error("invalid canvas UI registration");
        Key key {Integer(env, args[0]), Integer(env, args[1])};
        const std::string token = "canvas" + std::to_string(++nextToken);
        auto handle = std::make_shared<UiHandle>();
        auto channel = std::make_shared<UiChannel>(token,
            [handle](std::unique_ptr<UiCommand> command) { return handle->Submit(std::move(command)); },
            [handle] { handle->Close(); });
        auto context = std::make_unique<Context>(Context {env, handle, channel});
        napi_value resource;
        napi_create_string_utf8(env, "dimina-canvas-ui", NAPI_AUTO_LENGTH, &resource);
        if (napi_create_threadsafe_function(env, args[2], nullptr, resource, 256, 1, context.get(), Finalize,
            context.get(), Deliver, &handle->function) != napi_ok) throw std::runtime_error("cannot register canvas UI callback");
        context.release();
        std::shared_ptr<UiChannel> previous;
        try {
            std::lock_guard<std::mutex> guard(registryMutex);
            auto old = registry.find(key);
            if (hookedEnvs.insert(env).second && napi_add_env_cleanup_hook(env, EnvCleanup, env) != napi_ok) {
                hookedEnvs.erase(env); throw std::runtime_error("cannot register canvas UI cleanup");
            }
            tokens.emplace(token, channel);
            try {
                if (old == registry.end()) registry.emplace(key, Entry {env, channel});
                else { previous = old->second.channel; old->second = {env, channel}; }
            } catch (...) { tokens.erase(token); throw; }
            if (previous) tokens.erase(previous->Token());
        } catch (...) {
            channel->Close("canvas UI registration failed"); throw;
        }
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
            if (old != registry.end() && old->second.channel->Token() == token) {
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
        auto channel = FindUiChannel(Integer(env, args[0]), Integer(env, args[1]));
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
            auto found = tokens.find(id.substr(0, id.find(':'))); if (found != tokens.end()) channel = found->second.lock();
        }
        if (channel) channel->Complete(id, {String(env, args[1]), argc == 3 ? String(env, args[2]) : std::string{}});
        napi_value result; napi_get_undefined(env, &result); return result;
    } catch (const std::exception &error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
