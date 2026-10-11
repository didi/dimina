#pragma once
#include "bridge_value.hpp"
#include <jni.h>

namespace dimina::bridge {
struct LocalFrame {
    JNIEnv *env;
    explicit LocalFrame(JNIEnv *env) : env(env) {
        if (env->PushLocalFrame(32) < 0) throw std::runtime_error("cannot allocate JNI bridge frame");
    }
    ~LocalFrame() { env->PopLocalFrame(nullptr); }
};
inline void checkJNI(JNIEnv *env) {
    if (env->ExceptionCheck()) throw std::runtime_error("JNI bridge conversion failed");
}
inline std::u16string javaString(JNIEnv *env, jstring input) {
    const jchar *chars = env->GetStringChars(input, nullptr);
    if (!chars) throw std::runtime_error("cannot read Java string");
    try {
        std::u16string result(reinterpret_cast<const char16_t *>(chars), env->GetStringLength(input));
        env->ReleaseStringChars(input, chars);
        return result;
    } catch (...) { env->ReleaseStringChars(input, chars); throw; }
}
inline Value fromJava(JNIEnv *env, jobject input, unsigned depth = 0) {
    checkDepth(depth);
    LocalFrame frame(env);
    Value value;
    if (!input) { value.kind = Value::Null; return value; }
    auto is = [&](const char *name) { return env->IsInstanceOf(input, env->FindClass(name)); };
    if (is("[B")) {
        value.kind = Value::Bytes;
        auto bytes = static_cast<jbyteArray>(input);
        value.bytes.resize(env->GetArrayLength(bytes));
        if (!value.bytes.empty()) env->GetByteArrayRegion(bytes, 0, value.bytes.size(), reinterpret_cast<jbyte *>(value.bytes.data()));
    } else if (is("java/lang/String")) {
        value.kind = Value::String; value.string = javaString(env, static_cast<jstring>(input));
    } else if (is("java/lang/Boolean")) {
        value.kind = Value::Boolean;
        value.boolean = env->CallBooleanMethod(input, env->GetMethodID(env->FindClass("java/lang/Boolean"), "booleanValue", "()Z"));
    } else if (is("java/lang/Number")) {
        value.kind = Value::Number;
        value.number = env->CallDoubleMethod(input, env->GetMethodID(env->FindClass("java/lang/Number"), "doubleValue", "()D"));
    } else if (is("org/json/JSONArray")) {
        value.kind = Value::Array;
        jclass cls = env->FindClass("org/json/JSONArray");
        jint length = env->CallIntMethod(input, env->GetMethodID(cls, "length", "()I"));
        jmethodID get = env->GetMethodID(cls, "get", "(I)Ljava/lang/Object;");
        for (jint i = 0; i < length; ++i) {
            jobject item = env->CallObjectMethod(input, get, i);
            checkJNI(env);
            value.array.push_back(fromJava(env, item, depth + 1));
            env->DeleteLocalRef(item);
        }
    } else if (is("org/json/JSONObject")) {
        value.kind = Value::Object;
        jclass cls = env->FindClass("org/json/JSONObject");
        jobject keys = env->CallObjectMethod(input, env->GetMethodID(cls, "keys", "()Ljava/util/Iterator;"));
        jclass iterator = env->FindClass("java/util/Iterator");
        jmethodID next = env->GetMethodID(iterator, "next", "()Ljava/lang/Object;");
        jmethodID more = env->GetMethodID(iterator, "hasNext", "()Z");
        jmethodID get = env->GetMethodID(cls, "get", "(Ljava/lang/String;)Ljava/lang/Object;");
        while (env->CallBooleanMethod(keys, more)) {
            auto key = static_cast<jstring>(env->CallObjectMethod(keys, next));
            jobject item = env->CallObjectMethod(input, get, key);
            checkJNI(env);
            value.object.emplace_back(javaString(env, key), fromJava(env, item, depth + 1));
            env->DeleteLocalRef(item); env->DeleteLocalRef(key);
        }
    } else {
        jclass cls = env->FindClass("org/json/JSONObject");
        jobject null = env->GetStaticObjectField(cls, env->GetStaticFieldID(cls, "NULL", "Ljava/lang/Object;"));
        if (!env->IsSameObject(input, null)) throw std::runtime_error("unsupported Java bridge value");
        value.kind = Value::Null;
    }
    checkJNI(env);
    return value;
}
inline jobject toJava(JNIEnv *env, const Value &value) {
    // Each recursive invocation leaves exactly one local reference for its caller.
    if (env->PushLocalFrame(32) < 0) throw std::runtime_error("cannot allocate JNI bridge frame");
    jobject result = nullptr;
    try {
        switch (value.kind) {
        case Value::Undefined:
        case Value::Null: {
            jclass cls = env->FindClass("org/json/JSONObject");
            result = env->GetStaticObjectField(cls, env->GetStaticFieldID(cls, "NULL", "Ljava/lang/Object;"));
            break;
        }
        case Value::Boolean: {
            jclass cls = env->FindClass("java/lang/Boolean");
            result = env->CallStaticObjectMethod(cls, env->GetStaticMethodID(cls, "valueOf", "(Z)Ljava/lang/Boolean;"), value.boolean);
            break;
        }
        case Value::Number: {
            jclass cls = env->FindClass("java/lang/Double");
            result = env->CallStaticObjectMethod(cls, env->GetStaticMethodID(cls, "valueOf", "(D)Ljava/lang/Double;"), value.number);
            break;
        }
        case Value::String:
            result = env->NewString(reinterpret_cast<const jchar *>(value.string.data()), value.string.size()); break;
        case Value::Bytes: {
            auto bytes = env->NewByteArray(value.bytes.size());
            if (bytes && !value.bytes.empty()) env->SetByteArrayRegion(bytes, 0, value.bytes.size(), reinterpret_cast<const jbyte *>(value.bytes.data()));
            result = bytes; break;
        }
        case Value::Array:
        case Value::Object: {
            const bool array = value.kind == Value::Array;
            jclass cls = env->FindClass(array ? "org/json/JSONArray" : "org/json/JSONObject");
            result = env->NewObject(cls, env->GetMethodID(cls, "<init>", "()V"));
            jmethodID put = env->GetMethodID(cls, "put", array ? "(Ljava/lang/Object;)Lorg/json/JSONArray;" : "(Ljava/lang/String;Ljava/lang/Object;)Lorg/json/JSONObject;");
            auto append = [&](jstring key, const Value &item) {
                jobject converted = toJava(env, item);
                jobject ignored = array ? env->CallObjectMethod(result, put, converted) : env->CallObjectMethod(result, put, key, converted);
                env->DeleteLocalRef(converted); env->DeleteLocalRef(ignored); checkJNI(env);
            };
            for (const auto &item : value.array) append(nullptr, item);
            for (const auto &entry : value.object) {
                auto key = env->NewString(reinterpret_cast<const jchar *>(entry.first.data()), entry.first.size());
                append(key, entry.second); env->DeleteLocalRef(key);
            }
            break;
        }
        }
        checkJNI(env);
        return env->PopLocalFrame(result);
    } catch (...) { env->PopLocalFrame(nullptr); throw; }
}
}
