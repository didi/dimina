

#include "utils.h"
#include <hilog/log.h>
#include <unistd.h>
#include <thread>
#include <sys/syscall.h>
#include <sstream>

using namespace std;


#pragma 类型转换 Jsvalue 转 Napi
// 将 QuickJS 对象转换为 N-API 对象
napi_value ConvertJSObjectToNapiObject(napi_env env, JSContext *ctx, JSValueConst jsValue) {
    napi_value result;
    napi_create_object(env, &result);

    JSPropertyEnum *props;
    uint32_t propCount;
    JS_GetOwnPropertyNames(ctx, &props, &propCount, jsValue, JS_GPN_STRING_MASK | JS_GPN_SYMBOL_MASK);

    for (uint32_t i = 0; i < propCount; ++i) {
        const char *propName = JS_AtomToCString(ctx, props[i].atom);

        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "ConvertJSObjectToNapiObject propName: %{public}s",
                     propName);


        JSValueConst propValue;
        propValue = JS_GetProperty(ctx, jsValue, props[i].atom);

        napi_value napiPropValue = ConvertJSValueToNapiValue(env, ctx, propValue);

        napi_set_named_property(env, result, propName, napiPropValue);

        JS_FreeCString(ctx, propName);
    }

    js_free(ctx, props);

    return result;
}

napi_value ConvertJSValueToNapiValue(napi_env env, JSContext *ctx, JSValueConst jsValue) {
    if (JS_IsUndefined(jsValue)) {
        napi_value result;
        napi_get_undefined(env, &result);
        return result;
    } else if (JS_IsNull(jsValue)) {
        napi_value result;
        napi_get_null(env, &result);
        return result;
    } else if (JS_IsBool(jsValue)) {
        bool value = JS_ToBool(ctx, jsValue);
        napi_value result;
        napi_get_boolean(env, value, &result);
        return result;
    } else if (JS_IsNumber(jsValue)) {
        // 这里特殊处理下，js 有 number 类型，Native 有 int 和 float
        int tag = JS_VALUE_GET_TAG(jsValue);
        if (tag == JS_TAG_INT) {
            int value = JS_VALUE_GET_INT(jsValue);
            napi_value result;
            napi_create_int64(env, value, &result);
            return result;
        } else if (tag == JS_TAG_FLOAT64) {
            double value = JS_VALUE_GET_FLOAT64(jsValue);
            napi_value result;
            napi_create_double(env, value, &result);
            return result;
        }
        double value = JS_VALUE_GET_FLOAT64(jsValue);
        napi_value result;
        napi_create_double(env, value, &result);
        return result;
    } else if (JS_IsString(jsValue)) {
        const char *str = JS_ToCString(ctx, jsValue);
        if (str == NULL) {
            // Handle error (e.g., throw a JavaScript error or return an error value)
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "ConvertJSValueToNapiValue JS_ToCString error");
            return NULL; // Adjust based on your error handling strategy
        }

        napi_value result;
        napi_status status = napi_create_string_utf8(env, str, NAPI_AUTO_LENGTH, &result);
        JS_FreeCString(ctx, str);

        if (status != napi_ok) {
            // Handle error for N-API function
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/",
                         "ConvertJSValueToNapiValue napi_create_string_utf8 error");
            return NULL; // Adjust based on your error handling strategy
        }

        return result;
    } else if (JS_IsObject(jsValue)) {
        if (JS_IsArray(ctx, jsValue) == 1) {
            napi_value result;
            napi_create_array(env, &result);

            uint32_t array_length;
            JSValue array_length_value = JS_GetPropertyStr(ctx, jsValue, "length");
            JS_ToUint32(ctx, &array_length, array_length_value);
            JS_FreeValue(ctx, array_length_value);

            for (uint32_t i = 0; i < array_length; ++i) {
                JSValue js_element = JS_GetPropertyUint32(ctx, jsValue, i);
                napi_value napi_element = ConvertJSValueToNapiValue(env, ctx, js_element);
                napi_set_element(env, result, i, napi_element);
                JS_FreeValue(ctx, js_element);
            }
            return result;
        } else {
            napi_value result;
            napi_create_object(env, &result);

            JSPropertyEnum *props;
            uint32_t len;
            if (JS_GetOwnPropertyNames(ctx, &props, &len, jsValue, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
                for (uint32_t i = 0; i < len; ++i) {
                    const char *key = JS_AtomToCString(ctx, props[i].atom);
                    JSValue value = JS_GetProperty(ctx, jsValue, props[i].atom);
                    napi_value napiValue = ConvertJSValueToNapiValue(env, ctx, value);
                    napi_set_named_property(env, result, key, napiValue);

                    JS_FreeCString(ctx, key);
                    JS_FreeValue(ctx, value);
                }
                js_free(ctx, props);
            }
            return result;
        }
    } else {
        return NULL;
    }
}

