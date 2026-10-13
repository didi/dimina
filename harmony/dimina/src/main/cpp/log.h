
// Node APIs are not fully supported. To solve the compilation error of the interface cannot be found,
// please include "napi/native_api.h".

#ifndef DIMINA_HARMONYOS_LOG_H
#define DIMINA_HARMONYOS_LOG_H

#include "napi/native_api.h"
#include "quickjs.h"
#include <hilog/log.h>


extern const char *js_engine_tag;
extern const int js_engine_domain;

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wformat"

#define PFLog(fmt, ...) OH_LOG_Print(LOG_APP, LOG_DEBUG, js_engine_domain, js_engine_tag, fmt, ##__VA_ARGS__)
#define OHError(fmt, ...) OH_LOG_Print(LOG_APP, LOG_ERROR, js_engine_domain, js_engine_tag, fmt, ##__VA_ARGS__)

//#ifdef DEBUG
#ifdef NDEBUG
#define OHLog(fmt, ...) ((void)0)
#else
#define OHLog(fmt, ...) OH_LOG_Print(LOG_APP, LOG_DEBUG, js_engine_domain, js_engine_tag, fmt, ##__VA_ARGS__)
#endif
#define OHInfo(fmt, ...) OH_LOG_Print(LOG_APP, LOG_INFO, js_engine_domain, js_engine_tag, fmt, ##__VA_ARGS__)
#define OHWarn(fmt, ...) OH_LOG_Print(LOG_APP, LOG_WARN, js_engine_domain, js_engine_tag, fmt, ##__VA_ARGS__)
//#else
//#define OHLog(fmt, ...) ((void)0)
//#define OHInfo(fmt, ...) ((void)0)
//#define OHWarn(fmt, ...) ((void)0)
//#endif

#pragma GCC diagnostic pop

extern void consoleInit(JSContext *ctx);
extern void debugLogFunc(const char * str);
extern void exceptionLogFunc(JSContext *ctx);





#endif // DIMINA_HARMONYOS_LOG_H
