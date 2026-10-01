#include "js_value.hpp"
#include "wasm_c_api.h"
#include <limits>
#include <map>
#include <mutex>
#include <unordered_map>

extern "C" {
bool dimina_wamr_grow(wasm_memory_t *, uint32_t);
uint32_t dimina_wamr_func_index(const wasm_func_t *);
wasm_func_t *dimina_wamr_func_at(wasm_instance_t *, uint32_t);
int64_t dimina_wamr_table_get(wasm_table_t *, uint32_t);
}
namespace dimina_wasm {
struct Module {
  wasm_store_t *store = nullptr;
  wasm_module_t *module = nullptr;
  ~Module() {
    if (store)
      wasm_store_delete(store);
  }
};
struct State;
struct Instance;
struct Import {
  State *state;
  Instance *instance;
  Value callback;
  std::vector<wasm_valkind_t> resultTypes;
  Import(State *s, Instance *i, const Value &v)
      : state(s), instance(i), callback(v) {}
};
struct Buffer {
  std::unique_ptr<Value> value;
  uint8_t *base = nullptr;
  size_t size = 0;
};
struct Instance {
  std::shared_ptr<Module> module;
  wasm_instance_t *instance = nullptr;
  wasm_extern_vec_t exports{};
  wasm_extern_vec_t imports{};
  std::vector<std::unique_ptr<Import>> callbacks;
  std::map<uint32_t, wasm_func_t *> functions;
  std::map<uint32_t, Buffer> buffers;
  ~Instance() {
    for (auto &item : functions)
      wasm_func_delete(item.second);
    wasm_extern_vec_delete(&exports);
    wasm_extern_vec_delete(&imports);
  }
};
static wasm_engine_t *engine() {
  static wasm_engine_t *value = wasm_engine_new();
  return value;
}
static std::string name(const wasm_name_t *s) {
  size_t size = s->num_elems;
  while (size && s->data[size - 1] == 0)
    --size;
  return std::string(s->data, size);
}
static const char *kind(wasm_externkind_t k) {
  switch (k) {
  case WASM_EXTERN_FUNC:
    return "function";
  case WASM_EXTERN_MEMORY:
    return "memory";
  case WASM_EXTERN_TABLE:
    return "table";
  case WASM_EXTERN_GLOBAL:
    return "global";
  default:
    return "unknown";
  }
}
struct State {
  VM vm;
  uint32_t next = 1;
  std::unordered_map<uint32_t, std::shared_ptr<Module>> modules;
  std::unordered_map<uint32_t, std::unique_ptr<Instance>> instances;
  std::unique_ptr<Value> pending;
  std::unique_ptr<Value> detachIntrinsic;
  std::unique_ptr<Value> protectBuffer;
#ifdef DIMINA_WASM_JSC
  std::unique_ptr<Value> snapshotBytes;
#endif
  explicit State(DiminaWasmContext c) : vm{c} {
    // Installed before any Service or business code runs in this realm. Keep
    // the original transfer and registry private: ordinary no-copy buffers
    // have no public engine API for WebAssembly's non-transferable detach key.
    auto intrinsics = vm.evaluate(R"JS((() => {
      const owned = new WeakSet();
      const apply = Reflect.apply;
      const has = WeakSet.prototype.has;
      const add = WeakSet.prototype.add;
      const TypeErrorCtor = TypeError;
      const BufferCtor = ArrayBuffer;
      const Uint8ArrayCtor = Uint8Array;
      const setBytes = Uint8Array.prototype.set;
      const prototype = ArrayBuffer.prototype;
      const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get;
      const transfer = prototype.transfer;
      for (const name of ['transfer', 'transferToFixedLength']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor || typeof descriptor.value !== 'function') continue;
        const original = descriptor.value;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: function (...args) {
            if (apply(has, owned, [this]))
              throw new TypeErrorCtor('WebAssembly memory buffers cannot be transferred');
            return apply(original, this, args);
          }
        });
      }
      return {
        protect(buffer) { apply(add, owned, [buffer]); },
        snapshot(buffer) {
          const copy = new BufferCtor(apply(byteLength, buffer, []));
          apply(setBytes, new Uint8ArrayCtor(copy), [new Uint8ArrayCtor(buffer)]);
          return copy;
        },
        transfer
      };
    })())JS");
    protectBuffer = std::make_unique<Value>(vm.get(intrinsics, "protect"));
    detachIntrinsic = std::make_unique<Value>(vm.get(intrinsics, "transfer"));
#ifdef DIMINA_WASM_JSC
    snapshotBytes = std::make_unique<Value>(vm.get(intrinsics, "snapshot"));