#pragma 类型转换 Napi 转 Jsvalue
JSValue ConvertNapiObjectToJSObject(napi_env env, JSContext *ctx, napi_value napiObject) {
    JSValue jsObject = JS_NewObject(ctx);

    napi_status status;
    // 获取对象的属性名数组
    napi_value propNames;


    checkType(env, napiObject, "ConvertNapiObjectToJSObject napiObject");

    //     napi_get_all_property_names(env, napiObject, napi_key_own_only, napi_key_all_properties,
    //     napi_key_keep_numbers,
    //                                 &propNames);
    status = napi_get_property_names(env, napiObject, &propNames);
    if (status != napi_ok) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/",
                     "ConvertNapiObjectToJSObject napi_get_property_names error");
    }

    checkType(env, propNames, "ConvertNapiObjectToJSObject propNames");


    uint32_t propCount;
    status = napi_get_array_length(env, propNames, &propCount);
    if (status != napi_ok) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "ConvertNapiObjectToJSObject napi_get_array_length error");
    }


    for (uint32_t i = 0; i < propCount; i++) {
        // 获取属性名
        napi_value propName;
        status = napi_get_element(env, propNames, i, &propName);
        if (status != napi_ok) {
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "napi_get_element napi_get_element error");
        }

        // 定义一个指针来存储字符串结果
        char *propChar = NULL;
        // 调用转换函数
        propChar = getStringFromNapi(env, propName);

        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "ConvertNapiObjectToJSObject propChar: %{public}s",
                     propChar);

        // 获取属性值
        napi_value propValue;
        napi_get_property(env, napiObject, propName, &propValue);


        // 递归处理属性值
        JSValue jsPropValue = ConvertNapiValueToJsValue(env, ctx, propValue);

        // 将属性名和属性值添加到 QuickJS 对象中
        JSAtom atom = JS_NewAtom(ctx, propChar);
        JS_SetProperty(ctx, jsObject, atom, jsPropValue);

        // 释放引用
        JS_FreeAtom(ctx, atom);

        //         napi_delete_reference(env, propName);
        //         napi_delete_reference(env, propValue);
    }

    // 释放属性名数组
    //     napi_delete_reference(env, propNames);

    return jsObject;
}

