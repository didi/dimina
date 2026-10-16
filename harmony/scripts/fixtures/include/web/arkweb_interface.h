#pragma once
#include <cstddef>
#include <type_traits>
struct FakePort;
struct FakeMessage;
using ArkWeb_WebMessagePortPtr = FakePort *;
using ArkWeb_WebMessagePtr = FakeMessage *;
using ArkWeb_OnMessageEventHandler = void (*)(const char *, ArkWeb_WebMessagePortPtr, ArkWeb_WebMessagePtr, void *);
enum ArkWeb_ErrorCode { ARKWEB_SUCCESS, ARKWEB_INVALID_PARAM };
enum ArkWeb_WebMessageType { ARKWEB_STRING, ARKWEB_BUFFER };
enum ArkWeb_NativeAPIVariantKind { ARKWEB_NATIVE_CONTROLLER, ARKWEB_NATIVE_WEB_MESSAGE_PORT, ARKWEB_NATIVE_WEB_MESSAGE };
struct ArkWeb_AnyNativeAPI { size_t size; };
struct ArkWeb_ControllerAPI {
 size_t size;
 ArkWeb_WebMessagePortPtr *(*createWebMessagePorts)(const char *, size_t *);
 void (*destroyWebMessagePorts)(ArkWeb_WebMessagePortPtr **, size_t);
 ArkWeb_ErrorCode (*postWebMessage)(const char *, const char *, ArkWeb_WebMessagePortPtr *, size_t, const char *);
};
struct ArkWeb_WebMessagePortAPI {
 size_t size;
 ArkWeb_ErrorCode (*postMessage)(const ArkWeb_WebMessagePortPtr, const char *, const ArkWeb_WebMessagePtr);
 void (*close)(const ArkWeb_WebMessagePortPtr, const char *);
 void (*setMessageEventHandler)(const ArkWeb_WebMessagePortPtr, const char *, ArkWeb_OnMessageEventHandler, void *);
};
struct ArkWeb_WebMessageAPI {
 size_t size;
 ArkWeb_WebMessagePtr (*createWebMessage)();
 void (*destroyWebMessage)(ArkWeb_WebMessagePtr *);
 void (*setType)(ArkWeb_WebMessagePtr, ArkWeb_WebMessageType);
 ArkWeb_WebMessageType (*getType)(ArkWeb_WebMessagePtr);
 void (*setData)(ArkWeb_WebMessagePtr, void *, size_t);
 void *(*getData)(ArkWeb_WebMessagePtr, size_t *);
};
#define ARKWEB_MEMBER_MISSING(api, member) ((api)->size < offsetof(std::remove_pointer_t<decltype(api)>, member) + sizeof((api)->member) || !(api)->member)
extern "C" ArkWeb_AnyNativeAPI *OH_ArkWeb_GetNativeAPI(ArkWeb_NativeAPIVariantKind);
