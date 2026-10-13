#pragma once
#include "canvas_ui_channel.h"
#include <napi/native_api.h>

namespace dimina::canvas {
std::shared_ptr<UiChannel> FindUiChannel(int owner, int page);
void DisposeUiChannels(int owner);
}
napi_value canvasUiRegister(napi_env env, napi_callback_info info);
napi_value canvasUiUnregister(napi_env env, napi_callback_info info);
napi_value canvasUiPublish(napi_env env, napi_callback_info info);
napi_value canvasUiComplete(napi_env env, napi_callback_info info);