JSValue ConvertNapiValueToJsValue(napi_env env, JSContext *ctx, napi_value napiValue) {
    JSValue jsValue = JS_UNDEFINED;

    // 获取 NAPI 对象类型
    napi_valuetype valueType;
    napi_status status = napi_typeof(env, napiValue, &valueType);
    if (status != napi_ok) {
        return JS_EXCEPTION; // 统一错误处理
    }

    switch (valueType) {
    case napi_undefined:
        jsValue = JS_UNDEFINED;
        break;
    case napi_null:
        jsValue = JS_NULL;
        break;
    case napi_boolean: {
        bool boolValue;
        status = napi_get_value_bool(env, napiValue, &boolValue);
        if (status != napi_ok) {
            return JS_EXCEPTION;
        }
        jsValue = JS_NewBool(ctx, boolValue);
        break;
    }
    case napi_number: {
        double numberValue;
        status = napi_get_value_double(env, napiValue, &numberValue);
        if (status != napi_ok) {
            return JS_EXCEPTION;
        }
        jsValue = JS_NewFloat64(ctx, numberValue);
        break;
    }
    case napi_string: {
        size_t strLen;
        status = napi_get_value_string_utf8(env, napiValue, NULL, 0, &strLen);
        if (status != napi_ok) {
            return JS_EXCEPTION;
        }

        char *strBuf = (char *)malloc(strLen + 1);
        if (!strBuf) {
            return JS_EXCEPTION; // 处理内存分配失败
        }

        status = napi_get_value_string_utf8(env, napiValue, strBuf, strLen + 1, &strLen);
        if (status != napi_ok) {
            free(strBuf);
            return JS_EXCEPTION;
        }
        jsValue = JS_NewStringLen(ctx, strBuf, strLen);
        free(strBuf);
        break;
    }
    case napi_object: {
        bool isArray;
        status = napi_is_array(env, napiValue, &isArray);
        if (status != napi_ok) {
            return JS_EXCEPTION;
        }

        if (isArray) {
            uint32_t length;
            napi_get_array_length(env, napiValue, &length);
            JSValue jsArray = JS_NewArray(ctx);

            for (uint32_t i = 0; i < length; i++) {
                napi_value element;
                napi_get_element(env, napiValue, i, &element);
                JSValue jsElement = ConvertNapiValueToJsValue(env, ctx, element);
                if (JS_IsException(jsElement)) { // 检查子元素是否转换失败
                    JS_FreeValue(ctx, jsArray);
                    return JS_EXCEPTION;
                }
                JS_SetPropertyUint32(ctx, jsArray, i, jsElement);
            }
            jsValue = jsArray;
        } else {
            jsValue = JS_NewObject(ctx);

            napi_status status;
            napi_value propNames;

            status = napi_get_property_names(env, napiValue, &propNames);
            if (status != napi_ok) {
                OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/",
                             "ConvertNapiValueToJsValue napi_get_property_names error");
            }

            uint32_t propCount;
            status = napi_get_array_length(env, propNames, &propCount);


            for (uint32_t i = 0; i < propCount; i++) {
                napi_value value;
                // 获取属性名
                napi_value propName;
                status = napi_get_element(env, propNames, i, &propName);
                if (status != napi_ok) {
                    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/",
                                 "ConvertNapiValueToJsValue napi_get_element error");
                }

                // 定义一个指针来存储字符串结果
                char *propChar = NULL;
                // 调用转换函数
                propChar = getStringFromNapi(env, propName);

                // 获取属性值
                napi_value propValue;
                napi_get_property(env, napiValue, propName, &propValue);

                JSValue jsPropValue = ConvertNapiValueToJsValue(env, ctx, propValue);
                // 假设 properties[i] 已正确转换为字符串
                JS_SetPropertyStr(ctx, jsValue, propChar, jsPropValue);
            }
        }
        break;
    }

    default:
        jsValue = JS_NULL; // 未支持的类型处理
        break;
    }

    return jsValue;
}

napi_value createNapiString(napi_env env, string str) {
    napi_value result;
    char *strChar = (char *)str.c_str();
    napi_create_string_utf8(env, strChar, str.length(), &result);
    return result;
}

napi_value createNapiInt(napi_env env, int64_t value) {
    napi_value result;
    napi_create_int64(env, value, &result);
    return result;
}

char *getStringFromNapi(napi_env env, napi_value value) {
    size_t length;
    napi_status status = napi_get_value_string_utf8(env, value, NULL, 0, &length);
    char *result;

    if (status != napi_ok) {
        // 错误处理，返回NULL或空字符串，这里选择返回NULL
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "napi_get_value_string_utf8 1 error");
        return NULL;
    }

    // 分配足够的内存来存储字符串（包括 null 结尾）
    result = (char *)malloc(length + 1);
    if (result == NULL) {
        // 内存分配失败的错误处理
        return NULL;
    }

    // 获取字符串值
    status = napi_get_value_string_utf8(env, value, result, length + 1, &length);

    if (status != napi_ok) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "napi_get_value_string_utf8 2 error");
        // 错误处理，释放已分配的内存
        free(result);
        return NULL;
    }

    return result; // 返回字符串
}


