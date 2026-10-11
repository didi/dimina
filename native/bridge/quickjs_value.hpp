#pragma once
#include "bridge_value.hpp"
#include "quickjs.h"

namespace dimina::bridge {
struct OwnedJSValue {
    JSContext *ctx;
    JSValue value;
    OwnedJSValue(JSContext *ctx, JSValue value) : ctx(ctx), value(value) {}
    ~OwnedJSValue() { JS_FreeValue(ctx, value); }
    OwnedJSValue(const OwnedJSValue &) = delete;
};
inline std::u16string readString(JSContext *ctx, JSValueConst value) {
    size_t length;
    const char *bytes = JS_ToCStringLen2(ctx, &length, value, true);
    if (!bytes) throw std::runtime_error("cannot read bridge string");
    try {
        auto result = decodeString(bytes, length);
        JS_FreeCString(ctx, bytes);
        return result;
    } catch (...) { JS_FreeCString(ctx, bytes); throw; }
}
inline Value fromJS(JSContext *ctx, JSValueConst input, unsigned depth = 0, JSClassID bufferClass = 0) {
    checkDepth(depth);
    if (JS_IsException(input)) throw std::runtime_error("cannot read bridge value");
    if (!bufferClass) {
        // Obtain the built-in class through public APIs once per packet. Probing
        // every ordinary object with JS_GetArrayBuffer would allocate TypeErrors.
        OwnedJSValue buffer(ctx, JS_NewArrayBufferCopy(ctx, nullptr, 0));
        if (JS_IsException(buffer.value)) throw std::runtime_error("cannot inspect bridge buffer");
        bufferClass = JS_GetClassID(buffer.value);
    }
    Value value;
    if (JS_IsUndefined(input)) return value;
    if (JS_IsNull(input)) value.kind = Value::Null;
    else if (JS_IsBool(input)) { value.kind = Value::Boolean; value.boolean = JS_ToBool(ctx, input); }
    else if (JS_IsNumber(input)) { value.kind = Value::Number; JS_ToFloat64(ctx, &value.number, input); }
    else if (JS_IsString(input)) { value.kind = Value::String; value.string = readString(ctx, input); }
    else if (JS_IsObject(input)) {
        if (JS_GetClassID(input) == bufferClass) {
            size_t length = 0;
            uint8_t *bytes = JS_GetArrayBuffer(ctx, &length, input);
            if (JS_HasException(ctx)) throw std::runtime_error("cannot read bridge buffer");
            value.kind = Value::Bytes;
            if (length) value.bytes.assign(bytes, bytes + length);
            return value;
        }
        int array = JS_IsArray(ctx, input);
        if (array < 0) throw std::runtime_error("cannot read bridge array");
        if (array) {
            value.kind = Value::Array;
            OwnedJSValue size(ctx, JS_GetPropertyStr(ctx, input, "length"));
            uint32_t count;
            if (JS_ToUint32(ctx, &count, size.value) < 0) throw std::runtime_error("invalid array length");
            for (uint32_t i = 0; i < count; ++i) {
                OwnedJSValue item(ctx, JS_GetPropertyUint32(ctx, input, i));
                value.array.push_back(fromJS(ctx, item.value, depth + 1, bufferClass));
            }
        } else {
            value.kind = Value::Object;
            JSPropertyEnum *names = nullptr;
            uint32_t count = 0;
            if (JS_GetOwnPropertyNames(ctx, &names, &count, input, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0)
                throw std::runtime_error("cannot read bridge properties");
            try {
                for (uint32_t i = 0; i < count; ++i) {
                    OwnedJSValue key(ctx, JS_AtomToString(ctx, names[i].atom));
                    OwnedJSValue item(ctx, JS_GetProperty(ctx, input, names[i].atom));
                    value.object.emplace_back(readString(ctx, key.value), fromJS(ctx, item.value, depth + 1, bufferClass));
                }
            } catch (...) { JS_FreePropertyEnum(ctx, names, count); throw; }
            JS_FreePropertyEnum(ctx, names, count);
        }
    } else throw std::runtime_error("unsupported bridge value");
    return value;
}
inline JSValue toJS(JSContext *ctx, const Value &value) {
    switch (value.kind) {
    case Value::Undefined: return JS_UNDEFINED;
    case Value::Null: return JS_NULL;
    case Value::Boolean: return JS_NewBool(ctx, value.boolean);
    case Value::Number: return JS_NewFloat64(ctx, value.number);
    case Value::String: {
        auto bytes = encodeString(value.string);
        return JS_NewStringLen(ctx, bytes.data(), bytes.size());
    }
    case Value::Bytes: return JS_NewArrayBufferCopy(ctx, value.bytes.data(), value.bytes.size());
    case Value::Array:
    case Value::Object: {
        JSValue result = value.kind == Value::Array ? JS_NewArray(ctx) : JS_NewObject(ctx);
        if (JS_IsException(result)) return result;
        if (value.kind == Value::Array) {
            for (size_t i = 0; i < value.array.size(); ++i) {
                JSValue item = toJS(ctx, value.array[i]);
                if (JS_IsException(item) || JS_SetPropertyUint32(ctx, result, i, item) < 0) {
                    JS_FreeValue(ctx, result); return JS_EXCEPTION;
                }
            }
        } else {
            for (const auto &entry : value.object) {
                OwnedJSValue key(ctx, toJS(ctx, Value{Value::String, false, 0, entry.first}));
                if (JS_IsException(key.value)) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
                JSAtom atom = JS_ValueToAtom(ctx, key.value);
                if (atom == JS_ATOM_NULL) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
                JSValue item = toJS(ctx, entry.second);
                // Define an own property, including keys such as __proto__.
                int status = JS_IsException(item) ? -1 : JS_DefinePropertyValue(ctx, result, atom, item, JS_PROP_C_W_E);
                JS_FreeAtom(ctx, atom);
                if (status < 0) { JS_FreeValue(ctx, result); return JS_EXCEPTION; }
            }
        }
        return result;
    }
    }
    return JS_UNDEFINED;
}
inline JSValue deliverMessage(JSContext *ctx, const Value &value) {
    OwnedJSValue global(ctx, JS_GetGlobalObject(ctx));
    OwnedJSValue bridge(ctx, JS_GetPropertyStr(ctx, global.value, "DiminaServiceBridge"));
    if (JS_IsException(bridge.value)) return JS_EXCEPTION;
    OwnedJSValue callback(ctx, JS_GetPropertyStr(ctx, bridge.value, "onMessage"));
    if (JS_IsException(callback.value)) return JS_EXCEPTION;
    OwnedJSValue argument(ctx, toJS(ctx, value));
    if (JS_IsException(argument.value)) return JS_EXCEPTION;
    return JS_Call(ctx, callback.value, bridge.value, 1, &argument.value);
}
}
