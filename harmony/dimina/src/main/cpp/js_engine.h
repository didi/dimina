//
// Created on 2024/10/28.
//
// Node APIs are not fully supported. To solve the compilation error of the interface cannot be found,
// please include "napi/native_api.h".

#ifndef DIMINA_HARMONYOS_JS_ENGINE_H
#define DIMINA_HARMONYOS_JS_ENGINE_H

#include "js_core.h"
#include "quickjs.h"
#include "napi/native_api.h"
#include <string>

class JSEngine {
public:
    JSEngine();
    JSEngine(int idx, std::function<void(JSContext *ctx)> registerFunc, const std::string &debuggerAddress);
    ~JSEngine();

    bool executeJavaScript(const std::string &code, const std::string &sourceUrl);
    void destroyEngine();
    
    std::function<void(JSContext *ctx)> registerFunc;
    
    JSContext* getContext() {
        return core->getContext();
    };
    
    int getAppIndex() {
        return index;
    };
    
    bool closing = false;
    
    bool isCoreClosing() {
        return core->closing;
    };
    
private:
    int index;
    JSCore *core = nullptr;
    std::string debuggerAddress;
};

#endif // DIMINA_HARMONYOS_JS_ENGINE_H