bool endsWithSync(const char *str) {
    // 计算字符串长度
    size_t strLen = std::strlen(str);
    // 计算后缀长度
    size_t suffixLen = 4; // "sync" 的长度

    // 如果字符串长度小于后缀长度，则不可能以后缀结尾
    if (strLen < suffixLen) {
        return false;
    }

    // 比较字符串末尾的后缀部分是否与 "sync" 相等
    return strcmp(str + (strLen - suffixLen), "Sync") == 0;
}

void checkType(napi_env env, napi_value value, const char *tag) {
    napi_status status;
    napi_valuetype val_type;

    status = napi_typeof(env, value, &val_type);
    if (status != napi_ok) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "napi_get_element napi_typeof error");
    }

    switch (val_type) {
    case napi_undefined:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is undefined", tag);
        break;
    case napi_null:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is null", tag);
        break;
    case napi_boolean:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is boolean", tag);
        break;
    case napi_number:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is number", tag);
        break;
    case napi_string:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is string", tag);
        break;
    case napi_symbol:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is symbol", tag);
        break;
    case napi_object:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is object", tag);
        break;
    case napi_function:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is function", tag);
        break;
    case napi_external:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is external", tag);
        break;
    case napi_bigint:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Type is bigint", tag);
        break;
    default:
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s: Unknown type", tag);
    }
}
// Helper function to print indent as string
std::string getIndentString(int indentLevel) { return std::string(indentLevel * 2, ' '); }

// Helper function to get the string representation of napi_value
std::string getNapiValueString(napi_env env, napi_value value, int indentLevel) {
    std::string output;
    std::string indent = getIndentString(indentLevel);
    std::string nextIndent = getIndentString(indentLevel + 1);

    napi_status status;
    napi_valuetype val_type;
    status = napi_typeof(env, value, &val_type);
    if (status != napi_ok) {
        return indent + "Error getting value type";
    }

    switch (val_type) {
    case napi_undefined:
        output = "undefined";
        break;
    case napi_null:
        output = "null";
        break;
    case napi_boolean: {
        bool boolValue;
        status = napi_get_value_bool(env, value, &boolValue);
        if (status != napi_ok) {
            return indent + "Error getting boolean value";
        }
        output = boolValue ? "true" : "false";
        break;
    }
    case napi_number: {
        double numberValue;
        status = napi_get_value_double(env, value, &numberValue);
        if (status != napi_ok) {
            return indent + "Error getting number value";
        }
        output = std::to_string(numberValue);
        break;
    }
    case napi_string: {
        char *str = getStringFromNapi(env, value);
        if (str) {
            output = "\"" + std::string(str) + "\"";
            free(str); // 释放已分配的内存
        } else {
            output = "Error getting string value";
        }
        break;
    }
    case napi_symbol:
        output = "Symbol";
        break;
    case napi_object: {
        bool isArray;
        status = napi_is_array(env, value, &isArray);
        if (status != napi_ok) {
            return indent + "Error checking if value is array";
        }
        if (isArray) {
            // 处理数组
            output = "[\n";
            uint32_t length;
            status = napi_get_array_length(env, value, &length);
            if (status != napi_ok) {
                return indent + "Error getting array length";
            }
            for (uint32_t i = 0; i < length; i++) {
                napi_value element;
                status = napi_get_element(env, value, i, &element);
                if (status != napi_ok) {
                    return indent + "Error getting array element";
                }
                output += nextIndent + getNapiValueString(env, element, indentLevel + 1);
                if (i < length - 1) {
                    output += ",";
                }
                output += "\n";
            }
            output += indent + "]";
        } else {
            // 处理对象
            output = "{\n";
            napi_value propNames;
            status = napi_get_property_names(env, value, &propNames);
            if (status != napi_ok) {
                return indent + "Error getting property names";
            }

            uint32_t propCount;
            status = napi_get_array_length(env, propNames, &propCount);
            if (status != napi_ok) {
                return indent + "Error getting property count";
            }

            for (uint32_t i = 0; i < propCount; i++) {
                // 获取属性名
                napi_value propName;
                status = napi_get_element(env, propNames, i, &propName);
                if (status != napi_ok) {
                    return indent + "Error getting property name";
                }
                char *keyStr = getStringFromNapi(env, propName);
                if (!keyStr) {
                    return indent + "Error converting property name to string";
                }

                // 获取属性值
                napi_value propValue;
                status = napi_get_property(env, value, propName, &propValue);
                if (status != napi_ok) {
                    free(keyStr); // 在返回前释放内存
                    return indent + "Error getting property value";
                }

                // 构建键值对字符串
                output += nextIndent + "\"" + std::string(keyStr) + "\": ";
                output += getNapiValueString(env, propValue, indentLevel + 1);

                free(keyStr); // 使用完后释放内存

                if (i < propCount - 1) {
                    output += ",";
                }
                output += "\n";
            }
            output += indent + "}";
        }
        break;
    }
    case napi_function:
        output = "Function";
        break;
    case napi_external:
        output = "External";
        break;
    case napi_bigint:
        output = "BigInt";
        break;
    default:
        output = "Unknown type";
        break;
    }

    return output;
}

