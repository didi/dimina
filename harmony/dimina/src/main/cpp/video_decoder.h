#pragma once
#include "napi/native_api.h"
#include "video_decoder_frame.h"

void RegisterVideoDecoder(napi_env env, napi_value exports);
void DisposeVideoDecoders(int owner);
