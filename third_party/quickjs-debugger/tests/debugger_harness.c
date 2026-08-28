#include "quickjs.h"
#include "quickjs-debugger.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv)
{
    const char *source = "function add(a, b) {\n"
                         "  const sum = a + b;\n"
                         "  return sum;\n"
                         "}\n"
                         "globalThis.result = add(20, 22);\n";
    JSRuntime *runtime = JS_NewRuntime();
    JSContext *context = runtime ? JS_NewContext(runtime) : NULL;
    JSValue result;
    int32_t value = 0;

    if (!context)
        return 1;
    if (argc != 2 || !js_debugger_wait_connection(context, argv[1]))
        return 2;

    result = JS_Eval(context, source, strlen(source),
                     "/__dimina__/test/main/logic.js", JS_EVAL_TYPE_GLOBAL);
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(context);
        const char *message = JS_ToCString(context, exception);
        fprintf(stderr, "%s\n", message ? message : "JavaScript exception");
        JS_FreeCString(context, message);
        JS_FreeValue(context, exception);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        return 3;
    }
    JS_FreeValue(context, result);

    JSValue global = JS_GetGlobalObject(context);
    result = JS_GetPropertyStr(context, global, "result");
    JS_FreeValue(context, global);
    JS_ToInt32(context, &value, result);
    JS_FreeValue(context, result);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return value == 42 ? 0 : 4;
}
