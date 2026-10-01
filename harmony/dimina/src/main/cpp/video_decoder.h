#pragma once
#include "napi/native_api.h"

void RegisterVideoDecoder(napi_env env, napi_value exports);
void DisposeVideoDecoders(int owner);