void printNapiValue(napi_env env, napi_value value, int indentLevel) {
    if (indentLevel == 0) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "printNapiValue");
    }

    std::string indent = getIndentString(indentLevel);
    std::string output = getNapiValueString(env, value, indentLevel);

    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s%{public}s", indent.c_str(), output.c_str());
}

std::string getJsValueString(JSContext *ctx, JSValueConst jsValue, int indentLevel) {
    std::string output;
    std::string indent = getIndentString(indentLevel);
    std::string nextIndent = getIndentString(indentLevel + 1);

    if (JS_IsUndefined(jsValue)) {
        output = "undefined";
    } else if (JS_IsNull(jsValue)) {
        output = "null";
    } else if (JS_IsBool(jsValue)) {
        output = JS_ToBool(ctx, jsValue) ? "true" : "false";
    } else if (JS_IsNumber(jsValue)) {
        int tag = JS_VALUE_GET_TAG(jsValue);
        if (tag == JS_TAG_INT) {
            int value = jsValue.u.int32;
            output = std::to_string(value);
        } else if (tag == JS_TAG_FLOAT64) {
            double num;
            JS_ToFloat64(ctx, &num, jsValue);
            output = std::to_string(num);
        }
    } else if (JS_IsString(jsValue)) {
        const char *str = JS_ToCString(ctx, jsValue);
        if (str) {
            output = "\"" + std::string(str) + "\"";
            JS_FreeCString(ctx, str);
        }
    } else if (JS_IsObject(jsValue)) {
        if (JS_IsArray(ctx, jsValue) == 1) {
            // 处理数组
            output = "[\n";
            uint32_t length;
            JSValue lengthValue = JS_GetPropertyStr(ctx, jsValue, "length");
            JS_ToUint32(ctx, &length, lengthValue);
            JS_FreeValue(ctx, lengthValue);

            for (uint32_t i = 0; i < length; ++i) {
                JSValue val = JS_GetPropertyUint32(ctx, jsValue, i);
                output += nextIndent;
                output += getJsValueString(ctx, val, indentLevel + 1);
                JS_FreeValue(ctx, val);

                if (i < length - 1) {
                    output += ",";
                }
                output += "\n";
            }
            output += indent + "]";
        } else {
            // 处理对象
            output = "{\n";
            JSPropertyEnum *tab;
            uint32_t len;
            if (JS_GetOwnPropertyNames(ctx, &tab, &len, jsValue, JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
                for (uint32_t i = 0; i < len; ++i) {
                    const char *key = JS_AtomToCString(ctx, tab[i].atom);
                    JSValue val = JS_GetProperty(ctx, jsValue, tab[i].atom);
                    output += nextIndent + "\"" + key + "\": ";
                    output += getJsValueString(ctx, val, indentLevel + 1);
                    JS_FreeCString(ctx, key);
                    JS_FreeValue(ctx, val);

                    if (i < len - 1) {
                        output += ",";
                    }
                    output += "\n";
                }
                js_free(ctx, tab);
            }
            output += indent + "}";
        }
    } else {
        output = "Unknown JS value type";
    }

    return output;
}

void printJsValue(JSContext *ctx, JSValueConst jsValue, int indentLevel) {
    if (indentLevel == 0) {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "printJsValue");
    }

    std::string indent = getIndentString(indentLevel);
    std::string output = getJsValueString(ctx, jsValue, indentLevel);
    OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "%{public}s%{public}s", indent.c_str(), output.c_str());
}

