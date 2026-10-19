#pragma once
struct OH_NativeVSync;
using OH_NativeVSync_FrameCallback=void(*)(long long,void*);
extern "C" {
OH_NativeVSync* OH_NativeVSync_Create(const char*,unsigned int);
void OH_NativeVSync_Destroy(OH_NativeVSync*);
int OH_NativeVSync_RequestFrame(OH_NativeVSync*,OH_NativeVSync_FrameCallback,void*);
}
