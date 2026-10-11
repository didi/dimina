#include "../napi_value.hpp"
#include "../quickjs_value.hpp"

using namespace dimina::bridge;
static napi_value roundTrip(napi_env env, napi_callback_info info) {
    napi_value input, output = nullptr;
    size_t argc = 1;
    checkNAPI(napi_get_cb_info(env, info, &argc, &input, nullptr, nullptr));
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *ctx = JS_NewContext(runtime);
    try {
        Value packet = fromNAPI(env, input);
        OwnedJSValue js(ctx, toJS(ctx, packet));
        output = toNAPI(env, fromJS(ctx, js.value));
    } catch (const std::exception &error) {
        bool pending = false;
        napi_is_exception_pending(env, &pending);
        if (!pending) napi_throw_error(env, nullptr, error.what());
    }
    if (JS_HasException(ctx)) JS_FreeValue(ctx, JS_GetException(ctx));
    JS_FreeContext(ctx);
    JS_FreeRuntime(runtime);
    return output;
}
static napi_value init(napi_env env, napi_value exports) {
    napi_property_descriptor property{};
    property.utf8name = "roundTrip";
    property.method = roundTrip;
    checkNAPI(napi_define_properties(env, exports, 1, &property));
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
