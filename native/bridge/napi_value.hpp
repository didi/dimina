#pragma once
#include "bridge_value.hpp"
#include "napi/native_api.h"
#include <cstring>

namespace dimina::bridge {
inline void checkNAPI(napi_status status) {
    if (status != napi_ok) throw std::runtime_error("N-API bridge conversion failed");
}
inline std::u16string napiString(napi_env env, napi_value input) {
    size_t size;
    checkNAPI(napi_get_value_string_utf16(env, input, nullptr, 0, &size));
    std::vector<char16_t> chars(size + 1);
    checkNAPI(napi_get_value_string_utf16(env, input, chars.data(), chars.size(), &size));
    return std::u16string(chars.data(), size);
}
inline Value fromNAPI(napi_env env, napi_value input, unsigned depth = 0) {
    checkDepth(depth);
    Value value;
    napi_valuetype type;
    checkNAPI(napi_typeof(env, input, &type));
    if (type == napi_undefined) return value;
    if (type == napi_null) value.kind = Value::Null;
    else if (type == napi_boolean) { value.kind = Value::Boolean; checkNAPI(napi_get_value_bool(env, input, &value.boolean)); }
    else if (type == napi_number) { value.kind = Value::Number; checkNAPI(napi_get_value_double(env, input, &value.number)); }
    else if (type == napi_string) { value.kind = Value::String; value.string = napiString(env, input); }
    else if (type == napi_object) {
        bool binary = false, array = false;
        checkNAPI(napi_is_arraybuffer(env, input, &binary));
        if (binary) {
            value.kind = Value::Bytes;
            void *bytes; size_t length;
            checkNAPI(napi_get_arraybuffer_info(env, input, &bytes, &length));
            if (length) value.bytes.assign(static_cast<uint8_t *>(bytes), static_cast<uint8_t *>(bytes) + length);
            return value;
        }
        // File results can contain DMPMap wrappers. Honor their public toJSON
        // conversion before enumerating, as the existing JSON bridge does.
        napi_value toJSON;
        checkNAPI(napi_get_named_property(env, input, "toJSON", &toJSON));
        napi_valuetype methodType;
        checkNAPI(napi_typeof(env, toJSON, &methodType));
        if (methodType == napi_function) {
            napi_value plain;
            checkNAPI(napi_call_function(env, input, toJSON, 0, nullptr, &plain));
            return fromNAPI(env, plain, depth + 1);
        }
        checkNAPI(napi_is_array(env, input, &array));
        value.kind = array ? Value::Array : Value::Object;
        napi_value keys;
        uint32_t count;
        if (array) checkNAPI(napi_get_array_length(env, input, &count));
        else { checkNAPI(napi_get_property_names(env, input, &keys)); checkNAPI(napi_get_array_length(env, keys, &count)); }
        for (uint32_t i = 0; i < count; ++i) {
            napi_handle_scope scope;
            checkNAPI(napi_open_handle_scope(env, &scope));
            try {
                napi_value item, key;
                if (array) {
                    checkNAPI(napi_get_element(env, input, i, &item));
                    value.array.push_back(fromNAPI(env, item, depth + 1));
                } else {
                    checkNAPI(napi_get_element(env, keys, i, &key));
                    bool own;
                    checkNAPI(napi_has_own_property(env, input, key, &own));
                    if (own) {
                        checkNAPI(napi_get_property(env, input, key, &item));
                        value.object.emplace_back(napiString(env, key), fromNAPI(env, item, depth + 1));
                    }
                }
            } catch (...) { napi_close_handle_scope(env, scope); throw; }
            napi_close_handle_scope(env, scope);
        }
    } else throw std::runtime_error("unsupported N-API bridge value");
    return value;
}
inline napi_value toNAPI(napi_env env, const Value &value) {
    napi_value result;
    switch (value.kind) {
    case Value::Undefined: checkNAPI(napi_get_undefined(env, &result)); break;
    case Value::Null: checkNAPI(napi_get_null(env, &result)); break;
    case Value::Boolean: checkNAPI(napi_get_boolean(env, value.boolean, &result)); break;
    case Value::Number: checkNAPI(napi_create_double(env, value.number, &result)); break;
    case Value::String: checkNAPI(napi_create_string_utf16(env, value.string.data(), value.string.size(), &result)); break;
    case Value::Bytes: {
        void *bytes;
        checkNAPI(napi_create_arraybuffer(env, value.bytes.size(), &bytes, &result));
        if (!value.bytes.empty()) memcpy(bytes, value.bytes.data(), value.bytes.size());
        break;
    }
    case Value::Array:
    case Value::Object: {
        if (value.kind == Value::Array) checkNAPI(napi_create_array_with_length(env, value.array.size(), &result));
        else checkNAPI(napi_create_object(env, &result));
        size_t count = value.kind == Value::Array ? value.array.size() : value.object.size();
        for (size_t i = 0; i < count; ++i) {
            napi_handle_scope scope;
            checkNAPI(napi_open_handle_scope(env, &scope));
            try {
                if (value.kind == Value::Array) checkNAPI(napi_set_element(env, result, i, toNAPI(env, value.array[i])));
                else {
                    const auto &entry = value.object[i];
                    napi_value key;
                    checkNAPI(napi_create_string_utf16(env, entry.first.data(), entry.first.size(), &key));
                    napi_property_descriptor property{};
                    property.name = key; property.value = toNAPI(env, entry.second);
                    property.attributes = static_cast<napi_property_attributes>(napi_writable | napi_enumerable | napi_configurable);
                    checkNAPI(napi_define_properties(env, result, 1, &property));
                }
            } catch (...) { napi_close_handle_scope(env, scope); throw; }
            checkNAPI(napi_close_handle_scope(env, scope));
        }
        break;
    }
    }
    return result;
}
}