char *JSValueToString(JSContext *ctx, JSValueConst val) {
    const char *cstr;
    char *result;
    if (JS_IsString(val)) {
        cstr = JS_ToCString(ctx, val);
        if (!cstr)
            return NULL;
        result = strdup(cstr);
        JS_FreeCString(ctx, cstr);
        return result;
    } else {
        JSValue strVal = JS_JSONStringify(ctx, val, JS_UNDEFINED, JS_UNDEFINED);
        if (JS_IsException(strVal)) {
            JS_FreeValue(ctx, strVal);
            return NULL;
        }
        cstr = JS_ToCString(ctx, strVal);
        JS_FreeValue(ctx, strVal); // 现在可以安全地释放 strVal
        if (!cstr)
            return NULL;
        result = strdup(cstr);
        JS_FreeCString(ctx, cstr);
        return result;
    }
}

void printFuncName(JSContext *ctx, JSValueConst funcObj) {
    if (JS_IsFunction(ctx, funcObj)) {
        JSValue name_value = JS_GetPropertyStr(ctx, funcObj, "name");
        if (JS_IsException(name_value)) {
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "Failed to get function name.");
        } else if (JS_IsUndefined(name_value) || JS_IsNull(name_value)) {
            OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "Function name is undefined or null.");
        } else {
            // 转换 JSValue 为 C 字符串
            const char *name_str = JS_ToCString(ctx, name_value);
            if (name_str) {
                OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "func name: %{public}s", name_str);
                JS_FreeCString(ctx, name_str); // 释放字符串
            }
        }
        JS_FreeValue(ctx, name_value);
    } else {
        OH_LOG_Print(LOG_APP, LOG_ERROR, 0x8989, "dimina/", "Provided JSValue is not a function.");
    }
}


// 复制对象的函数
napi_status CopyObject(napi_env env, napi_value source, napi_value *destination) {
    // 获取源对象的属性名
    napi_value propertyNames;
    napi_get_property_names(env, source, &propertyNames);

    // 创建新对象
    napi_create_object(env, destination);

    // 复制每个属性到新对象
    uint32_t length;
    napi_get_array_length(env, propertyNames, &length);

    for (uint32_t i = 0; i < length; ++i) {
        // 获取属性名
        napi_value propertyName;
        napi_get_element(env, propertyNames, i, &propertyName);

        // 获取属性值
        napi_value propertyValue;
        napi_get_property(env, source, propertyName, &propertyValue);

        // 设置属性值到新对象
        napi_set_property(env, *destination, propertyName, propertyValue);
    }

    return napi_ok;
}


bool isMainThread() {
    pid_t pid = getpid();
    pid_t tid = syscall(SYS_gettid);
    if (pid == tid) {
        return true;
    } else {
        return false;
    }
}
