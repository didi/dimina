package com.didi.dimina.engine.qjs

/**
 * Class representing a JavaScript value
 */
class JSValue private constructor(
    val type: Type,
    val stringValue: String? = null,
    val numberValue: Double = 0.0,
    val booleanValue: Boolean = false,
    val errorMessage: String? = null,
    val objectValue: Any? = null,
) {
    enum class Type {
        STRING,
        NUMBER,
        BOOLEAN,
        NULL,
        UNDEFINED,
        OBJECT,
        ERROR,
        NATIVE
    }

    companion object {
        @JvmStatic
        fun createString(value: String): JSValue {
            return JSValue(Type.STRING, stringValue = value)
        }

        @JvmStatic
        fun createNumber(value: Double): JSValue {
            return JSValue(Type.NUMBER, numberValue = value)
        }

        @JvmStatic
        fun createBoolean(value: Boolean): JSValue {
            return JSValue(Type.BOOLEAN, booleanValue = value)
        }

        @JvmStatic
        fun createNull(): JSValue {
            return JSValue(Type.NULL)
        }

        @JvmStatic
        fun createUndefined(): JSValue {
            return JSValue(Type.UNDEFINED)
        }

        @JvmStatic
        fun createObject(stringRepresentation: String): JSValue {
            return JSValue(Type.OBJECT, stringValue = stringRepresentation)
        }

        @JvmStatic
        fun createNative(value: Any): JSValue = JSValue(Type.NATIVE, objectValue = value)

        @JvmStatic
        fun createError(message: String): JSValue {
            return JSValue(Type.ERROR, errorMessage = message)
        }
    }

    override fun toString(): String {
        return when (type) {
            Type.STRING -> stringValue ?: "null"
            Type.NUMBER -> numberValue.toString()
            Type.BOOLEAN -> booleanValue.toString()
            Type.NULL -> "null"
            Type.UNDEFINED -> "undefined"
            Type.OBJECT -> stringValue ?: "[object Object]"
            Type.ERROR -> "Error: $errorMessage"
            Type.NATIVE -> "[native value]"
        }
    }
}