#endif
  }
  uint32_t index(const Value &value) {
    double n = vm.numeric(value);
    if (!std::isfinite(n) || n < 0 || n > UINT32_MAX || n != std::floor(n))
      vm.error("RangeError", "Invalid WebAssembly index");
    return static_cast<uint32_t>(n);
  }
  Module &module(uint32_t id) {
    auto found = modules.find(id);
    if (found == modules.end())
      vm.error("TypeError", "Invalid WebAssembly.Module");
    return *found->second;
  }
  Instance &instance(uint32_t id) {
    auto found = instances.find(id);
    if (found == instances.end())
      vm.error("TypeError", "Invalid WebAssembly.Instance");
    return *found->second;
  }
  wasm_extern_t *external(Instance &i, uint32_t at,
                          wasm_externkind_t expected) {
    if (at >= i.exports.num_elems ||
        wasm_extern_kind(i.exports.data[at]) != expected)
      vm.error("TypeError", "Invalid WebAssembly export");
    return i.exports.data[at];
  }
  void refresh(Instance &i, bool force = false, uint32_t at = 0) {
    for (auto &item : i.buffers) {
      auto memory = wasm_extern_as_memory(i.exports.data[item.first]);
      auto &b = item.second;
      if (b.value &&
          ((force && item.first == at) ||
           reinterpret_cast<uint8_t *>(wasm_memory_data(memory)) != b.base ||
           wasm_memory_data_size(memory) != b.size)) {
        vm.detach(*b.value, detachIntrinsic.get());
        b.value.reset();
        b.base = nullptr;
        b.size = 0;
      }
    }
  }
  void dispose() {
    for (auto &entry : instances)
      for (auto &item : entry.second->buffers)
        if (item.second.value) {
          vm.detach(*item.second.value, detachIntrinsic.get());
          item.second.value.reset();
        }
    pending.reset();
    instances.clear();
    modules.clear();
  }
  Value from(const wasm_val_t &v) {
    switch (v.kind) {
    case WASM_I32:
      return vm.number(v.of.i32);
    case WASM_F32:
      return vm.number(v.of.f32);
    case WASM_F64:
      return vm.number(v.of.f64);
    case WASM_I64: {
      auto bigint = vm.get(vm.global(), "BigInt");
      return vm.call(bigint, vm.undefined(),
                     {vm.string(std::to_string(v.of.i64))});
    }
    default:
      vm.error("TypeError", "Unsupported WebAssembly value type");
    }
  }
  wasm_val_t to(const Value &v, wasm_valkind_t type) {
    wasm_val_t result{};
    result.kind = type;
    switch (type) {
    case WASM_I32:
      result.of.i32 = vm.i32(v);
      break;
    case WASM_F32:
      result.of.f32 = static_cast<float>(vm.numeric(v));
      break;
    case WASM_F64:
      result.of.f64 = vm.numeric(v);
      break;
    case WASM_I64: {
#ifdef DIMINA_WASM_JSC
      auto bigint = vm.get(vm.global(), "BigInt");
      auto asInt = vm.get(bigint, "asIntN");
      auto n = vm.call(asInt, bigint, {vm.number(64), v});
      result.of.i64 = std::stoll(vm.text(n));
#else
      if (JS_ToBigInt64(vm.ctx, &result.of.i64, v.raw))
        throw Thrown(Value(vm.ctx, JS_GetException(vm.ctx)));
#endif
      break;
    }
    default:
      vm.error("TypeError", "Unsupported WebAssembly value type");
    }
    return result;
  }
  static wasm_trap_t *import(void *env, const wasm_val_vec_t *args,
                             wasm_val_vec_t *results) {
    auto &c = *static_cast<Import *>(env);
    auto &s = *c.state;
    try {
      s.refresh(*c.instance);
      std::vector<Value> values;
      for (size_t n = 0; n < args->num_elems; n++)
        values.push_back(s.from(args->data[n]));
      auto value = s.vm.call(c.callback, s.vm.undefined(), values);
      for (size_t n = 0; n < c.resultTypes.size(); n++)
        results->data[n] =
            s.to(c.resultTypes.size() == 1 ? value
                                           : s.vm.get(value, std::to_string(n)),
                 c.resultTypes[n]);
      results->num_elems = c.resultTypes.size();
      return nullptr;
    } catch (const Thrown &e) {
      s.pending = std::make_unique<Value>(e.value);
    } catch (const std::exception &e) {
      s.pending = std::make_unique<Value>(s.vm.string(e.what()));
    }
    const char message[] = "JavaScript import threw";
    wasm_message_t text{};
    wasm_byte_vec_new(&text, sizeof(message), message);
    auto trap = wasm_trap_new(c.instance->module->store, &text);
    wasm_byte_vec_delete(&text);
    return trap;
  }
  Value reflect(Module &m, bool imports) {
    auto result = vm.array();
    if (imports) {
      wasm_importtype_vec_t types{};
      wasm_module_imports(m.module, &types);
      for (size_t n = 0; n < types.num_elems; n++) {
        auto row = vm.object();
        vm.set(row, "module",
               vm.string(name(wasm_importtype_module(types.data[n]))));
        vm.set(row, "name",
               vm.string(name(wasm_importtype_name(types.data[n]))));
        vm.set(row, "kind",
               vm.string(kind(
                   wasm_externtype_kind(wasm_importtype_type(types.data[n])))));
        vm.set(result, std::to_string(n), row);
      }
      wasm_importtype_vec_delete(&types);
    } else {
      wasm_exporttype_vec_t types{};
      wasm_module_exports(m.module, &types);
      for (size_t n = 0; n < types.num_elems; n++) {
        auto row = vm.object();
        vm.set(row, "name",
               vm.string(name(wasm_exporttype_name(types.data[n]))));
        vm.set(row, "kind",
               vm.string(kind(
                   wasm_externtype_kind(wasm_exporttype_type(types.data[n])))));
        vm.set(result, std::to_string(n), row);
      }
      wasm_exporttype_vec_delete(&types);
    }
    return result;
  }
  Value invoke(const std::vector<Value> &args) {
    auto op = vm.text(args.at(0));
    if (op == "compile" || op == "validate") {
      size_t size = 0;
#ifdef DIMINA_WASM_JSC
      // JSC's C API permanently pins/locks the buffer when exposing its bytes.
      // Read an independent snapshot so neither Wasm growth nor ordinary input
      // transfers are affected. Typed-array copying avoids ArrayBuffer species.
      auto input = vm.call(*snapshotBytes, vm.undefined(), {args.at(1)});
#else
      const auto &input = args.at(1);
#endif
      auto bytes = vm.bytes(input, size);
      if (size > UINT32_MAX)
        vm.error("RangeError", "Wasm module exceeds wasm32 limits");
      auto m = std::make_shared<Module>();
      m->store = wasm_store_new(engine());
      if (!m->store)
        vm.error("Error", "Unable to allocate Wasm store");
      wasm_byte_vec_t binary{};
      wasm_byte_vec_new(&binary, size, reinterpret_cast<char *>(bytes));
      m->module = wasm_module_new(m->store, &binary);
      wasm_byte_vec_delete(&binary);
      if (op == "validate")
        return vm.boolean(m->module != nullptr);
      if (!m->module)
        vm.error("CompileError", "Invalid or unsupported WebAssembly module");
      uint32_t id = next++;
      modules.emplace(id, m);
      return vm.number(id);
    }
    auto id = index(args.at(1));
    if (op == "imports" || op == "exports")
      return reflect(module(id), op == "imports");
    if (op == "instantiate") {
      module(id);
      auto m = modules.at(id);
      auto i = std::make_unique<Instance>();
      i->module = m;
      wasm_importtype_vec_t types{};
      wasm_module_imports(m->module, &types);
      wasm_extern_vec_new_uninitialized(&i->imports, types.num_elems);
      i->imports.num_elems = types.num_elems;
      // Zero entries make error-path cleanup safe.
      for (size_t n = 0; n < types.num_elems; n++)
        i->imports.data[n] = nullptr;
      try {
        for (size_t n = 0; n < types.num_elems; n++) {
          auto type = wasm_importtype_type(types.data[n]);
          if (wasm_externtype_kind(type) != WASM_EXTERN_FUNC)
            vm.error("LinkError",
                     "This runtime requires module-defined memory and table");
          auto callback = vm.get(args.at(2), std::to_string(n));
          if (!vm.callable(callback))
            vm.error("LinkError",
                     "WebAssembly import must be a function: " +
                         name(wasm_importtype_name(types.data[n])));
          auto c = std::make_unique<Import>(this, i.get(), callback);
          auto resultTypes =
              wasm_functype_results(wasm_externtype_as_functype_const(type));
          for (size_t r = 0; r < resultTypes->num_elems; r++)
            c->resultTypes.push_back(wasm_valtype_kind(resultTypes->data[r]));
          auto f = wasm_func_new_with_env(
              m->store, wasm_externtype_as_functype_const(type), import,
              c.get(), nullptr);
          if (!f)
            vm.error("Error", "Unable to allocate Wasm import");
          i->imports.data[n] = wasm_func_as_extern(f);
          i->callbacks.push_back(std::move(c));
        }
      } catch (...) {
        wasm_importtype_vec_delete(&types);
        throw;
      }
      wasm_importtype_vec_delete(&types);
      wasm_trap_t *trap = nullptr;
      i->instance = wasm_instance_new_with_args(
          m->store, m->module, &i->imports, &trap, 1024 * 1024, 0);
      if (!i->instance) {
        if (pending) {
          Value e(*pending);
          pending.reset();
          if (trap)
            wasm_trap_delete(trap);
          throw Thrown(e);
        }
        if (trap)
          wasm_trap_delete(trap);
        vm.error("LinkError", "Unable to instantiate WebAssembly module");
      }
      wasm_instance_exports(i->instance, &i->exports);
      uint32_t instanceId = next++;
      instances.emplace(instanceId, std::move(i));
      return vm.number(instanceId);
    }
    auto &i = instance(id);
    uint32_t at = index(args.at(2));
    if (op == "functionIndex")
      return vm.number(dimina_wamr_func_index(
          wasm_extern_as_func(external(i, at, WASM_EXTERN_FUNC))));
    if (op == "call") {
      auto it = i.functions.find(at);
      if (it == i.functions.end()) {
        auto f = dimina_wamr_func_at(i.instance, at);
        if (!f)
          vm.error("RuntimeError", "Invalid Wasm function reference");
        it = i.functions.emplace(at, f).first;
      }
      auto f = it->second;
      auto type = wasm_func_type(f);
      const auto *parameters = wasm_functype_params(type),
                 *returns = wasm_functype_results(type);
      std::vector<wasm_val_t> values(parameters->num_elems),
          results(returns->num_elems);
      try {
        for (size_t n = 0; n < parameters->num_elems; n++)
          values[n] = to(vm.get(args.at(3), std::to_string(n)),
                         wasm_valtype_kind(parameters->data[n]));
        for (size_t n = 0; n < returns->num_elems; n++)
          results[n].kind = wasm_valtype_kind(returns->data[n]);
      } catch (...) {
        wasm_functype_delete(type);
        throw;
      }
      wasm_functype_delete(type);
      wasm_val_vec_t argv{values.size(), values.data(), values.size(),
                          values.size() * sizeof(wasm_val_t), nullptr};
      wasm_val_vec_t result{results.size(), results.data(), results.size(),
                            results.size() * sizeof(wasm_val_t), nullptr};
      auto trap = wasm_func_call(f, &argv, &result);
      refresh(i);
      if (pending) {
        Value e(*pending);
        pending.reset();
        if (trap)
          wasm_trap_delete(trap);
        throw Thrown(e);
      }
      if (trap) {
        wasm_message_t message{};
        wasm_trap_message(trap, &message);
        std::string text(message.data, message.size);
        wasm_byte_vec_delete(&message);
        wasm_trap_delete(trap);
        vm.error("RuntimeError", text);
      }
      if (results.empty())
        return vm.undefined();
      if (results.size() == 1)
        return from(results[0]);
      auto array = vm.array();
      for (size_t n = 0; n < results.size(); n++)
        vm.set(array, std::to_string(n), from(results[n]));
      return array;
    }
    if (op == "buffer") {
      auto memory = wasm_extern_as_memory(external(i, at, WASM_EXTERN_MEMORY));
      refresh(i);
      auto &b = i.buffers[at];
      if (!b.value) {
        b.base = reinterpret_cast<uint8_t *>(wasm_memory_data(memory));
        b.size = wasm_memory_data_size(memory);
        auto value = vm.buffer(b.base, b.size);
        vm.call(*protectBuffer, vm.undefined(), {value});
        b.value = std::make_unique<Value>(value);
      }
      return *b.value;
    }
    if (op == "grow") {
      auto memory = wasm_extern_as_memory(external(i, at, WASM_EXTERN_MEMORY));
      auto delta = index(args.at(3));
      auto previous = wasm_memory_size(memory);
      if (!dimina_wamr_grow(memory, delta))
        vm.error("RangeError", "WebAssembly.Memory.grow exceeds memory limit");
      refresh(i, true, at);
      return vm.number(previous);
    }
    if (op == "tableSize")
      return vm.number(wasm_table_size(
          wasm_extern_as_table(external(i, at, WASM_EXTERN_TABLE))));
    if (op == "tableGet") {
      auto table = wasm_extern_as_table(external(i, at, WASM_EXTERN_TABLE));
      auto position = index(args.at(3));
      if (position >= wasm_table_size(table))
        vm.error("RangeError", "WebAssembly.Table index out of bounds");
      auto function = dimina_wamr_table_get(table, position);
      return function < 0 ? vm.null() : vm.number(function);
    }
    if (op == "globalGet") {
      wasm_val_t value{};
      wasm_global_get(
          wasm_extern_as_global(external(i, at, WASM_EXTERN_GLOBAL)), &value);
      return from(value);
    }
    if (op == "globalSet") {
      auto global = wasm_extern_as_global(external(i, at, WASM_EXTERN_GLOBAL));
      auto type = wasm_global_type(global);
      if (wasm_globaltype_mutability(type) != WASM_VAR) {
        wasm_globaltype_delete(type);
        vm.error("TypeError", "Immutable WebAssembly.Global");
      }
      auto valueType = wasm_valtype_kind(wasm_globaltype_content(type));
      wasm_globaltype_delete(type);
      auto value = to(args.at(3), valueType);
      wasm_global_set(global, &value);
      return vm.undefined();
    }
    vm.error("TypeError", "Unknown Wasm operation");
  }
};
static std::mutex statesMutex;
static std::unordered_map<DiminaWasmContext, std::unique_ptr<State>> states;
static State *find(DiminaWasmContext ctx) {
  std::lock_guard<std::mutex> lock(statesMutex);
  auto it = states.find(ctx);
  return it == states.end() ? nullptr : it->second.get();
}
#ifdef DIMINA_WASM_JSC
static JSValueRef dispatch(JSContextRef context, JSObjectRef, JSObjectRef,
                           size_t count, const JSValueRef args[],
                           JSValueRef *exception) {
  auto ctx = JSContextGetGlobalContext(context);
  auto state = find(ctx);
  if (!state)
    return JSValueMakeUndefined(ctx);
  try {
    std::vector<Value> values;
    for (size_t n = 0; n < count; n++)
      values.emplace_back(ctx, args[n]);
    return state->invoke(values).raw;
  } catch (const Thrown &e) {
    *exception = e.value.raw;
    return JSValueMakeUndefined(ctx);
  } catch (const std::exception &e) {
    *exception = state->vm.string(e.what()).raw;
    return JSValueMakeUndefined(ctx);
  }
}
#else
static JSValue dispatch(JSContext *ctx, JSValueConst, int count,
                        JSValueConst *args) {
  auto state = find(ctx);
  if (!state)
    return JS_UNDEFINED;
  try {
    std::vector<Value> values;
    for (int n = 0; n < count; n++)
      values.emplace_back(ctx, JS_DupValue(ctx, args[n]));
    auto result = state->invoke(values);
    return JS_DupValue(ctx, result.raw);
  } catch (const Thrown &e) {
    return JS_Throw(ctx, JS_DupValue(ctx, e.value.raw));
  } catch (const std::exception &e) {
    return JS_ThrowInternalError(ctx, "%s", e.what());
  }
}
#endif
} // namespace dimina_wasm
extern "C" void dimina_wasm_install(DiminaWasmContext ctx) {
  using namespace dimina_wasm;
  if (find(ctx))
    return;
#ifdef DIMINA_WASM_JSC
  VM vm{ctx};
  auto prototype = vm.get(vm.get(vm.global(), "ArrayBuffer"), "prototype");
  if (!vm.callable(vm.get(prototype, "transfer")))
    return;
#endif
  {
    std::lock_guard<std::mutex> lock(statesMutex);
    states.emplace(ctx, std::make_unique<State>(ctx));
  }
#ifdef DIMINA_WASM_JSC
  auto fn = JSObjectMakeFunctionWithCallback(ctx, String("__diminaWasm").ref,
                                             dispatch);
  JSObjectSetProperty(
      ctx, JSContextGetGlobalObject(ctx), String("__diminaWasm").ref, fn,
      kJSPropertyAttributeReadOnly | kJSPropertyAttributeDontDelete, nullptr);
#else
  auto global = JS_GetGlobalObject(ctx);
  JS_DefinePropertyValueStr(ctx, global, "__diminaWasm",
                            JS_NewCFunction(ctx, dispatch, "__diminaWasm", 4),
                            0);
  JS_FreeValue(ctx, global);
#endif
}
extern "C" void dimina_wasm_dispose(DiminaWasmContext ctx) {
  using namespace dimina_wasm;
  auto state = find(ctx);
  if (!state)
    return;
  state->dispose();
  std::lock_guard<std::mutex> lock(statesMutex);
  states.erase(ctx);
}
