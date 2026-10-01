#include "wasm.h"
#include "wasm_c_api_internal.h"
#include "wasm_export.h"
#include "wasm_runtime.h"

bool dimina_wamr_grow(wasm_memory_t *memory, uint32_t delta) {
  return memory && memory->memory_idx_rt == 0 && memory->inst_comm_rt &&
         wasm_runtime_enlarge_memory((wasm_module_inst_t)memory->inst_comm_rt,
                                     delta);
}
uint32_t dimina_wamr_func_index(const wasm_func_t *function) {
  return function->func_idx_rt;
}
wasm_func_t *dimina_wamr_func_at(wasm_instance_t *instance, uint32_t index) {
  if (index > UINT16_MAX || !instance || !instance->inst_comm_rt ||
      instance->inst_comm_rt->module_type != Wasm_Module_Bytecode ||
      index >=
          ((WASMModuleInstance *)instance->inst_comm_rt)->e->function_count)
    return NULL;
  return wasm_func_new_internal(instance->store, (uint16_t)index,
                                instance->inst_comm_rt);
}
int64_t dimina_wamr_table_get(wasm_table_t *table, uint32_t index) {
  wasm_ref_t *ref = wasm_table_get(table, index);
  if (!ref)
    return -1;
  int64_t result = ref->kind == WASM_REF_func ? ref->ref_idx_rt : -1;
  wasm_ref_delete(ref);
  return result;
}
